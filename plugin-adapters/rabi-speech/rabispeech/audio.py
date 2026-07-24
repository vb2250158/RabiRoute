from __future__ import annotations

import asyncio
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from .contracts import SpeechAudioArtifact, TranscriptSegment


MEDIA_TYPES = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "flac": "audio/flac",
    "opus": "audio/ogg",
    "aac": "audio/aac",
    "pcm": "application/octet-stream",
}


class AudioTranscoder:
    def __init__(self, temp_dir: Path, ffmpeg: str = "") -> None:
        self.temp_dir = temp_dir
        self.ffmpeg = ffmpeg or shutil.which("ffmpeg") or ""

    async def prepare(
        self,
        artifact: SpeechAudioArtifact,
        response_format: str,
        sample_rate: int | None = None,
    ) -> SpeechAudioArtifact:
        target_format = response_format.strip().lower() or "wav"
        if target_format not in MEDIA_TYPES:
            raise ValueError(f"Unsupported response_format: {target_format}")
        source_format = artifact.path.suffix.lower().lstrip(".")
        if source_format == target_format and sample_rate is None:
            return artifact
        if source_format == target_format == "wav" and sample_rate is not None:
            source_sample_rate = await asyncio.to_thread(_wav_sample_rate, artifact.path)
            if source_sample_rate == sample_rate:
                return artifact
            output = self._temporary_output(target_format)
            try:
                await asyncio.to_thread(_resample_wav, artifact.path, output, sample_rate)
            except Exception:
                output.unlink(missing_ok=True)
                raise
            return SpeechAudioArtifact(
                path=output,
                media_type=MEDIA_TYPES[target_format],
                provider=artifact.provider,
                model=artifact.model,
                cleanup=True,
            )
        if not self.ffmpeg:
            raise RuntimeError(
                f"ffmpeg is required to convert {source_format or 'audio'} to {target_format}. "
                "Set server.ffmpeg or RABISPEECH_FFMPEG."
            )
        output = self._temporary_output(target_format)
        await asyncio.to_thread(self._convert, artifact.path, output, target_format, sample_rate)
        return SpeechAudioArtifact(
            path=output,
            media_type=MEDIA_TYPES[target_format],
            provider=artifact.provider,
            model=artifact.model,
            cleanup=True,
        )

    def _temporary_output(self, target_format: str) -> Path:
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        suffix = ".pcm" if target_format == "pcm" else f".{target_format}"
        handle = tempfile.NamedTemporaryFile(prefix="rabispeech-tts-", suffix=suffix, dir=self.temp_dir, delete=False)
        output = Path(handle.name)
        handle.close()
        return output

    def _convert(self, source: Path, output: Path, target_format: str, sample_rate: int | None) -> None:
        command = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source)]
        if sample_rate:
            command.extend(["-ar", str(sample_rate)])
        if target_format == "pcm":
            command.extend(["-f", "s16le", "-acodec", "pcm_s16le"])
        command.append(str(output))
        completed = subprocess.run(command, capture_output=True, text=True, timeout=120, check=False)
        if completed.returncode != 0:
            output.unlink(missing_ok=True)
            detail = (completed.stderr or completed.stdout or "ffmpeg failed").strip()[-1000:]
            raise RuntimeError(f"Audio conversion failed: {detail}")


def _wav_sample_rate(path: Path) -> int:
    return int(sf.info(str(path)).samplerate)


def _resample_wav(source: Path, output: Path, target_sample_rate: int) -> None:
    audio, source_sample_rate = sf.read(str(source), dtype="float32", always_2d=True)
    if source_sample_rate <= 0:
        raise RuntimeError("WAV source has no valid sample rate.")
    if source_sample_rate == target_sample_rate:
        shutil.copyfile(source, output)
        return
    target_frames = max(1, int(round(audio.shape[0] * target_sample_rate / source_sample_rate)))
    source_positions = np.arange(audio.shape[0], dtype=np.float64)
    target_positions = np.linspace(0.0, max(0.0, audio.shape[0] - 1.0), target_frames, dtype=np.float64)
    converted = np.column_stack(
        [np.interp(target_positions, source_positions, audio[:, channel]) for channel in range(audio.shape[1])]
    )
    sf.write(
        str(output),
        np.ascontiguousarray(np.clip(converted, -1.0, 1.0), dtype=np.float32),
        int(target_sample_rate),
        subtype="PCM_16",
        format="WAV",
    )


def subtitle_text(segments: list[TranscriptSegment], kind: str) -> str:
    if kind not in {"srt", "vtt"}:
        raise ValueError(f"Unsupported subtitle format: {kind}")
    blocks: list[str] = ["WEBVTT", ""] if kind == "vtt" else []
    for index, segment in enumerate(segments, start=1):
        if kind == "srt":
            blocks.append(str(index))
        blocks.append(f"{_timestamp(segment.start, kind)} --> {_timestamp(segment.end, kind)}")
        blocks.extend([segment.text.strip(), ""])
    return "\n".join(blocks).rstrip() + "\n"


def _timestamp(seconds: float, kind: str) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, millis = divmod(remainder, 1000)
    separator = "." if kind == "vtt" else ","
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}{separator}{millis:03d}"
