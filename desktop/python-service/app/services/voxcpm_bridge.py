from __future__ import annotations

import os
import sys
import threading
import wave
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, Literal

from app.models.schemas import GenerationRequest, ModelPrepareResponse, ProviderRecommendation
from app.services.audio_enhancer import AudioEnhancer
from app.services.bootstrap_assets import is_asset_ready
from app.services.model_catalog import get_model_entry, list_model_entries
from app.services.provider_router import recommend_provider
from app.services.storage_paths import audio_output_dir


def _resolve_voxcpm_src() -> Path:
    explicit_src = os.environ.get("VOCA_VOXCPM_SRC", "").strip()
    if explicit_src:
        candidate = Path(explicit_src)
        if candidate.exists():
            return candidate

    bundle_resource_dir = os.environ.get("VOCA_BUNDLE_RESOURCE_DIR", "").strip()
    if bundle_resource_dir:
        candidate = Path(bundle_resource_dir) / "VoxCPM" / "src"
        if candidate.exists():
            return candidate

    repo_root = Path(__file__).resolve().parents[4]
    return repo_root / "VoxCPM" / "src"


VOXCPM_SRC = _resolve_voxcpm_src()

if VOXCPM_SRC.exists() and str(VOXCPM_SRC) not in sys.path:
    sys.path.insert(0, str(VOXCPM_SRC))


DownloadPhase = Literal["listing", "downloading", "finalizing"]


@dataclass(frozen=True)
class DownloadProgressEvent:
    phase: DownloadPhase
    provider: Literal["huggingface", "modelscope"]
    current_file: str | None = None
    downloaded_bytes: int = 0
    total_bytes: int | None = None
    total_bytes_complete: bool = False
    completed_files: int = 0
    total_files: int | None = None


DownloadProgressCallback = Callable[[DownloadProgressEvent], None]


@dataclass
class _TransferState:
    current_file: str | None
    downloaded_bytes: int = 0
    total_bytes: int | None = None
    completed: bool = False


class _DownloadProgressAggregator:
    def __init__(
        self,
        provider: Literal["huggingface", "modelscope"],
        callback: DownloadProgressCallback | None,
    ) -> None:
        self._provider = provider
        self._callback = callback
        self._lock = threading.Lock()
        self._phase: DownloadPhase = "listing"
        self._current_file: str | None = None
        self._completed_files = 0
        self._total_files: int | None = None
        self._has_explicit_total_files = False
        self._transfers: dict[str, _TransferState] = {}

    def set_phase(self, phase: DownloadPhase, current_file: str | None = None) -> None:
        with self._lock:
            self._phase = phase
            if current_file is not None:
                self._current_file = current_file
            self._emit_unlocked()

    def set_file_counts(self, *, completed_files: int | None = None, total_files: int | None = None) -> None:
        with self._lock:
            if total_files is not None:
                self._has_explicit_total_files = True
                self._total_files = max(total_files, 0)
            self._emit_unlocked()

    def register_transfer(
        self,
        transfer_id: str,
        *,
        current_file: str | None,
        total_bytes: int | None = None,
        initial_bytes: int = 0,
    ) -> None:
        normalized_total = total_bytes if total_bytes and total_bytes > 0 else None
        normalized_initial = max(initial_bytes, 0)
        with self._lock:
            state = self._transfers.get(transfer_id)
            if state is None:
                self._transfers[transfer_id] = _TransferState(
                    current_file=current_file,
                    downloaded_bytes=normalized_initial,
                    total_bytes=normalized_total,
                )
            else:
                state.current_file = current_file
                state.downloaded_bytes = max(state.downloaded_bytes, normalized_initial)
                if normalized_total is not None:
                    state.total_bytes = normalized_total
            self._phase = "downloading"
            self._current_file = current_file
            if self._total_files is None:
                self._total_files = len(self._transfers)
            else:
                self._total_files = max(self._total_files, len(self._transfers))
            self._emit_unlocked()

    def advance_transfer(
        self,
        transfer_id: str,
        *,
        current_file: str | None,
        delta_bytes: int,
    ) -> None:
        normalized_delta = max(delta_bytes, 0)
        with self._lock:
            state = self._transfers.setdefault(
                transfer_id,
                _TransferState(current_file=current_file),
            )
            state.current_file = current_file
            if normalized_delta:
                state.downloaded_bytes += normalized_delta
                if state.total_bytes is not None:
                    state.downloaded_bytes = min(state.downloaded_bytes, state.total_bytes)
            self._phase = "downloading"
            self._current_file = current_file
            self._emit_unlocked()

    def complete_transfer(self, transfer_id: str, *, current_file: str | None) -> None:
        with self._lock:
            state = self._transfers.get(transfer_id)
            if state is None:
                state = _TransferState(current_file=current_file, completed=True)
                self._transfers[transfer_id] = state
            state.current_file = current_file
            if state.total_bytes is not None:
                state.downloaded_bytes = max(state.downloaded_bytes, state.total_bytes)
            if not state.completed:
                state.completed = True
                self._completed_files += 1
            self._phase = "downloading"
            self._current_file = current_file
            if self._total_files is None:
                self._total_files = len(self._transfers)
            self._emit_unlocked()

    def _emit_unlocked(self) -> None:
        if self._callback is None:
            return

        transfers = list(self._transfers.values())
        known_total_states = [state for state in transfers if state.total_bytes is not None]
        total_bytes = sum(int(state.total_bytes or 0) for state in known_total_states) if known_total_states else None
        known_total_files = len(known_total_states)
        transfer_count = len(transfers)
        expected_total_files = self._total_files if self._total_files is not None else transfer_count or None
        total_bytes_complete = (
            expected_total_files is not None
            and expected_total_files > 0
            and known_total_files >= expected_total_files
            and (
                self._has_explicit_total_files
                or self._phase == "finalizing"
                or (self._completed_files >= expected_total_files and transfer_count >= expected_total_files)
            )
        )

        downloaded_bytes = sum(max(state.downloaded_bytes, 0) for state in transfers)

        event = DownloadProgressEvent(
            phase=self._phase,
            provider=self._provider,
            current_file=self._current_file,
            downloaded_bytes=downloaded_bytes,
            total_bytes=total_bytes,
            total_bytes_complete=total_bytes_complete,
            completed_files=self._completed_files,
            total_files=self._total_files,
        )
        self._callback(event)


