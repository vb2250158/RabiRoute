from __future__ import annotations

import json
from collections import deque
from dataclasses import replace
from pathlib import Path

import numpy as np
import soundfile as sf

from rabispeech.config import SpeakerRecognitionSettings
from rabispeech.contracts import TranscriptSegment, TranscriptionResult
from rabispeech.speaker_recognition import SpeakerRecognitionService


class FakeExtractor:
    dimension = 3

    def __init__(self, *embeddings: list[float]) -> None:
        self.embeddings = deque(np.asarray(value, dtype=np.float32) for value in embeddings)

    def compute(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        assert samples.size > 0
        assert sample_rate == 16000
        return self.embeddings.popleft()


def settings(
    tmp_path: Path,
    *,
    validated: bool = False,
    experimental_auto_assign: bool = False,
    min_margin: float = 0.06,
    max_samples_per_profile: int = 12,
    max_unconfirmed_samples: int = 500,
) -> SpeakerRecognitionSettings:
    model = tmp_path / "speaker.onnx"
    model.write_bytes(b"fake")
    return SpeakerRecognitionSettings(
        enabled=True,
        validated=validated,
        experimental_auto_assign=experimental_auto_assign,
        auto_assign=True,
        model_id="fake-speaker-model",
        model_path=model,
        provider="cpu",
        num_threads=1,
        min_embedding_seconds=0.8,
        hard_accept_seconds=1.5,
        hard_threshold=0.72,
        tentative_threshold=0.64,
        cluster_threshold=0.68,
        min_margin=min_margin,
        max_samples_per_profile=max_samples_per_profile,
        max_unconfirmed_samples=max_unconfirmed_samples,
        min_voiced_rms=0.0,
    )


def transcription(duration: float = 2.0, label: str | None = "0") -> TranscriptionResult:
    return TranscriptionResult(
        text="测试声纹。",
        language="zh",
        duration=duration,
        provider="fake-asr",
        model="fake-asr",
        segments=[TranscriptSegment(id=0, start=0, end=duration, text="测试声纹。", speaker=label)],
    )


def wav(tmp_path: Path, name: str, duration: float = 2.0) -> Path:
    path = tmp_path / name
    sf.write(path, np.zeros(int(16000 * duration), dtype=np.float32), 16000)
    return path


def test_unknown_embeddings_cluster_across_record_scoped_provider_labels(tmp_path) -> None:
    service = SpeakerRecognitionService(
        settings(tmp_path),
        tmp_path / "speaker-embeddings.json",
        extractor=FakeExtractor([1, 0, 0], [0.99, 0.01, 0]),
    )
    first = service.analyze(
        wav(tmp_path, "first.wav"),
        transcription(),
        record_id="record-one",
        session_id="long-session",
        profile_names={},
    )
    second = service.analyze(
        wav(tmp_path, "second.wav"),
        transcription(),
        record_id="record-two",
        session_id="long-session",
        profile_names={},
    )

    assert first.segments[0].speaker_id is None
    assert first.segments[0].speaker_decision == "voiceprint_unknown_cluster"
    assert first.segments[0].speaker_cluster_id == second.segments[0].speaker_cluster_id
    assert len(service.public_clusters()) == 1


def test_manual_confirmation_becomes_a_multi_record_prototype_only_after_validation(tmp_path) -> None:
    store = tmp_path / "speaker-embeddings.json"
    first_service = SpeakerRecognitionService(
        settings(tmp_path),
        store,
        extractor=FakeExtractor([1, 0, 0]),
    )
    first_service.analyze(
        wav(tmp_path, "enroll.wav"),
        transcription(),
        record_id="record-enroll",
        session_id="meeting",
        profile_names={"speaker-a": "秋雨"},
    )
    assert first_service.confirm("record-enroll", "0", "speaker-a") is True

    unvalidated = SpeakerRecognitionService(
        settings(tmp_path, validated=False),
        store,
        extractor=FakeExtractor([1, 0, 0]),
    ).analyze(
        wav(tmp_path, "unvalidated.wav"),
        transcription(),
        record_id="record-unvalidated",
        session_id="meeting",
        profile_names={"speaker-a": "秋雨"},
    )
    assert unvalidated.segments[0].speaker_id is None
    assert unvalidated.segments[0].speaker_suggestion_id == "speaker-a"
    assert unvalidated.segments[0].speaker_decision == "voiceprint_tentative_known"

    validated = SpeakerRecognitionService(
        settings(tmp_path, validated=True),
        store,
        extractor=FakeExtractor([1, 0, 0]),
    ).analyze(
        wav(tmp_path, "validated.wav"),
        transcription(),
        record_id="record-validated",
        session_id="meeting",
        profile_names={"speaker-a": "秋雨"},
    )
    assert validated.segments[0].speaker_id == "speaker-a"
    assert validated.segments[0].speaker_name == "秋雨"
    assert validated.segments[0].speaker_decision == "voiceprint_auto_match"


def test_best_second_margin_keeps_ambiguous_voice_unknown(tmp_path) -> None:
    store = tmp_path / "speaker-embeddings.json"
    enrollment = SpeakerRecognitionService(
        settings(tmp_path, validated=True, min_margin=0.1),
        store,
        extractor=FakeExtractor([1, 0, 0], [0.98, 0.2, 0]),
    )
    for record_id, speaker_id, filename in (
        ("a", "speaker-a", "a.wav"),
        ("b", "speaker-b", "b.wav"),
    ):
        enrollment.analyze(
            wav(tmp_path, filename),
            transcription(),
            record_id=record_id,
            session_id="meeting",
            profile_names={speaker_id: speaker_id},
        )
        enrollment.confirm(record_id, "0", speaker_id)

    result = SpeakerRecognitionService(
        settings(tmp_path, validated=True, min_margin=0.1),
        store,
        extractor=FakeExtractor([0.995, 0.1, 0]),
    ).analyze(
        wav(tmp_path, "ambiguous.wav"),
        transcription(),
        record_id="ambiguous",
        session_id="meeting",
        profile_names={"speaker-a": "A", "speaker-b": "B"},
    )
    assert result.segments[0].speaker_id is None
    assert result.segments[0].speaker_suggestion_id in {"speaker-a", "speaker-b"}
    assert result.segments[0].speaker_margin is not None
    assert result.segments[0].speaker_margin < 0.1


def test_explicit_experimental_mode_can_auto_assign_without_claiming_validation(tmp_path) -> None:
    store = tmp_path / "speaker-embeddings.json"
    enrollment = SpeakerRecognitionService(
        settings(tmp_path),
        store,
        extractor=FakeExtractor([1, 0, 0]),
    )
    enrollment.analyze(
        wav(tmp_path, "experimental-enroll.wav"),
        transcription(),
        record_id="experimental-enroll",
        session_id="meeting",
        profile_names={"speaker-a": "秋雨"},
    )
    assert enrollment.confirm("experimental-enroll", "0", "speaker-a") is True

    service = SpeakerRecognitionService(
        settings(tmp_path, experimental_auto_assign=True),
        store,
        extractor=FakeExtractor([1, 0, 0]),
    )
    capability = service.capability()
    result = service.analyze(
        wav(tmp_path, "experimental-match.wav"),
        transcription(),
        record_id="experimental-match",
        session_id="meeting",
        profile_names={"speaker-a": "秋雨"},
    )

    assert capability["supported"] is False
    assert capability["validated"] is False
    assert capability["experimental_auto_assign"] is True
    assert capability["auto_assign"] is True
    assert result.segments[0].speaker_id == "speaker-a"
    assert result.segments[0].speaker_decision == "voiceprint_experimental_auto_match"
    assert service.public_clusters() == []


def test_short_audio_never_enters_the_embedding_store(tmp_path) -> None:
    service = SpeakerRecognitionService(
        settings(tmp_path),
        tmp_path / "speaker-embeddings.json",
        extractor=FakeExtractor([1, 0, 0]),
    )
    result = service.analyze(
        wav(tmp_path, "short.wav", duration=0.5),
        transcription(duration=0.5, label=None),
        record_id="short",
        session_id="meeting",
        profile_names={},
    )
    assert result.segments[0].speaker_label == "voice"
    assert result.segments[0].speaker_decision == "voiceprint_too_short"
    assert service.public_clusters() == []


def test_incompatible_native_model_is_reported_without_loading_it_in_process(tmp_path) -> None:
    service = SpeakerRecognitionService(
        settings(tmp_path),
        tmp_path / "speaker-embeddings.json",
        model_probe=lambda _settings: "probe process exited with an access violation",
    )

    capability = service.capability()
    assert service.ready is False
    assert capability["available"] is False
    assert "access violation" in str(capability["reason"])


def test_confirmed_and_unconfirmed_samples_are_pruned_to_configured_limits(tmp_path) -> None:
    store = tmp_path / "speaker-embeddings.json"
    service = SpeakerRecognitionService(
        settings(tmp_path, max_samples_per_profile=2, max_unconfirmed_samples=2),
        store,
        extractor=FakeExtractor(*([[1, 0, 0]] * 6)),
    )
    for index in range(3):
        record_id = f"confirmed-{index}"
        service.analyze(
            wav(tmp_path, f"confirmed-{index}.wav"),
            transcription(),
            record_id=record_id,
            session_id="meeting",
            profile_names={"speaker-a": "A"},
        )
        service.confirm(record_id, "0", "speaker-a")
    for index in range(3):
        service.analyze(
            wav(tmp_path, f"unknown-{index}.wav"),
            transcription(),
            record_id=f"unknown-{index}",
            session_id="meeting",
            profile_names={"speaker-a": "A"},
        )

    samples = json.loads(store.read_text(encoding="utf-8"))["samples"]
    assert len([item for item in samples if item.get("confirmed_speaker_id") == "speaker-a"]) == 2
    assert len([item for item in samples if not item.get("confirmed_speaker_id")]) == 2


def test_cross_speaker_overlap_is_not_used_as_a_voiceprint_sample(tmp_path) -> None:
    service = SpeakerRecognitionService(
        settings(tmp_path),
        tmp_path / "speaker-embeddings.json",
        extractor=FakeExtractor(),
    )
    result = service.analyze(
        wav(tmp_path, "overlap.wav"),
        TranscriptionResult(
            text="重叠说话",
            language="zh",
            duration=2.0,
            provider="meeting-asr",
            model="diarization",
            segments=[
                TranscriptSegment(id=0, start=0.0, end=1.2, text="第一位", speaker="0"),
                TranscriptSegment(id=1, start=1.0, end=2.0, text="第二位", speaker="1"),
            ],
        ),
        record_id="overlap",
        session_id="meeting",
        profile_names={},
    )

    assert {segment.speaker_decision for segment in result.segments} == {"voiceprint_overlapping_speech"}
    assert service.public_clusters() == []
