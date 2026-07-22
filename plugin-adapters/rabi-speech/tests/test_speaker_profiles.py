from __future__ import annotations

import json

import pytest

from rabispeech.contracts import TranscriptSegment, TranscriptionResult
from rabispeech.speaker_profiles import (
    SPEAKER_DECISION_MANUAL_SESSION_BINDING,
    SPEAKER_DECISION_UNBOUND_LABEL,
    SpeakerProfileRegistry,
    SpeakerRegistryConflictError,
    SpeakerRegistryNotFoundError,
)


def transcription(label: str = "Speaker 1") -> TranscriptionResult:
    return TranscriptionResult(
        text="会议开始。",
        language="zh",
        duration=1.0,
        provider="meeting-asr",
        model="diarization",
        segments=[TranscriptSegment(id=0, start=0, end=1, text="会议开始。", speaker=label)],
    )


def test_profiles_and_manual_session_bindings_persist_without_enrollment_audio(tmp_path) -> None:
    path = tmp_path / "speaker-profiles.json"
    registry = SpeakerProfileRegistry(path)
    profile = registry.create_profile("秋雨", ["Qiu Yu", "秋雨"])
    assert str(profile["id"]).startswith("speaker-")
    assert profile["aliases"] == ["Qiu Yu"]

    unresolved = registry.resolve_transcription(transcription(), session_id="meeting-one")
    assert unresolved.segments[0].speaker_label == "Speaker 1"
    assert unresolved.segments[0].speaker_id is None
    assert unresolved.segments[0].speaker_decision == SPEAKER_DECISION_UNBOUND_LABEL

    binding = registry.bind("meeting-one", "Speaker 1", str(profile["id"]))
    assert binding["speaker_name"] == "秋雨"
    resolved = registry.resolve_transcription(transcription(), session_id="meeting-one")
    assert resolved.segments[0].speaker == "Speaker 1"
    assert resolved.segments[0].speaker_label == "Speaker 1"
    assert resolved.segments[0].speaker_id == profile["id"]
    assert resolved.segments[0].speaker_name == "秋雨"
    assert resolved.segments[0].speaker_decision == SPEAKER_DECISION_MANUAL_SESSION_BINDING

    restored = SpeakerProfileRegistry(path)
    snapshot = restored.snapshot(session_id="meeting-one")
    assert snapshot["profiles"][0]["id"] == profile["id"]
    assert snapshot["bindings"][0]["speaker_name"] == "秋雨"
    assert snapshot["capability"]["voiceprint"]["supported"] is False
    assert snapshot["capability"]["stores_raw_enrollment_audio"] is False
    serialized = json.dumps(snapshot, ensure_ascii=False).lower()
    assert "audio_path" not in serialized
    persisted = path.read_text(encoding="utf-8").lower()
    assert "audio_path" not in persisted
    assert "embedding" not in persisted


def test_profile_update_rebind_delete_and_archive_are_explicit(tmp_path) -> None:
    path = tmp_path / "speaker-profiles.json"
    registry = SpeakerProfileRegistry(path)
    first = registry.create_profile("秋雨")
    second = registry.create_profile("刘云云")
    updated = registry.update_profile(str(first["id"]), display_name="秋雨（QA）", aliases=["秋雨"], aliases_provided=True)
    assert updated["display_name"] == "秋雨（QA）"

    registry.bind("meeting-one", "Speaker 1", str(first["id"]))
    rebound = registry.bind("meeting-one", "Speaker 1", str(second["id"]))
    assert rebound["speaker_name"] == "刘云云"
    deleted = registry.delete_profile(str(second["id"]))
    assert deleted["removed_bindings"] == 1
    assert registry.resolve("meeting-one", "Speaker 1")["speaker_id"] is None
    assert list((tmp_path / "speaker-profiles-archive").glob("*.json"))

    with pytest.raises(SpeakerRegistryNotFoundError):
        registry.bind("meeting-one", "Speaker 2", "speaker-missing")


def test_record_scoped_resolution_never_falls_back_to_legacy_session_binding(tmp_path) -> None:
    registry = SpeakerProfileRegistry(tmp_path / "speaker-profiles.json")
    profile = registry.create_profile("秋雨")
    registry.bind("meeting-one", "0", str(profile["id"]))

    legacy = registry.resolve("meeting-one", "0")
    assert legacy["speaker_name"] == "秋雨"

    next_record = registry.resolve("meeting-one", "0", record_id="speech-next")
    assert next_record["speaker_id"] is None
    assert next_record["speaker_name"] is None
    assert next_record["speaker_decision"] == SPEAKER_DECISION_UNBOUND_LABEL


def test_agent_identity_command_atomically_creates_reuses_and_binds(tmp_path) -> None:
    path = tmp_path / "speaker-profiles.json"
    registry = SpeakerProfileRegistry(path)

    created = registry.identify_and_bind(
        "meeting-one",
        "Speaker 1",
        display_name="秋雨",
        aliases=["Qiu Yu"],
    )
    assert created["created"] is True
    assert created["reused"] is False
    assert created["binding_changed"] is True
    assert created["matched_by"] == "created"
    assert created["binding"]["speaker_name"] == "秋雨"

    reused = registry.identify_and_bind(
        "meeting-one",
        "Speaker 1",
        display_name="qiu yu",
        aliases=["秋雨老师"],
    )
    assert reused["created"] is False
    assert reused["reused"] is True
    assert reused["profile_updated"] is True
    assert reused["binding_changed"] is False
    assert reused["profile"]["id"] == created["profile"]["id"]
    assert reused["profile"]["aliases"] == ["Qiu Yu", "秋雨老师"]

    unchanged = registry.identify_and_bind(
        "meeting-one",
        "Speaker 1",
        speaker_id=str(created["profile"]["id"]),
    )
    assert unchanged["profile_updated"] is False
    assert unchanged["binding_changed"] is False
    assert SpeakerProfileRegistry(path).snapshot(session_id="meeting-one")["bindings"][0]["speaker_name"] == "秋雨"


def test_agent_identity_command_rejects_ambiguous_aliases_without_explicit_id(tmp_path) -> None:
    registry = SpeakerProfileRegistry(tmp_path / "speaker-profiles.json")
    registry.create_profile("秋雨", ["主持人"])
    registry.create_profile("刘云云", ["主持人"])

    with pytest.raises(SpeakerRegistryConflictError):
        registry.identify_and_bind("meeting-one", "Speaker 1", display_name="主持人")