_HF_PROGRESS_PATCH_LOCK = threading.Lock()


class _HFFileProgressBar:
    def __init__(
        self,
        aggregator: _DownloadProgressAggregator,
        *,
        current_file: str | None,
        total_bytes: int | None,
        initial_bytes: int,
    ) -> None:
        self._aggregator = aggregator
        self._current_file = current_file
        self._transfer_id = f"hf::{current_file}" if current_file else f"hf::{id(self)}"
        self._closed = False
        self._aggregator.register_transfer(
            self._transfer_id,
            current_file=current_file,
            total_bytes=total_bytes,
            initial_bytes=initial_bytes,
        )

    def update(self, value: int = 1) -> None:
        self._aggregator.advance_transfer(
            self._transfer_id,
            current_file=self._current_file,
            delta_bytes=value,
        )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._aggregator.complete_transfer(
            self._transfer_id,
            current_file=self._current_file,
        )


def _make_xet_progress_updater(progress_bar: _HFFileProgressBar, file_size: int | None):
    cumulative_transfer = 0
    last_contributed = 0

    def _callback(*args: Any) -> None:
        nonlocal cumulative_transfer, last_contributed

        if len(args) >= 2 and hasattr(args[0], "total_transfer_bytes_completion_increment"):
            total_update = args[0]
            increment = int(getattr(total_update, "total_transfer_bytes_completion_increment", 0) or 0)
            if increment <= 0:
                return

            cumulative_transfer += increment

            if not file_size or file_size <= 0:
                progress_bar.update(increment)
                return

            transfer_total = int(getattr(total_update, "total_transfer_bytes", 0) or 0)
            if transfer_total <= 0:
                return

            contributed = min(round(cumulative_transfer / transfer_total * file_size), file_size)
            advance = contributed - last_contributed
            if advance > 0:
                last_contributed = contributed
                progress_bar.update(advance)
            return

        if len(args) == 1:
            increment = int(args[0] or 0)
            if increment > 0:
                progress_bar.update(increment)

    return _callback


