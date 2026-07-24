from __future__ import annotations

import hashlib
import json
from collections import deque
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from rabispeech.config import SpeakerRecognitionSettings
from rabispeech.contracts import TranscriptSegment, TranscriptionResult
from rabispeech.speaker_recognition import OnnxRuntimeSpeakerEmbeddingExtractor, SpeakerRecognitionService


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
    tmp_path.mkdir(parents=True, exist_ok=True)
    model = tmp_path / "speaker.onnx"
    model.write_bytes(b"fake")
    report = tmp_path / "speaker-validation.json"
    if validated:
        report.write_text(json.dumps({
            "schema_version": 1,
            "dataset_kind": "real_person_private",
            "formal_validation_eligible": True,
            "dataset_manifest_sha256": "1" * 64,
            "validation": {"passed": True, "policy_sha256": "2" * 64},
            "results": [{
                "engine": "fake-speaker-model",
                "model_sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
                "threshold": 0.72,
                "margin": min_margin,
                "validation": {"passed": True, "checks": []},
            }],
        }), encoding="utf-8")
    return SpeakerRecognitionSettings(
        enabled=True,
        validated=validated,
        validation_report_path=report if validated else None,
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


def test_installed_official_speaker_model_runs_through_onnxruntime_fallback(tmp_path: Path) -> None:
    model = Path(__file__).resolve().parents[4] / "models" / "rabispeech" / "speaker" / "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx"
    if not model.is_file():
        pytest.skip("The optional local speaker model is not installed.")
    configured = replace(settings(tmp_path), model_path=model, model_id="3dspeaker-eres2netv2-zh-16k")
    extractor = OnnxRuntimeSpeakerEmbeddingExtractor(configured)
    sample_rate = 16_000
    time = np.arange(sample_rate * 2, dtype=np.float32) / sample_rate
    samples = (0.15 * np.sin(2 * np.pi * 220 * time) + 0.05 * np.sin(2 * np.pi * 440 * time)).astype(np.float32)

    embedding = extractor.compute(samples, sample_rate)

    assert embedding.shape == (192,)
    assert np.isfinite(embedding).all()
    assert float(np.linalg.norm(embedding)) > 0

    first_audio = tmp_path / "real-model-first.wav"
    second_audio = tmp_path / "real-model-second.wav"
    sf.write(first_audio, samples, sample_rate)
    sf.write(second_audio, samples, sample_rate)
    service = SpeakerRecognitionService(
        configured,
        tmp_path / "real-speaker-embeddings.json",
        extractor=extractor,
    )
    first = service.analyze(first_audio, transcription(), record_id="real-one", session_id="day-one", profile_names={})
    second = service.analyze(second_audio, transcription(), record_id="real-two", session_id="day-one", profile_names={})

    assert first.segments[0].speaker_decision == "voiceprint_unknown_cluster"
    assert first.segments[0].speaker_cluster_id == second.segments[0].speaker_cluster_id


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
    assert first.segments[0].voiceprint_id == first.segments[0].speaker_cluster_id
    assert second.segments[0].voiceprint_id == second.segments[0].speaker_cluster_id
    assert len(service.public_clusters()) == 1


def test_repeated_provider_label_is_voiceprinted_per_turn_instead_of_concatenated(tmp_path) -> None:
    service = SpeakerRecognitionService(
        settings(tmp_path),
        tmp_path / "speaker-embeddings.json",
        extractor=FakeExtractor(
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
        ),
    )
    result = service.analyze(
        wav(tmp_path, "provider-merged-label.wav", duration=6.0),
        TranscriptionResult(
            text="三段声音",
            language="zh",
            duration=6.0,
            provider="meeting-asr",
            model="diarization",
            segments=[
                TranscriptSegment(id=0, start=0.0, end=2.0, text="第一段", speaker="0"),
                TranscriptSegment(id=1, start=2.0, end=4.0, text="第二段", speaker="1"),
                TranscriptSegment(id=2, start=4.0, end=6.0, text="第三段", speaker="0"),
            ],
        ),
        record_id="provider-merged-label",
        session_id="meeting",
        profile_names={},
    )

    assert [segment.speaker for segment in result.segments] == ["0", "1", "0"]
    assert [segment.speaker_label for segment in result.segments] == ["0#turn-1", "1", "0#turn-2"]
    assert len({segment.voiceprint_id for segment in result.segments}) == 3
    assert {segment.speaker_sample_duration for segment in result.segments} == {2.0}


def test_repeated_provider_label_turns_can_still_converge_to_one_voiceprint(tmp_path) -> None:
    service = SpeakerRecognitionService(
        settings(tmp_path),
        tmp_path / "speaker-embeddings.json",
        extractor=FakeExtractor(
            [1, 0, 0],
            [0.99, 0.01, 0],
            [0, 1, 0],
        ),
    )
    result = service.analyze(
        wav(tmp_path, "provider-correct-label.wav", duration=6.0),
        TranscriptionResult(
            text="三段声音",
            language="zh",
            duration=6.0,
            provider="meeting-asr",
            model="diarization",
            segments=[
                TranscriptSegment(id=0, start=0.0, end=2.0, text="第一段", speaker="0"),
                TranscriptSegment(id=1, start=2.0, end=4.0, text="第二段", speaker="1"),
                TranscriptSegment(id=2, start=4.0, end=6.0, text="第三段", speaker="0"),
            ],
        ),
        record_id="provider-correct-label",
        session_id="meeting",
        profile_names={},
    )

    assert result.segments[0].voiceprint_id == result.segments[2].voiceprint_id
    assert result.segments[1].voiceprint_id != result.segments[0].voiceprint_id


def test_unknown_voiceprint_cluster_survives_service_restart(tmp_path) -> None:
    store = tmp_path / "speaker-embeddings.json"
    first_service = SpeakerRecognitionService(
        settings(tmp_path),
        store,
        extractor=FakeExtractor([1, 0, 0]),
    )
    first = first_service.analyze(
        wav(tmp_path, "before-restart.wav"),
        transcription(),
        record_id="before-restart",
        session_id="day-long-session",
        profile_names={},
    )

    restarted_service = SpeakerRecognitionService(
        settings(tmp_path),
        store,
        extractor=FakeExtractor([0.99, 0.01, 0]),
    )
    after = restarted_service.analyze(
        wav(tmp_path, "after-restart.wav"),
        transcription(),
        record_id="after-restart",
        session_id="day-long-session",
        profile_names={},
    )

    assert first.segments[0].speaker_cluster_id == after.segments[0].speaker_cluster_id
    assert first.segments[0].voiceprint_id == after.segments[0].voiceprint_id
    assert len(restarted_service.public_clusters()) == 1


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
    assert validated.segments[0].voiceprint_id == validated.segments[0].speaker_cluster_id
    assert validated.segments[0].voiceprint_id != validated.segments[0].speaker_id


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


def test_validated_mode_fails_closed_when_report_does_not_match_runtime(tmp_path) -> None:
    configured = settings(tmp_path, validated=True)
    assert configured.validation_report_path is not None
    report = json.loads(configured.validation_report_path.read_text(encoding="utf-8"))
    report["results"][0]["model_sha256"] = "0" * 64
    configured.validation_report_path.write_text(json.dumps(report), encoding="utf-8")
    service = SpeakerRecognitionService(
        configured,
        tmp_path / "speaker-embeddings.json",
        extractor=FakeExtractor([1, 0, 0]),
    )

    capability = service.capability()
    result = service.analyze(
        wav(tmp_path, "mismatched-report.wav"),
        transcription(),
        record_id="mismatched-report",
        session_id="meeting",
        profile_names={},
    )

    assert capability["validated"] is False
    assert capability["validation_requested"] is True
    assert "model hash" in str(capability["reason"])
    assert result.segments[0].speaker_id is None


def test_validated_mode_rejects_synthetic_or_legacy_dataset_reports(tmp_path) -> None:
    for dataset_kind, formal_eligible, expected in [
        ("synthetic_tts", False, "real_person_private"),
        (None, None, "real_person_private"),
    ]:
        configured = settings(tmp_path / str(dataset_kind), validated=True)
        assert configured.validation_report_path is not None
        report = json.loads(configured.validation_report_path.read_text(encoding="utf-8"))
        if dataset_kind is None:
            report.pop("dataset_kind", None)
            report.pop("formal_validation_eligible", None)
        else:
            report["dataset_kind"] = dataset_kind
            report["formal_validation_eligible"] = formal_eligible
        configured.validation_report_path.write_text(json.dumps(report), encoding="utf-8")
        service = SpeakerRecognitionService(
            configured,
            configured.validation_report_path.parent / "speaker-embeddings.json",
            extractor=FakeExtractor([1, 0, 0]),
        )

        capability = service.capability()
        assert capability["validated"] is False
        assert expected in str(capability["reason"])


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


def test_quiet_unknown_speaker_keeps_a_cluster_prototype_during_day_long_pruning(tmp_path) -> None:
    service = SpeakerRecognitionService(
        settings(tmp_path, max_unconfirmed_samples=4),
        tmp_path / "speaker-embeddings.json",
        extractor=FakeExtractor(
            [1, 0, 0],
            [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0],
            [0.99, 0.01, 0],
        ),
    )
    first = service.analyze(
        wav(tmp_path, "quiet-first.wav"),
        transcription(),
        record_id="quiet-first",
        session_id="day",
        profile_names={},
    )
    for index in range(4):
        service.analyze(
            wav(tmp_path, f"talkative-{index}.wav"),
            transcription(),
            record_id=f"talkative-{index}",
            session_id="day",
            profile_names={},
        )
    returned = service.analyze(
        wav(tmp_path, "quiet-returned.wav"),
        transcription(),
        record_id="quiet-returned",
        session_id="day",
        profile_names={},
    )

    assert first.segments[0].speaker_cluster_id == returned.segments[0].speaker_cluster_id
    assert len(service.public_clusters()) == 2


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
