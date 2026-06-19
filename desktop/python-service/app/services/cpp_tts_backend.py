"""C++ (``llama.cpp-omni``) TTS backend for the Voca sidecar.

This is the lightweight replacement for the PyTorch + Python VoxCPM inference
stack. It drives the native ``voxcpm2-cli`` binary from
https://github.com/tc-mb/llama.cpp-omni (``tools/omni/voxcpm2``) as a
subprocess and returns audio that honors the exact contract the legacy
``VoxCPMBridge`` produced: a 16-bit mono WAV file, its sample rate, and an
estimated duration.

Selection is controlled by ``VOCA_TTS_BACKEND=cpp`` (default ``python``).

Status: **proof-of-concept / opt-in.** The subprocess CLI reloads the GGUF
weights on every call, which is fine for validation and batch use but adds
multi-second latency per request. The production target is the resident
``llama-tts-server`` (OpenAI-compatible ``/v1/audio/speech``) — see
``docs/cpp-backend-migration.md`` §4. The CLI surface used here maps 1:1 to
that server's request fields, so the swap is localized to this module.

Known gaps vs the Python engine (documented, not silently dropped):
  * **Extreme/ultimate clone** (reference-transcript conditioning): implemented
    in the local llama.cpp-omni fork via a new continuation path (the CLI's
    ``--prompt-wav``/``--prompt-text`` flags are now functional — see migration
    doc §6). Requires a patched ``voxcpm2-cli``; an unpatched binary ignores the
    flags and degrades to audio-only reference cloning. Still pending A/B audio
    validation against the Python output once GGUF weights are available.
  * **Denoise**: handled by the caller (``VoxCPMBridge``) via the separate
    ZipEnhancer, unchanged.
"""

from __future__ import annotations

import logging
import os
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

from app.models.schemas import GenerationRequest
from app.services.storage_paths import audio_output_dir
from app.services.text_normalizer import normalize_text

logger = logging.getLogger(__name__)

# Generous ceiling so long utterances on CPU don't get killed mid-synthesis.
_GENERATION_TIMEOUT_SECONDS = 600


class CppBackendError(RuntimeError):
    """Raised when the native backend is misconfigured or fails to generate."""


@dataclass(frozen=True)
class CppGenerationResult:
    audio_path: str
    sample_rate: int
    duration_ms: int


def is_selected() -> bool:
    """Return True when the C++ backend is the configured TTS backend."""

    return os.environ.get("VOCA_TTS_BACKEND", "python").strip().lower() == "cpp"


# When the C++ backend is active, a request for a torch/safetensors model key is
# transparently routed to its GGUF catalog variant, so the same UI selection and
# the same default (``voxcpm2``) keep working without any frontend change.
_GGUF_MODEL_KEY_MAP = {
    "voxcpm2": "voxcpm2_gguf",
}


def resolve_model_key(model_key: str) -> str:
    """Map a model key to its GGUF catalog variant (identity if none exists)."""

    return _GGUF_MODEL_KEY_MAP.get(model_key, model_key)


def _resolve_cli_binary() -> Path:
    """Locate the ``voxcpm2-cli`` executable.

    Resolution order:
      1. ``VOCA_VOXCPM2_CLI`` env var (explicit path)
      2. ``VOCA_BUNDLE_RESOURCE_DIR``/bin/voxcpm2-cli (bundled app)
      3. a sibling ``llama.cpp-omni`` checkout next to the Voca repo (dev)
    """

    explicit = os.environ.get("VOCA_VOXCPM2_CLI", "").strip()
    if explicit:
        candidate = Path(explicit)
        if candidate.is_file():
            return candidate
        raise CppBackendError(f"VOCA_VOXCPM2_CLI points to a missing file: {explicit}")

    candidates: list[Path] = []
    bundle = os.environ.get("VOCA_BUNDLE_RESOURCE_DIR", "").strip()
    if bundle:
        exe = "voxcpm2-cli.exe" if os.name == "nt" else "voxcpm2-cli"
        candidates.append(Path(bundle) / "bin" / exe)

    # Dev fallback: <CodePrograms>/llama.cpp-omni/build/bin/voxcpm2-cli, where
    # CodePrograms is the parent of the Voca repo root (parents[4] = repo root).
    repo_root = Path(__file__).resolve().parents[4]
    exe = "voxcpm2-cli.exe" if os.name == "nt" else "voxcpm2-cli"
    candidates.append(repo_root.parent / "llama.cpp-omni" / "build" / "bin" / exe)

    for candidate in candidates:
        if candidate.is_file():
            return candidate

    raise CppBackendError(
        "Could not locate the voxcpm2-cli binary. Set VOCA_VOXCPM2_CLI to its path, "
        "or build it under llama.cpp-omni/build/bin/voxcpm2-cli."
    )


