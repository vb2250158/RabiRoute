from __future__ import annotations

import asyncio
import subprocess

import numpy as np
import pytest
import soundfile as sf

from rabispeech.audio import AudioTranscoder
from rabispeech.contracts import SpeechAudioArtifact


def wav_artifact(tmp_path, *, sample_rate: int = 24_000, channels: int = 2) -> SpeechAudioArtifact:
    seconds = 0.25
    time = np.arange(round(sample_rate * seconds), dtype=np.float32) / sample_rate
    mono = np.sin(2 * np.pi * 440 * time).astype(np.float32) * 0.25
    audio = np.column_stack([mono] * channels)
    path = tmp_path / "source.wav"
    sf.write(path, audio, sample_rate, subtype="PCM_16")
    return SpeechAudioArtifact(
        path=path,
        media_type="audio/wav",
        provider="test-provider",
        model="test-model",
        cleanup=False,
    )


def test_wav_sample_rate_conversion_does_not_require_ffmpeg(tmp_path) -> None:
    source = wav_artifact(tmp_path)
    transcoder = AudioTranscoder(tmp_path / "converted", ffmpeg="missing-ffmpeg.exe")

    result = asyncio.run(transcoder.prepare(source, "wav", 16_000))

    info = sf.info(result.path)
    assert info.samplerate == 16_000
    assert info.channels == 2
    assert info.duration == pytest.approx(0.25, abs=1 / 16_000)
    assert result.path != source.path
    assert result.provider == source.provider
    assert result.model == source.model
    assert result.cleanup is True


def test_wav_at_requested_sample_rate_reuses_the_original_artifact(tmp_path) -> None:
    source = wav_artifact(tmp_path, sample_rate=16_000, channels=1)
    transcoder = AudioTranscoder(tmp_path / "converted", ffmpeg="missing-ffmpeg.exe")

    result = asyncio.run(transcoder.prepare(source, "wav", 16_000))

    assert result is source
    assert not (tmp_path / "converted").exists()


def test_cross_format_conversion_still_requires_ffmpeg(tmp_path) -> None:
    source = wav_artifact(tmp_path, channels=1)
    transcoder = AudioTranscoder(tmp_path / "converted", ffmpeg="missing-ffmpeg.exe")
    transcoder.ffmpeg = ""

    with pytest.raises(RuntimeError, match="ffmpeg is required"):
        asyncio.run(transcoder.prepare(source, "mp3"))


def test_cross_format_conversion_hides_ffmpeg_and_preserves_output(tmp_path, monkeypatch) -> None:
    source = wav_artifact(tmp_path, channels=1)
    observed = {}

    def convert(command, **options):
        observed.update(options)
        from pathlib import Path
        Path(command[-1]).write_bytes(b"test-only-mp3")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(subprocess, "run", convert)
    result = asyncio.run(AudioTranscoder(tmp_path / "converted", ffmpeg="ffmpeg.exe").prepare(source, "mp3"))

    assert observed["creationflags"] == getattr(subprocess, "CREATE_NO_WINDOW", 0)
    assert result.path.read_bytes() == b"test-only-mp3"
    assert result.media_type == "audio/mpeg"
    assert result.cleanup is True