@contextmanager
def _patched_hf_file_progress(
    aggregator: _DownloadProgressAggregator,
) -> Iterator[None]:
    import huggingface_hub.file_download as hf_file_download  # type: ignore

    original_context = getattr(hf_file_download, "_get_progress_bar_context", None)
    original_xet_get = getattr(hf_file_download, "xet_get", None)
    if original_context is None:
        yield
        return

    def _context_factory(
        *,
        desc: str,
        log_level: int,
        total: int | None = None,
        initial: int = 0,
        unit: str = "B",
        unit_scale: bool = True,
        name: str | None = None,
        tqdm_class: Any | None = None,
        _tqdm_bar: Any | None = None,
        **_: Any,
    ):
        del log_level, unit, unit_scale, name, tqdm_class
        if _tqdm_bar is not None:
            return nullcontext(_tqdm_bar)
        bar = _HFFileProgressBar(
            aggregator,
            current_file=desc,
            total_bytes=total,
            initial_bytes=initial,
        )

        @contextmanager
        def _managed_bar():
            try:
                yield bar
            finally:
                bar.close()

        return _managed_bar()

    def _xet_get_wrapper(
        *,
        incomplete_path: Path,
        xet_file_data: Any,
        headers: dict[str, str],
        expected_size: int | None = None,
        displayed_filename: str | None = None,
        tqdm_class: Any | None = None,
        _tqdm_bar: Any | None = None,
    ) -> None:
        try:
            from hf_xet import PyXetDownloadInfo, download_files  # type: ignore
        except ImportError as exc:
            raise ValueError(
                "To use optimized download using Xet storage, you need to install the hf_xet package. "
                'Try `pip install "huggingface_hub[hf_xet]"` or `pip install hf_xet`.'
            ) from exc

        connection_info = hf_file_download.refresh_xet_connection_info(file_data=xet_file_data, headers=headers)

        def token_refresher() -> tuple[str, int]:
            refreshed_info = hf_file_download.refresh_xet_connection_info(file_data=xet_file_data, headers=headers)
            if refreshed_info is None:
                raise ValueError("Failed to refresh token using xet metadata.")
            return refreshed_info.access_token, refreshed_info.expiration_unix_epoch

        xet_download_info = [
            PyXetDownloadInfo(
                destination_path=str(incomplete_path.absolute()),
                hash=xet_file_data.file_hash,
                file_size=expected_size,
            )
        ]

        resolved_filename = displayed_filename or incomplete_path.name
        if len(resolved_filename) > 40:
            resolved_filename = f"{resolved_filename[:40]}(…)"

        progress_cm = hf_file_download._get_progress_bar_context(
            desc=resolved_filename,
            log_level=hf_file_download.logger.getEffectiveLevel(),
            total=expected_size,
            initial=0,
            name="huggingface_hub.xet_get",
            tqdm_class=tqdm_class,
            _tqdm_bar=_tqdm_bar,
        )

        xet_headers = headers.copy()
        xet_headers.pop("authorization", None)

        with progress_cm as progress:
            download_files(
                xet_download_info,
                endpoint=connection_info.endpoint,
                token_info=(connection_info.access_token, connection_info.expiration_unix_epoch),
                token_refresher=token_refresher,
                progress_updater=[_make_xet_progress_updater(progress, expected_size)],
                request_headers=xet_headers,
            )

    with _HF_PROGRESS_PATCH_LOCK:
        hf_file_download._get_progress_bar_context = _context_factory
        if original_xet_get is not None:
            hf_file_download.xet_get = _xet_get_wrapper
        try:
            yield
        finally:
            hf_file_download._get_progress_bar_context = original_context
            if original_xet_get is not None:
                hf_file_download.xet_get = original_xet_get


def _create_hf_snapshot_tqdm_class(aggregator: _DownloadProgressAggregator):
    from tqdm.auto import tqdm as base_tqdm  # type: ignore

    class HFSnapshotTqdm(base_tqdm):
        def __init__(self, *args, **kwargs):
            total = kwargs.get("total")
            kwargs["disable"] = True
            super().__init__(*args, **kwargs)
            aggregator.set_file_counts(
                total_files=int(total) if isinstance(total, int) else None,
            )

        def update(self, n: int = 1):
            result = super().update(n)
            aggregator.set_file_counts(
                total_files=int(self.total) if isinstance(self.total, int) else None,
            )
            return result

    return HFSnapshotTqdm


def _create_modelscope_progress_callbacks(aggregator: _DownloadProgressAggregator):
    from modelscope.hub.callback import ProgressCallback  # type: ignore

    class ModelScopeProgressCallback(ProgressCallback):
        def __init__(self, filename: str, file_size: int):
            super().__init__(filename, file_size)
            self._transfer_id = f"ms::{id(self)}"
            aggregator.register_transfer(
                self._transfer_id,
                current_file=filename,
                total_bytes=file_size,
                initial_bytes=0,
            )

        def update(self, size: int):
            aggregator.advance_transfer(
                self._transfer_id,
                current_file=self.filename,
                delta_bytes=size,
            )

        def end(self):
            aggregator.complete_transfer(
                self._transfer_id,
                current_file=self.filename,
            )

    return [ModelScopeProgressCallback]