def _resolve_gguf_models(model_path: str) -> tuple[Path, Path]:
    """Resolve the BaseLM + Acoustic GGUF weights for the model.

    Resolution order:
      1. ``VOCA_VOXCPM2_BASE_GGUF`` / ``VOCA_VOXCPM2_ACOUSTIC_GGUF`` env vars
      2. files matching ``*BaseLM*.gguf`` / ``*Acoustic*.gguf`` in ``model_path``
    """

    base_env = os.environ.get("VOCA_VOXCPM2_BASE_GGUF", "").strip()
    acoustic_env = os.environ.get("VOCA_VOXCPM2_ACOUSTIC_GGUF", "").strip()
    if base_env and acoustic_env:
        base = Path(base_env)
        acoustic = Path(acoustic_env)
        if not base.is_file() or not acoustic.is_file():
            raise CppBackendError(
                "VOCA_VOXCPM2_BASE_GGUF / VOCA_VOXCPM2_ACOUSTIC_GGUF point to missing files."
            )
        return base, acoustic

    model_dir = Path(model_path)
    if not model_dir.is_dir():
        raise CppBackendError(f"Model directory does not exist: {model_path}")

    def _find(pattern: str) -> Path | None:
        matches = sorted(model_dir.glob(pattern))
        return matches[0] if matches else None

    # Prefer the Q8_0 BaseLM (smaller + slightly faster) when both it and the
    # F16 are present in the model dir; fall back to F16, then any BaseLM.
    base = (
        _find("*BaseLM*Q8*.gguf")
        or _find("*BaseLM*.gguf")
        or _find("*base*.gguf")
    )
    acoustic = _find("*Acoustic*.gguf") or _find("*acoustic*.gguf")
    if base is None or acoustic is None:
        raise CppBackendError(
            "Could not find GGUF weights in the model directory. Expected a BaseLM and "
            f"an Acoustic .gguf under {model_path}, or set the VOCA_VOXCPM2_*_GGUF env vars. "
            "GGUF weights are produced by llama.cpp-omni/tools/omni/voxcpm2/convert_voxcpm2_to_gguf.py."
        )
    return base, acoustic


def _build_final_text(payload: GenerationRequest, *, extreme_clone: bool) -> str:
    """Apply control-instruction prefix + normalization, mirroring the bridge.

    Voice design is the native ``(instruction)text`` prefix. Normalization is
    applied here (the C++ backend has no normalizer) only when requested.
    """

    text = (payload.targetText or "").strip()
    if not text:
        raise CppBackendError("target text must be a non-empty string")

    # Voice-design prefix is suppressed in extreme-clone mode, matching the
    # legacy bridge behavior.
    control = "" if extreme_clone else (payload.controlInstruction or "").strip()
    if payload.normalize:
        text = normalize_text(text)
    return f"({control}){text}" if control else text


def _read_wav_meta(path: Path) -> tuple[int, int]:
    """Return (sample_rate, frame_count) from a WAV file header."""

    with wave.open(str(path), "rb") as wav_file:
        return wav_file.getframerate(), wav_file.getnframes()


def generate(
    task_id: str,
    payload: GenerationRequest,
    model_path: str,
) -> CppGenerationResult:
    """Generate audio via the native CLI and return the bridge contract tuple."""

    cli = _resolve_cli_binary()
    base_gguf, acoustic_gguf = _resolve_gguf_models(model_path)

    use_extreme = bool(
        payload.extremeClone
        and payload.referenceAudioPath
        and payload.promptText
        and payload.promptText.strip()
    )
    final_text = _build_final_text(payload, extreme_clone=use_extreme)

    output_dir = audio_output_dir()
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{task_id}.wav"

    args: list[str] = [
        str(cli),
        "-t", final_text,
        "-o", str(output_path),
        "--cfg", str(float(payload.cfgValue or 2.0)),
        "--timesteps", str(int(payload.inferenceTimesteps or 10)),
    ]
    # The CLI treats seed==0 as "do not reseed", so only forward a nonzero seed.
    if payload.seed:
        args += ["--seed", str(int(payload.seed))]
    if os.environ.get("VOCA_VOXCPM2_CPU", "").strip().lower() in {"1", "true", "yes", "on"}:
        args.append("--cpu")

    if payload.referenceAudioPath:
        if use_extreme:
            # Reference-transcript (continuation) cloning. The patched
            # voxcpm2-cli takes the continuation branch when BOTH --prompt-wav
            # and --prompt-text are set (see llama.cpp-omni secondary dev in
            # docs/cpp-backend-migration.md §6). An unpatched binary simply
            # ignores these flags and would need -r, so we keep both for
            # cross-version safety.
            args += [
                "--prompt-wav", payload.referenceAudioPath,
                "--prompt-text", payload.promptText.strip(),
                "-r", payload.referenceAudioPath,
            ]
        else:
            args += ["-r", payload.referenceAudioPath]

    # Positional model args go last, as the CLI expects.
    args += [str(base_gguf), str(acoustic_gguf)]

    logger.info("Running voxcpm2-cli for task %s: %s", task_id, " ".join(args[:1] + args[3:]))
    try:
        completed = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=_GENERATION_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise CppBackendError(
            f"voxcpm2-cli timed out after {_GENERATION_TIMEOUT_SECONDS}s"
        ) from exc
    except OSError as exc:
        raise CppBackendError(f"Failed to launch voxcpm2-cli: {exc}") from exc

    # A patched binary exits 0. An unpatched binary can still abort during
    # Metal teardown (exit 134) *after* the WAV is fully written, so treat a
    # valid output file as success even on a nonzero exit, and only fail when
    # no usable audio was produced.
    if not output_path.is_file():
        tail = (completed.stderr or completed.stdout or "").strip()[-2000:]
        raise CppBackendError(
            f"voxcpm2-cli produced no output (exit {completed.returncode}): {tail}"
        )

    try:
        sample_rate, frame_count = _read_wav_meta(output_path)
    except Exception as exc:
        tail = (completed.stderr or completed.stdout or "").strip()[-2000:]
        raise CppBackendError(
            f"voxcpm2-cli output is not a valid WAV (exit {completed.returncode}): {exc}; {tail}"
        ) from exc

    if completed.returncode != 0:
        logger.warning(
            "voxcpm2-cli exited %s but wrote a valid WAV; accepting. This is the "
            "known Metal teardown abort — rebuild the binary with the residency-set "
            "fix to get a clean exit 0.",
            completed.returncode,
        )

    duration_ms = int((frame_count / sample_rate) * 1000) if sample_rate > 0 else 0
    return CppGenerationResult(
        audio_path=str(output_path),
        sample_rate=sample_rate,
        duration_ms=duration_ms,
    )
