from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class SpeechSynthesisRequest:
    text: str
    model: str = "tts-local"
    voice: str = "default"
    response_format: str = "wav"
    speed: float = 1.0
    language: str | None = None
    instructions: str | None = None
    sample_rate: int | None = None


@dataclass(frozen=True)
class SpeechAudioArtifact:
    path: Path
    media_type: str
    provider: str
    model: str
    cleanup: bool = False


@dataclass(frozen=True)
class TranscriptionRequest:
    audio_path: Path
    model: str = "asr-local"
    language: str | None = None
    prompt: str | None = None
    word_timestamps: bool = False


@dataclass(frozen=True)
class TranscriptSegment:
    id: int
    start: float
    end: float
    text: str
    words: list[dict[str, object]] = field(default_factory=list)


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str
    duration: float
    provider: str
    model: str
    segments: list[TranscriptSegment] = field(default_factory=list)


class TtsProvider(Protocol):
    provider_id: str

    async def synthesize(self, request: SpeechSynthesisRequest) -> SpeechAudioArtifact: ...

    def capabilities(self) -> dict[str, object]: ...


class AsrProvider(Protocol):
    provider_id: str

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult: ...

    def capabilities(self) -> dict[str, object]: ...