class VoxCPMBridge:
    def __init__(self) -> None:
        self._model: Any | None = None
        self._loaded_model_key: str | None = None
        self._loaded_model_path: str | None = None
        self._enhancer = AudioEnhancer()

    def is_model_loaded(self) -> bool:
        return self._model is not None

    def is_enhancer_loaded(self) -> bool:
        return self._enhancer.is_loaded()

    def list_models(self):
        return list_model_entries()

    def get_provider_recommendation(self, preferred: str = "auto") -> ProviderRecommendation:
        return recommend_provider(preferred=preferred)

    def prepare_model(
        self,
        model_key: str,
        provider_preference: str = "auto",
        *,
        ensure_downloaded: bool = False,
        on_download_progress: DownloadProgressCallback | None = None,
    ) -> ModelPrepareResponse:
        model_entry = get_model_entry(model_key)
        recommendation = self.get_provider_recommendation(provider_preference)
        provider = self._resolve_provider(model_entry, recommendation.current)

        override_path = os.environ.get("VOCA_MODEL_DIR", "").strip() or os.environ.get("VOXCPM_MODEL_DIR", "").strip()
        if model_entry.assetRole == "tts" and override_path and Path(override_path).is_dir():
            config_exists = is_asset_ready(
                model_entry.model_copy(update={"localDir": override_path})
            )
            return ModelPrepareResponse(
                modelKey=model_key,
                modelPath=override_path,
                provider="local",
                existsLocally=True,
                configExists=config_exists,
                recommendation=ProviderRecommendation(
                    publicIp=recommendation.publicIp,
                    location=recommendation.location,
                    preferred=recommendation.preferred,
                    recommended=recommendation.recommended,
                    current="local",
                    reason="manual_override" if provider_preference != "auto" else recommendation.reason,
                    userOverridden=provider_preference != "auto",
                ),
            )

        local_dir = Path(model_entry.localDir)
        asset_ready = is_asset_ready(model_entry)
        if not asset_ready and ensure_downloaded:
            local_dir.mkdir(parents=True, exist_ok=True)
            self._download_model(
                model_key=model_key,
                provider=provider,
                local_dir=local_dir,
                on_download_progress=on_download_progress,
            )
            asset_ready = is_asset_ready(model_entry)

        return ModelPrepareResponse(
            modelKey=model_key,
            modelPath=str(local_dir),
            provider=provider,
            existsLocally=local_dir.exists(),
            configExists=asset_ready,
            recommendation=recommendation,
        )

    def generate_audio(
        self,
        task_id: str,
        payload: GenerationRequest,
    ) -> tuple[str, int, int, str, str, str, str | None, str | None]:
        prepared = self.prepare_model(
            model_key=payload.modelKey,
            provider_preference=payload.providerPreference,
            ensure_downloaded=False,
        )
        if not prepared.configExists:
            raise RuntimeError(
                "Model assets are not ready. Please prepare the model before generating. "
                f"recommended_provider={prepared.recommendation.recommended}, "
                f"model_path={prepared.modelPath}"
            )

        model = self._load_model(model_key=payload.modelKey, model_path=prepared.modelPath)

        final_text = self._build_final_text(payload.targetText, payload.controlInstruction)
        generate_kwargs = self._build_generate_kwargs(payload=payload, final_text=final_text)
        waveform = model.generate(**generate_kwargs)
        sample_rate = int(model.tts_model.sample_rate)
        raw_audio_path = self._write_waveform(task_id=task_id, sample_rate=sample_rate, waveform=waveform)
        audio_path = raw_audio_path
        enhanced_audio_path: str | None = None
        postprocess_message: str | None = None
        if payload.denoise:
            try:
                enhanced_audio_path = self._enhance_generated_audio(
                    input_path=raw_audio_path,
                    output_stem=task_id,
                )
                audio_path = enhanced_audio_path
            except Exception as exc:
                postprocess_message = f"Post-denoise skipped: {exc}"
        duration_ms = self._estimate_duration_ms(sample_rate=sample_rate, waveform=waveform)
        return (
            audio_path,
            sample_rate,
            duration_ms,
            payload.modelKey,
            prepared.provider,
            raw_audio_path,
            enhanced_audio_path,
            postprocess_message,
        )

    def _build_final_text(self, target_text: str, control_instruction: str | None) -> str:
        text = (target_text or "").strip()
        if not text:
            raise ValueError("target text must be a non-empty string")

        control = (control_instruction or "").strip()
        return f"({control}){text}" if control else text

    def _build_generate_kwargs(self, payload: GenerationRequest, final_text: str) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "text": final_text,
            "cfg_value": float(payload.cfgValue or 2.0),
            "inference_timesteps": int(payload.inferenceTimesteps or 10),
            "normalize": bool(payload.normalize),
            # Keep VoxCPM's built-in denoiser off. Desktop now treats denoise as a post-process step.
            "denoise": False,
        }
        if payload.referenceAudioPath:
            kwargs["reference_wav_path"] = payload.referenceAudioPath
        if payload.promptText and payload.referenceAudioPath and payload.promptText.strip():
            kwargs["prompt_wav_path"] = payload.referenceAudioPath
            kwargs["prompt_text"] = payload.promptText.strip()
        return kwargs

    def _resolve_provider(self, model_entry, preferred_provider: str) -> str:
        if preferred_provider in model_entry.providers:
            return preferred_provider
        if model_entry.defaultProvider in model_entry.providers:
            return model_entry.defaultProvider
        return next(iter(model_entry.providers.keys()), preferred_provider)

    def _enhance_generated_audio(self, input_path: str, output_stem: str) -> str:
        prepared = self.prepare_model(
            model_key="zipenhancer_16k",
            provider_preference="modelscope",
            ensure_downloaded=False,
        )
        if not prepared.configExists:
            raise RuntimeError("ZipEnhancer assets are not ready")
        return self._enhancer.enhance_file(
            input_path=input_path,
            model_path=prepared.modelPath,
            output_stem=output_stem,
        )

    def _load_model(self, model_key: str, model_path: str):
        if self._model is not None and self._loaded_model_key == model_key and self._loaded_model_path == model_path:
            return self._model

        try:
            import voxcpm  # type: ignore
        except Exception as exc:  # pragma: no cover - environment-specific dependency issue
            raise RuntimeError(
                "Failed to import local VoxCPM package. "
                "Please install the local dependency into desktop/python-service/.venv first."
            ) from exc

        self._model = voxcpm.VoxCPM(
            voxcpm_model_path=model_path,
            enable_denoiser=False,
            optimize=False,
        )
        self._loaded_model_key = model_key
        self._loaded_model_path = model_path
        return self._model

    def _download_model(
        self,
        model_key: str,
        provider: str,
        local_dir: Path,
        on_download_progress: DownloadProgressCallback | None = None,
    ) -> None:
        model_entry = get_model_entry(model_key)
        if provider == "huggingface":
            provider_info = model_entry.providers.get("huggingface")
            if provider_info is None:
                raise RuntimeError("Hugging Face provider is not configured for this asset")
            if not provider_info.repoId:
                raise RuntimeError("Missing Hugging Face repo configuration")
            from huggingface_hub import snapshot_download  # type: ignore

            aggregator = _DownloadProgressAggregator("huggingface", on_download_progress)
            aggregator.set_phase("listing")
            with _patched_hf_file_progress(aggregator):
                snapshot_download(
                    repo_id=provider_info.repoId,
                    local_dir=str(local_dir),
                    local_dir_use_symlinks=False,
                    tqdm_class=_create_hf_snapshot_tqdm_class(aggregator),
                )
            aggregator.set_phase("finalizing")
            return

        if provider == "modelscope":
            provider_info = model_entry.providers.get("modelscope")
            if provider_info is None:
                raise RuntimeError("ModelScope provider is not configured for this asset")
            if not provider_info.modelId:
                raise RuntimeError("Missing ModelScope model configuration")
            from modelscope.hub.snapshot_download import snapshot_download as ms_snapshot_download  # type: ignore

            aggregator = _DownloadProgressAggregator("modelscope", on_download_progress)
            aggregator.set_phase("listing")
            ms_snapshot_download(
                provider_info.modelId,
                local_dir=str(local_dir),
                progress_callbacks=_create_modelscope_progress_callbacks(aggregator),
            )
            aggregator.set_phase("finalizing")
            return

        raise RuntimeError(f"Unsupported provider: {provider}")

    def _write_waveform(self, task_id: str, sample_rate: int, waveform: Any) -> str:
        output_dir = audio_output_dir()
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{task_id}.wav"

        with wave.open(str(output_path), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)

            frames = bytearray()
            for sample in waveform:
                sample_value = float(sample)
                clamped = max(-1.0, min(1.0, sample_value))
                pcm_value = int(clamped * 32767)
                frames.extend(pcm_value.to_bytes(2, byteorder="little", signed=True))
            wav_file.writeframes(frames)

        return str(output_path)

    def _estimate_duration_ms(self, sample_rate: int, waveform: Any) -> int:
        try:
            length = len(waveform)
        except TypeError:
            length = 0
        if sample_rate <= 0 or length <= 0:
            return 0
        return int((length / sample_rate) * 1000)
