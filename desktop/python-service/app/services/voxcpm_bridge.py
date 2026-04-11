from __future__ import annotations

import math
import tempfile
import wave
from pathlib import Path


class VoxCPMBridge:
    """P0 占位桥接层。

    当前阶段先输出一段可播放的占位 WAV 文件，后续再替换为真实的 VoxCPM 推理调用。
    """

    sample_rate = 24_000

    def generate_placeholder_audio(self, task_id: str, target_text: str) -> tuple[str, int, int]:
        output_dir = Path(tempfile.gettempdir()) / "voca" / "outputs"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{task_id}.wav"

        duration_seconds = max(1.0, min(4.0, len(target_text) / 12))
        total_frames = int(self.sample_rate * duration_seconds)
        frequency = 440.0
        amplitude = 0.2

        with wave.open(str(output_path), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(self.sample_rate)

            frames = bytearray()
            for index in range(total_frames):
                sample = amplitude * math.sin((2 * math.pi * frequency * index) / self.sample_rate)
                pcm_value = int(sample * 32767)
                frames.extend(pcm_value.to_bytes(2, byteorder="little", signed=True))
            wav_file.writeframes(frames)

        return str(output_path), self.sample_rate, int(duration_seconds * 1000)
