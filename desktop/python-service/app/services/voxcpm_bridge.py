from __future__ import annotations

import os
import sys
import tempfile
import wave
from pathlib import Path
from typing import Any

from app.models.schemas import GenerationRequest, ModelPrepareResponse, ProviderRecommendation
from app.services.model_catalog import get_model_entry, list_model_entries
from app.services.provider_router import recommend_provider


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


class VoxCPMBridge:
    def __init__(self) -> None:
        self._model: Any | None = None
        self._loaded_model_key: str | None = None
        self._loaded_model_path: str | None = None

    def is_model_loaded(self) -> bool:
        return self._model is not None

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
    ) -> ModelPrepareResponse:
        model_entry = get_model_entry(model_key)
        recommendation = self.get_provider_recommendation(provider_preference)
        provider = recommendation.current

        override_path = os.environ.get("VOCA_MODEL_DIR", "").strip() or os.environ.get("VOXCPM_MODEL_DIR", "").strip()
        if override_path and Path(override_path).is_dir():
            config_exists = (Path(override_path) / "config.json").exists()
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
        config_path = local_dir / "config.json"
        if not config_path.exists() and ensure_downloaded:
            local_dir.mkdir(parents=True, exist_ok=True)
            self._download_model(model_key=model_key, provider=provider, local_dir=local_dir)
            config_path = local_dir / "config.json"

        return ModelPrepareResponse(
            modelKey=model_key,
            modelPath=str(local_dir),
            provider=provider,
            existsLocally=local_dir.exists(),
            configExists=config_path.exists(),
            recommendation=recommendation,
        )

    def generate_audio(self, task_id: str, payload: GenerationRequest) -> tuple[str, int, int, str, str]:
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
        audio_path = self._write_waveform(task_id=task_id, sample_rate=sample_rate, waveform=waveform)
        duration_ms = self._estimate_duration_ms(sample_rate=sample_rate, waveform=waveform)
        return audio_path, sample_rate, duration_ms, payload.modelKey, prepared.provider

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
            "denoise": bool(payload.denoise),
        }
        if payload.referenceAudioPath:
            kwargs["reference_wav_path"] = payload.referenceAudioPath
        if payload.promptText and payload.referenceAudioPath:
            kwargs["prompt_wav_path"] = payload.referenceAudioPath
            kwargs["prompt_text"] = payload.promptText.strip()
        return kwargs

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

    def _download_model(self, model_key: str, provider: str, local_dir: Path) -> None:
        model_entry = get_model_entry(model_key)
        if provider == "huggingface":
            provider_info = model_entry.providers["huggingface"]
            if not provider_info.repoId:
                raise RuntimeError("Missing Hugging Face repo configuration")
            from huggingface_hub import snapshot_download  # type: ignore

            snapshot_download(
                repo_id=provider_info.repoId,
                local_dir=str(local_dir),
                local_dir_use_symlinks=False,
            )
            return

        if provider == "modelscope":
            provider_info = model_entry.providers["modelscope"]
            if not provider_info.modelId:
                raise RuntimeError("Missing ModelScope model configuration")
            from modelscope.hub.snapshot_download import snapshot_download as ms_snapshot_download  # type: ignore

            ms_snapshot_download(
                provider_info.modelId,
                local_dir=str(local_dir),
            )
            return

        raise RuntimeError(f"Unsupported provider: {provider}")

    def _write_waveform(self, task_id: str, sample_rate: int, waveform: Any) -> str:
        output_dir = Path(tempfile.gettempdir()) / "voca" / "outputs"
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
