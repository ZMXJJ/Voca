"""Resident ``llama-tts-server`` backend for the Voca sidecar.

This is the production TTS path for the C++ (``llama.cpp-omni``) engine. Unlike
the one-shot CLI (:mod:`app.services.cpp_tts_backend`, which reloads the GGUF
weights on every call), the server keeps the model **resident in memory**, so
only the first request pays the load cost — every subsequent generation is fast.

The Voca Python sidecar owns the server's lifecycle: it spawns ``llama-tts-server``
as a child process bound to a private ``127.0.0.1`` port, health-polls it, hot-swaps
the loaded model via ``POST /v1/voxcpm2/init`` when the requested model changes, and
tears it down on sidecar shutdown. Generation goes over ``POST /v1/audio/speech``
(OpenAI-compatible), which returns a 48 kHz mono WAV.

HTTP uses the standard library (``urllib``) on purpose — no new runtime dependency,
which keeps the "installs and just runs on any Mac" guarantee intact.

Known gap (documented, not silently dropped): the server's ``/v1/audio/speech``
currently supports plain generation and **audio-only** reference cloning
(``generate_with_clone``). It does **not** yet implement the continuation /
extreme-clone path (reference-transcript conditioning) — see
``docs/cpp-backend-migration.md`` §6. We still send ``prompt_text`` in the request
for forward-compatibility (an unpatched server ignores unknown JSON keys), so a
patched ``server-voxcpm2.cpp`` lights the feature up with no Python change.
"""

from __future__ import annotations

import atexit
import base64
import collections
import io
import json
import logging
import os
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf

from app.models.schemas import GenerationRequest
from app.services.cpp_tts_backend import (
    CppBackendError,
    CppGenerationResult,
    _build_final_text,
    _read_wav_meta,
    _resolve_gguf_models,
    extreme_clone_requested,
)
from app.services.storage_paths import audio_output_dir

logger = logging.getLogger(__name__)

_SIDECAR_HOST = "127.0.0.1"
# First request loads several GB of GGUF into GPU memory; be generous.
_STARTUP_TIMEOUT_SECONDS = 180
_HEALTH_POLL_INTERVAL = 0.5
_INIT_TIMEOUT_SECONDS = 180
# Matches the CLI ceiling so long utterances don't get cut off mid-synthesis.
_GENERATION_TIMEOUT_SECONDS = 600
_STDERR_RING = 400  # keep the last N log lines for diagnostics


# ── Windows GPU backend selection ────────────────────────────────────────────
# On Windows we ship two server builds (CUDA + Vulkan) side by side and pick one
# per device: an NVIDIA GPU → CUDA, otherwise Vulkan. Override with
# VOCA_VOXCPM2_BACKEND=cuda|vulkan. CPU-only inference is orthogonal
# (VOCA_VOXCPM2_CPU=1 forces 0 GPU layers on whichever build is selected).
_backend_variant_cache: str | None = None


