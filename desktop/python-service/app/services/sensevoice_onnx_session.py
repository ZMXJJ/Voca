"""Self-contained ONNX bridge for SenseVoiceSmall.

This module replaces the FunASR/PyTorch runtime for ASR. It implements:
  * WavFrontend: Kaldi fbank (80 bins) + LFR(m=7, n=6) + CMVN from ``am.mvn``
  * ONNX inference via onnxruntime, supporting both fp32 and int8-quantized exports
  * Greedy CTC decoding with SenseVoice token table and special-tag cleanup

The packaged assets under ``model_dir`` must follow the layout exported by
``iic/SenseVoiceSmall-onnx``::

    model_quant.onnx   (or model.onnx)
    am.mvn
    tokens.json
    config.yaml        (informational)
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from threading import Lock
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# SenseVoice language / textnorm id mapping.
# These IDs come from the official export in ``iic/SenseVoiceSmall-onnx`` and
# are referenced through an embedding table inside the ONNX graph.
# ---------------------------------------------------------------------------
LANGUAGE_ID_MAP: dict[str, int] = {
    "auto": 0,
    "zh": 3,
    "en": 4,
    "yue": 7,
    "ja": 11,
    "ko": 12,
    "nospeech": 13,
}

TEXTNORM_ID_MAP: dict[str, int] = {
    "withitn": 14,
    "woitn": 15,
}

# Fbank / LFR / sample-rate constants come from SenseVoice's training config.
DEFAULT_SAMPLE_RATE = 16000
DEFAULT_FBANK_BINS = 80
DEFAULT_LFR_M = 7
DEFAULT_LFR_N = 6

# SenseVoice output carries meta tags such as ``<|zh|>``, ``<|HAPPY|>``,
# ``<|Speech|>``, ``<|withitn|>`` plus optional inline tags. We strip them from
# the final transcript while preserving the detected language.
_TAG_PATTERN = re.compile(r"<\|([^|]+)\|>")
_LANG_TAG_RE = re.compile(r"<\|(zh|en|yue|ja|ko|nospeech|auto)\|>")


def _cuda_required_for_local_inference() -> bool:
    raw = os.environ.get("VOCA_REQUIRE_CUDA", "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return os.name == "nt"


def _default_onnx_providers(ort: Any) -> list[str]:
    if not _cuda_required_for_local_inference():
        return ["CPUExecutionProvider"]

    available = set(ort.get_available_providers())
    if "CUDAExecutionProvider" not in available:
        raise RuntimeError(
            "This build requires CUDA for ASR inference, "
            "but onnxruntime-gpu did not expose CUDAExecutionProvider. "
            "Please check the NVIDIA driver and bundled CUDA dependencies."
        )
    return ["CUDAExecutionProvider"]


# ---------------------------------------------------------------------------
# CMVN (``am.mvn``) parsing.
# ---------------------------------------------------------------------------
class CmvnStats:
    """Global cepstral mean/variance normalisation statistics."""

    def __init__(self, add_shift: np.ndarray, rescale: np.ndarray) -> None:
        if add_shift.shape != rescale.shape:
            raise ValueError(
                f"CMVN shape mismatch: add_shift={add_shift.shape}, "
                f"rescale={rescale.shape}"
            )
        self.add_shift = add_shift.astype(np.float32, copy=False)
        self.rescale = rescale.astype(np.float32, copy=False)

    @property
    def dim(self) -> int:
        return int(self.add_shift.shape[0])

    def apply(self, feats: np.ndarray) -> np.ndarray:
        """Apply ``(feats + add_shift) * rescale`` element-wise per frame."""
        if feats.shape[-1] != self.dim:
            raise ValueError(
                f"Feature dim {feats.shape[-1]} does not match CMVN dim {self.dim}"
            )
        return (feats + self.add_shift) * self.rescale


def _load_cmvn(am_mvn_path: Path) -> CmvnStats:
    """Parse a Kaldi-style ``am.mvn`` file into ``CmvnStats``.

    The file schema used by FunASR looks like::

        <Nnet>
        <Splice> 560 560 [ 0 ] </Splice>
        <AddShift> 560 560 <LearnRateCoef> 0 [ v1 v2 ... ]
        <Rescale> 560 560 <LearnRateCoef> 0 [ v1 v2 ... ]
        </Nnet>
    """

    text = am_mvn_path.read_text(encoding="utf-8", errors="ignore")
    shift_match = re.search(
        r"<AddShift>[^\[]*\[([-+eE0-9.\s]+)\]", text, flags=re.DOTALL
    )
    rescale_match = re.search(
        r"<Rescale>[^\[]*\[([-+eE0-9.\s]+)\]", text, flags=re.DOTALL
    )
    if not shift_match or not rescale_match:
        raise RuntimeError(
            f"Malformed am.mvn, cannot locate <AddShift>/<Rescale> blocks: {am_mvn_path}"
        )

    add_shift = np.fromstring(shift_match.group(1), sep=" ", dtype=np.float32)
    rescale = np.fromstring(rescale_match.group(1), sep=" ", dtype=np.float32)
    return CmvnStats(add_shift=add_shift, rescale=rescale)


# ---------------------------------------------------------------------------
# tokens.json parsing.
# ---------------------------------------------------------------------------
def _load_tokens(tokens_path: Path) -> list[str]:
    """Return an id-indexed list of token strings.

    Supports common FunASR layouts:
      * ``list[str]`` (index is id)
      * ``list[[token, id]]``
      * ``dict[token, id]``
    """

    with tokens_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    pairs: list[tuple[str, int]]
    if isinstance(data, dict):
        pairs = [(str(k), int(v)) for k, v in data.items()]
    elif isinstance(data, list):
        if not data:
            raise RuntimeError(f"Empty tokens.json: {tokens_path}")
        first = data[0]
        if isinstance(first, list):
            pairs = []
            for row in data:
                if not isinstance(row, (list, tuple)) or len(row) < 2:
                    raise RuntimeError(f"Unexpected token row in {tokens_path}: {row!r}")
                pairs.append((str(row[0]), int(row[1])))
        else:
            return [str(item) for item in data]
    else:
        raise RuntimeError(f"Unsupported tokens.json root type: {type(data)!r}")

    pairs.sort(key=lambda item: item[1])
    max_id = pairs[-1][1] if pairs else -1
    vocab = [""] * (max_id + 1)
    for token, token_id in pairs:
        vocab[token_id] = token
    return vocab


# ---------------------------------------------------------------------------
# Feature extraction (fbank + LFR).
# ---------------------------------------------------------------------------
def _compute_fbank(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """Compute 80-dim Kaldi-style log-mel fbank from mono float32 samples.

    ``audio`` is expected in the ``[-1.0, 1.0]`` range. kaldi-native-fbank
    reproduces Kaldi's behaviour which internally assumes samples already
    scaled to int16 range, so we multiply by ``32768`` before feeding it.
    """

    try:
        import kaldi_native_fbank as knf  # type: ignore
    except ImportError as exc:  # pragma: no cover - runtime dependency
        raise RuntimeError(
            "kaldi-native-fbank is required for SenseVoice ONNX inference. "
            "Please install it via `pip install kaldi-native-fbank`."
        ) from exc

    opts = knf.FbankOptions()
    opts.frame_opts.samp_freq = float(sample_rate)
    opts.frame_opts.dither = 0.0
    opts.frame_opts.snip_edges = True
    opts.frame_opts.window_type = "hamming"
    opts.mel_opts.num_bins = DEFAULT_FBANK_BINS
    # low_freq / high_freq defaults (20 / sr*0.5) match FunASR's training.

    extractor = knf.OnlineFbank(opts)
    samples = np.ascontiguousarray(audio, dtype=np.float32) * 32768.0
    extractor.accept_waveform(sample_rate, samples.tolist())
    extractor.input_finished()

    num_frames = extractor.num_frames_ready
    if num_frames <= 0:
        raise RuntimeError("Fbank extraction produced zero frames (audio too short?).")
    frames = np.empty((num_frames, DEFAULT_FBANK_BINS), dtype=np.float32)
    for i in range(num_frames):
        frames[i] = np.asarray(extractor.get_frame(i), dtype=np.float32)
    return frames


def _apply_lfr(feats: np.ndarray, m: int = DEFAULT_LFR_M, n: int = DEFAULT_LFR_N) -> np.ndarray:
    """Stack every ``m`` frames with stride ``n``, pad the tail by repetition."""

    num_frames, dim = feats.shape
    if num_frames <= 0:
        raise ValueError("LFR input has zero frames")

    out_len = (num_frames + n - 1) // n  # ceil(num_frames / n)
    out_len = max(out_len, 1)
    out = np.empty((out_len, m * dim), dtype=np.float32)

    last_frame = feats[-1]
    for i in range(out_len):
        start = i * n
        end = start + m
        if end <= num_frames:
            out[i] = feats[start:end].reshape(-1)
        else:
            tail = feats[start:num_frames]
            if tail.shape[0] == 0:
                tail = last_frame[np.newaxis, :]
            pad_rows = m - tail.shape[0]
            if pad_rows > 0:
                pad = np.tile(last_frame[np.newaxis, :], (pad_rows, 1))
                tail = np.concatenate([tail, pad], axis=0)
            out[i] = tail.reshape(-1)
    return out


# ---------------------------------------------------------------------------
# CTC greedy decoding.
# ---------------------------------------------------------------------------
def _ctc_greedy_decode(
    logits: np.ndarray,
    tokens: list[str],
    blank_id: int = 0,
) -> str:
    """Greedy CTC decoding with repeat collapsing."""

    if logits.ndim != 2:
        raise ValueError(f"Expected 2-D logits (T, V), got shape {logits.shape}")
    ids = np.argmax(logits, axis=-1).tolist()
    pieces: list[str] = []
    prev = -1
    vocab_size = len(tokens)
    for tid in ids:
        if tid == prev:
            continue
        prev = tid
        if tid == blank_id:
            continue
        if 0 <= tid < vocab_size:
            piece = tokens[tid]
            if piece:
                pieces.append(piece)
    return "".join(pieces)


def _cleanup_transcript(raw_text: str) -> tuple[str, str | None]:
    """Strip SenseVoice meta tags, return (clean_text, detected_language)."""

    detected_lang = None
    lang_match = _LANG_TAG_RE.search(raw_text)
    if lang_match:
        detected_lang = lang_match.group(1)
    cleaned = _TAG_PATTERN.sub("", raw_text)
    # FunASR encodes whitespace via the sentencepiece prefix ``▁``.
    cleaned = cleaned.replace("▁", " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned, detected_lang


# ---------------------------------------------------------------------------
# Public session class.
# ---------------------------------------------------------------------------
class SenseVoiceOnnxSession:
    """Thread-safe single-model ONNX session for SenseVoiceSmall."""

    _ONNX_CANDIDATES: tuple[str, ...] = ("model_quant.onnx", "model.onnx")

    def __init__(self, model_dir: str | Path) -> None:
        self._model_dir = Path(model_dir)
        self._lock = Lock()
        self._session: Any = None
        self._input_names: list[str] = []
        self._cmvn: CmvnStats | None = None
        self._tokens: list[str] | None = None
        self._blank_id: int = 0

    # ------------------------------------------------------------------
    def _resolve_onnx_path(self) -> Path:
        for name in self._ONNX_CANDIDATES:
            candidate = self._model_dir / name
            if candidate.exists():
                return candidate
        raise RuntimeError(
            f"SenseVoice ONNX weights not found under {self._model_dir}. "
            f"Expected one of: {', '.join(self._ONNX_CANDIDATES)}."
        )

    def _ensure_loaded(self) -> None:
        if self._session is not None:
            return
        with self._lock:
            if self._session is not None:
                return
            try:
                import onnxruntime as ort  # type: ignore
            except ImportError as exc:  # pragma: no cover - runtime dependency
                raise RuntimeError(
                    "onnxruntime is required for SenseVoice ONNX inference. "
                    "Please install it via `pip install onnxruntime`."
                ) from exc

            onnx_path = self._resolve_onnx_path()
            mvn_path = self._model_dir / "am.mvn"
            tokens_path = self._model_dir / "tokens.json"
            if not mvn_path.exists():
                raise RuntimeError(f"Missing am.mvn under {self._model_dir}")
            if not tokens_path.exists():
                raise RuntimeError(f"Missing tokens.json under {self._model_dir}")

            providers_env = os.environ.get("VOCA_ASR_ONNX_PROVIDERS", "").strip()
            if _cuda_required_for_local_inference():
                providers = _default_onnx_providers(ort)
            elif providers_env:
                providers = [p.strip() for p in providers_env.split(",") if p.strip()]
            else:
                providers = _default_onnx_providers(ort)

            sess_options = ort.SessionOptions()
            sess_options.log_severity_level = 3
            sess_options.intra_op_num_threads = 4
            sess_options.graph_optimization_level = (
                ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            )

            session = ort.InferenceSession(
                str(onnx_path),
                sess_options=sess_options,
                providers=providers,
            )
            cmvn = _load_cmvn(mvn_path)
            tokens = _load_tokens(tokens_path)

            self._session = session
            self._input_names = [item.name for item in session.get_inputs()]
            self._cmvn = cmvn
            self._tokens = tokens
            # SenseVoice always uses id 0 as the CTC blank. ``<blank>`` or
            # ``<pad>`` at index 0 is the norm; nothing to detect.
            self._blank_id = 0

            logger.info(
                "SenseVoice ONNX session ready: model=%s providers=%s "
                "inputs=%s vocab=%d cmvn_dim=%d",
                onnx_path.name,
                providers,
                self._input_names,
                len(tokens),
                cmvn.dim,
            )

    # ------------------------------------------------------------------
    def _build_feeds(
        self,
        speech: np.ndarray,
        speech_lengths: np.ndarray,
        language: np.ndarray,
        textnorm: np.ndarray,
    ) -> dict[str, np.ndarray]:
        feeds: dict[str, np.ndarray] = {}
        for name in self._input_names:
            lower = name.lower()
            if "speech" in lower and "length" not in lower:
                feeds[name] = speech
            elif "feat" in lower and "length" not in lower:
                feeds[name] = speech
            elif "length" in lower:
                feeds[name] = speech_lengths
            elif "language" in lower or lower == "lang" or "lid" in lower:
                feeds[name] = language
            elif "textnorm" in lower or "itn" in lower or "text_norm" in lower:
                feeds[name] = textnorm
            else:
                raise RuntimeError(
                    f"Unknown SenseVoice ONNX input name: {name!r}. "
                    f"Known inputs: {self._input_names}"
                )
        return feeds

    # ------------------------------------------------------------------
    def transcribe(
        self,
        audio: np.ndarray,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        language: str = "auto",
        use_itn: bool = True,
    ) -> tuple[str, str]:
        """Run end-to-end inference, return ``(text, detected_language)``."""

        if audio.ndim != 1:
            audio = np.squeeze(audio)
            if audio.ndim != 1:
                raise ValueError(
                    f"Expected 1-D mono audio, got shape {audio.shape}"
                )
        if sample_rate != DEFAULT_SAMPLE_RATE:
            raise ValueError(
                f"SenseVoice expects {DEFAULT_SAMPLE_RATE} Hz audio, got {sample_rate}"
            )

        self._ensure_loaded()
        assert self._session is not None  # for type checkers
        assert self._cmvn is not None
        assert self._tokens is not None

        lang_key = language if language in LANGUAGE_ID_MAP else "auto"
        lang_id = LANGUAGE_ID_MAP[lang_key]
        tn_id = TEXTNORM_ID_MAP["withitn" if use_itn else "woitn"]

        fbank = _compute_fbank(audio, sample_rate)
        stacked = _apply_lfr(fbank, DEFAULT_LFR_M, DEFAULT_LFR_N)
        normed = self._cmvn.apply(stacked)

        speech = normed[np.newaxis, :, :].astype(np.float32)
        speech_lengths = np.array([speech.shape[1]], dtype=np.int32)
        language_arr = np.array([lang_id], dtype=np.int32)
        textnorm_arr = np.array([tn_id], dtype=np.int32)

        feeds = self._build_feeds(speech, speech_lengths, language_arr, textnorm_arr)
        outputs = self._session.run(None, feeds)
        logits = outputs[0]  # (1, T, V)
        if logits.ndim != 3 or logits.shape[0] != 1:
            raise RuntimeError(
                f"Unexpected ONNX output shape {logits.shape}; expected (1, T, V)"
            )

        raw_text = _ctc_greedy_decode(logits[0], self._tokens, blank_id=self._blank_id)
        cleaned, detected = _cleanup_transcript(raw_text)
        if not cleaned:
            raise RuntimeError("SenseVoice returned an empty transcript")
        return cleaned, detected or lang_key
