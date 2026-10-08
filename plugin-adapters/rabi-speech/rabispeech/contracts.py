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
    speaker_count: int | None = None


@dataclass(frozen=True)
class TranscriptSegment:
    id: int
    start: float
    end: float
    text: str
    words: list[dict[str, object]] = field(default_factory=list)
    speaker: str | None = None
    speaker_label: str | None = None
    speaker_id: str | None = None
    speaker_name: str | None = None
    speaker_decision: str | None = None
    speaker_cluster_id: str | None = None
    voiceprint_id: str | None = None
    speaker_score: float | None = None
    speaker_margin: float | None = None
    speaker_sample_duration: float | None = None
    speaker_model: str | None = None
    speaker_suggestion_id: str | None = None
    speaker_suggestion_name: str | None = None


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str
    duration: float
    provider: str
    model: str
    segments: list[TranscriptSegment] = field(default_factory=list)
    record_id: str | None = None
    emotion: str | None = None
    emotion_labels: list[str] = field(default_factory=list)
    audio_events: list[str] = field(default_factory=list)
    raw_tags: list[str] = field(default_factory=list)
    confidence: float | None = None

    def recognition_metadata(self) -> dict[str, object]:
        """Optional provider observations, separate from transcript text and identity."""
        metadata: dict[str, object] = {}
        if self.emotion is not None:
            metadata["emotion"] = self.emotion
        for name in ("emotion_labels", "audio_events", "raw_tags"):
            values = getattr(self, name)
            if values:
                metadata[name] = list(values)
        if self.confidence is not None:
            metadata["confidence"] = self.confidence
        return metadata


class TtsProvider(Protocol):
    provider_id: str

    async def synthesize(self, request: SpeechSynthesisRequest) -> SpeechAudioArtifact: ...

    def capabilities(self) -> dict[str, object]: ...


class AsrProvider(Protocol):
    provider_id: str

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult: ...

    def capabilities(self) -> dict[str, object]: ...