def _detect_nvidia_gpu() -> bool:
    """Torch-free NVIDIA-GPU detection (Windows). Best-effort; never raises."""
    try:
        result = subprocess.run(
            ["nvidia-smi", "-L"], capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0 and "GPU 0" in (result.stdout or ""):
            return True
    except Exception:
        pass
    try:
        result = subprocess.run(
            ["wmic", "path", "win32_VideoController", "get", "name"],
            capture_output=True,
            text=True,
            timeout=8,
        )
        if "nvidia" in (result.stdout or "").lower():
            return True
    except Exception:
        pass
    return False


def windows_backend_variant() -> str:
    """Return the Windows server build variant: ``cuda`` or ``vulkan`` (cached)."""
    global _backend_variant_cache
    if _backend_variant_cache is not None:
        return _backend_variant_cache
    override = os.environ.get("VOCA_VOXCPM2_BACKEND", "").strip().lower()
    variant = override if override in {"cuda", "vulkan"} else (
        "cuda" if _detect_nvidia_gpu() else "vulkan"
    )
    logger.info("Windows TTS backend variant: %s", variant)
    _backend_variant_cache = variant
    return variant


def _resolve_server_binary() -> Path:
    """Locate the ``llama-tts-server`` executable.

    Resolution order mirrors the CLI (``cpp_tts_backend._resolve_cli_binary``):
      1. ``VOCA_LLAMA_TTS_SERVER`` env var (explicit path)
      2. ``VOCA_BUNDLE_RESOURCE_DIR``/bin/llama-tts-server (bundled app)
      3. a sibling ``llama.cpp-omni`` checkout next to the Voca repo (dev)
    """

    exe = "llama-tts-server.exe" if os.name == "nt" else "llama-tts-server"
    # Windows ships per-variant subdirs (bin/cuda, bin/vulkan) so each build's
    # DLLs sit next to its own exe; macOS ships a flat, self-contained bin/.
    variant = windows_backend_variant() if os.name == "nt" else None

    explicit = os.environ.get("VOCA_LLAMA_TTS_SERVER", "").strip()
    if explicit:
        candidate = Path(explicit)
        if candidate.is_file():
            return candidate
        raise CppBackendError(
            f"VOCA_LLAMA_TTS_SERVER points to a missing file: {explicit}"
        )

    candidates: list[Path] = []
    bundle = os.environ.get("VOCA_BUNDLE_RESOURCE_DIR", "").strip()
    if bundle:
        base = Path(bundle) / "bin"
        if variant:
            candidates.append(base / variant / exe)
            # Fall back to the other variant if only one was shipped (e.g. a
            # Vulkan-only build still runs on an NVIDIA machine).
            other = "vulkan" if variant == "cuda" else "cuda"
            candidates.append(base / other / exe)
        else:
            candidates.append(base / exe)

    # Dev fallback: sibling llama.cpp-omni build dirs. On Windows prefer the
    # variant-specific build (build-cuda / build-vulkan); macOS prefers the
    # self-contained static build.
    repo_root = Path(__file__).resolve().parents[4]
    omni = repo_root.parent / "llama.cpp-omni"
    if variant:
        candidates.append(omni / f"build-{variant}" / "bin" / exe)
        other = "vulkan" if variant == "cuda" else "cuda"
        candidates.append(omni / f"build-{other}" / "bin" / exe)
    candidates.append(omni / "build-static" / "bin" / exe)
    candidates.append(omni / "build" / "bin" / exe)

    for candidate in candidates:
        if candidate.is_file():
            return candidate

    raise CppBackendError(
        "Could not locate the llama-tts-server binary. Set VOCA_LLAMA_TTS_SERVER to "
        "its path, or build it under llama.cpp-omni/build*/bin/ "
        "(cmake --build <build-dir> --target llama-tts-server)."
    )


def server_binary_available() -> bool:
    """Return True when the resident server binary can be resolved (never raises)."""

    try:
        _resolve_server_binary()
        return True
    except CppBackendError:
        return False


def _gpu_layer_args() -> list[str]:
    """CLI args controlling GPU offload, honoring the same env knobs as the CLI.

    ``VOCA_VOXCPM2_CPU`` forces CPU (0 layers); ``VOCA_VOXCPM2_N_GPU_LAYERS``
    pins an explicit count; otherwise the server default (-1 = all on GPU) wins.
    """

    if os.environ.get("VOCA_VOXCPM2_CPU", "").strip().lower() in {"1", "true", "yes", "on"}:
        return ["--voxcpm2-n-gpu-layers", "0"]
    explicit = os.environ.get("VOCA_VOXCPM2_N_GPU_LAYERS", "").strip()
    if explicit:
        try:
            return ["--voxcpm2-n-gpu-layers", str(int(explicit))]
        except ValueError:
            logger.warning("Ignoring non-integer VOCA_VOXCPM2_N_GPU_LAYERS=%r", explicit)
    return []


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((_SIDECAR_HOST, 0))
        return int(sock.getsockname()[1])


class _VoxcpmServer:
    """Owns a single resident ``llama-tts-server`` child process.

    Thread-safe: the task manager runs generation jobs on background threads.
    The lock is held across the whole ``generate`` so model hot-swaps can never
    race an in-flight request — fine for a single-user desktop app, where
    generations are naturally sequential.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._proc: subprocess.Popen | None = None
        self._port: int | None = None
        self._loaded: tuple[str, str] | None = None  # (base_gguf, acoustic_gguf)
        self._stderr: collections.deque[str] = collections.deque(maxlen=_STDERR_RING)
        self._drain_thread: threading.Thread | None = None

    # ── process lifecycle ────────────────────────────────────────────────

    def _is_alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _base_url(self) -> str:
        return f"http://{_SIDECAR_HOST}:{self._port}"

    def _drain_output(self, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            self._stderr.append(line)
            logger.debug("llama-tts-server: %s", line)

    def _stderr_tail(self) -> str:
        return "\n".join(self._stderr)[-2000:]

    def _spawn(self, base_gguf: str, acoustic_gguf: str) -> None:
        binary = _resolve_server_binary()
        port = _pick_free_port()
        args = [
            str(binary),
            "--voxcpm2-base-lm", base_gguf,
            "--voxcpm2-acoustic", acoustic_gguf,
            "--host", _SIDECAR_HOST,
            "--port", str(port),
            *_gpu_layer_args(),
        ]
        logger.info("Starting llama-tts-server on port %s: %s", port, " ".join(args))
        self._stderr.clear()
        try:
            proc = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            raise CppBackendError(f"Failed to launch llama-tts-server: {exc}") from exc

        self._proc = proc
        self._port = port
        self._drain_thread = threading.Thread(
            target=self._drain_output, args=(proc,), daemon=True
        )
        self._drain_thread.start()

        self._wait_until_ready()
        self._loaded = (base_gguf, acoustic_gguf)
        logger.info("llama-tts-server ready on %s", self._base_url())

    def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + _STARTUP_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if not self._is_alive():
                code = self._proc.returncode if self._proc else "unknown"
                raise CppBackendError(
                    f"llama-tts-server exited during startup (code {code}): "
                    f"{self._stderr_tail()}"
                )
            try:
                with urllib.request.urlopen(
                    f"{self._base_url()}/v1/health", timeout=2
                ) as resp:
                    if resp.status == 200:
                        return
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(_HEALTH_POLL_INTERVAL)

        self.shutdown()
        raise CppBackendError(
            f"llama-tts-server did not become healthy within {_STARTUP_TIMEOUT_SECONDS}s: "
            f"{self._stderr_tail()}"
        )

    def _hot_swap(self, base_gguf: str, acoustic_gguf: str) -> None:
        payload = json.dumps({
            "base_lm": base_gguf,
            "acoustic": acoustic_gguf,
            "n_gpu_layers": self._init_gpu_layers(),
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{self._base_url()}/v1/voxcpm2/init",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        logger.info("Hot-swapping resident model -> %s", Path(base_gguf).name)
        try:
            with urllib.request.urlopen(req, timeout=_INIT_TIMEOUT_SECONDS) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise CppBackendError(f"Model hot-swap failed (HTTP {exc.code}): {detail}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise CppBackendError(f"Model hot-swap request failed: {exc}") from exc
        if not body.get("success"):
            raise CppBackendError(f"Model hot-swap rejected: {body}")
        self._loaded = (base_gguf, acoustic_gguf)

    @staticmethod
    def _init_gpu_layers() -> int:
        args = _gpu_layer_args()
        return int(args[1]) if args else -1

    def _ensure(self, base_gguf: str, acoustic_gguf: str) -> None:
        target = (base_gguf, acoustic_gguf)
        if self._is_alive() and self._loaded == target:
            return
        if self._is_alive():
            self._hot_swap(base_gguf, acoustic_gguf)
            return
        # Not running (never started, or died) — (re)spawn from scratch.
        self._teardown_process()
        self._spawn(base_gguf, acoustic_gguf)

    # ── generation ───────────────────────────────────────────────────────

    def generate(
        self, task_id: str, payload: GenerationRequest, model_path: str
    ) -> CppGenerationResult:
        base_path, acoustic_path = _resolve_gguf_models(model_path)
        base_gguf, acoustic_gguf = str(base_path), str(acoustic_path)
        use_extreme = extreme_clone_requested(payload)
        final_text = _build_final_text(payload, extreme_clone=use_extreme)

        body: dict = {
            "input": final_text,
            "model": "voxcpm2",
            "response_format": "wav",
            "cfg_value": float(payload.cfgValue or 2.0),
            "inference_timesteps": int(payload.inferenceTimesteps or 10),
        }
        # The server treats seed==0 as "do not reseed", so only forward nonzero.
        if payload.seed:
            body["seed"] = int(payload.seed)
        if payload.referenceAudioPath:
            body["reference_audio"] = _encode_reference_wav_b64(payload.referenceAudioPath)
            if use_extreme:
                # Forward-compat: a patched server-voxcpm2.cpp will consume this
                # for continuation (extreme) cloning; the current server ignores
                # unknown keys and degrades to audio-only reference cloning.
                body["prompt_text"] = payload.promptText.strip()

        output_dir = audio_output_dir()
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{task_id}.wav"

        with self._lock:
            self._ensure(base_gguf, acoustic_gguf)
            if use_extreme:
                logger.info(
                    "Extreme clone requested for task %s; the resident server supports "
                    "reference cloning today (continuation pending server-side §6).",
                    task_id,
                )
            wav_bytes = self._post_speech(body)

        output_path.write_bytes(wav_bytes)
        try:
            sample_rate, frame_count = _read_wav_meta(output_path)
        except Exception as exc:
            raise CppBackendError(
                f"llama-tts-server returned a non-WAV response for task {task_id}: {exc}"
            ) from exc

        duration_ms = int((frame_count / sample_rate) * 1000) if sample_rate > 0 else 0
        return CppGenerationResult(
            audio_path=str(output_path),
            sample_rate=sample_rate,
            duration_ms=duration_ms,
        )

    def _post_speech(self, body: dict) -> bytes:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            f"{self._base_url()}/v1/audio/speech",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=_GENERATION_TIMEOUT_SECONDS) as resp:
                payload = resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[-2000:]
            raise CppBackendError(
                f"llama-tts-server generation failed (HTTP {exc.code}): {detail}"
            ) from exc
        except (urllib.error.URLError, OSError) as exc:
            raise CppBackendError(
                f"llama-tts-server generation request failed: {exc}; {self._stderr_tail()}"
            ) from exc
        if not payload:
            raise CppBackendError(
                f"llama-tts-server returned empty audio: {self._stderr_tail()}"
            )
        return payload

    # ── teardown ─────────────────────────────────────────────────────────

    def _teardown_process(self) -> None:
        proc = self._proc
        self._proc = None
        self._port = None
        self._loaded = None
        if proc is None:
            return
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass

    def shutdown(self) -> None:
        with self._lock:
            if self._proc is not None:
                logger.info("Stopping llama-tts-server")
            self._teardown_process()


_SERVER = _VoxcpmServer()
atexit.register(_SERVER.shutdown)


def _encode_reference_wav_b64(path: str) -> str:
    """Return the reference audio as base64 16-bit PCM mono WAV.

    The server's WAV reader only accepts 16-bit PCM WAV, so we re-encode the
    reference through soundfile (libsndfile) — which reads MP3/FLAC/stereo/float
    and arbitrary sample rates — into a clean PCM_16 mono WAV. The original
    sample rate is preserved in the header so the runtime resamples correctly.
    """
    try:
        audio, sample_rate = sf.read(path, dtype="float32", always_2d=False)
    except Exception as exc:
        raise CppBackendError(f"Could not read reference audio: {path} ({exc})") from exc
    if getattr(audio, "ndim", 1) > 1:
        audio = audio.mean(axis=1)
    buf = io.BytesIO()
    sf.write(buf, np.ascontiguousarray(audio), int(sample_rate), format="WAV", subtype="PCM_16")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def generate(
    task_id: str, payload: GenerationRequest, model_path: str
) -> CppGenerationResult:
    """Generate audio via the resident llama-tts-server."""

    return _SERVER.generate(task_id, payload, model_path)


def shutdown_server() -> None:
    """Stop the resident server child (idempotent). Called on sidecar shutdown."""

    _SERVER.shutdown()
