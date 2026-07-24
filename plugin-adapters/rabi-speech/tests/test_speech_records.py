from __future__ import annotations

import pytest

from rabispeech.contracts import TranscriptSegment, TranscriptionResult
from rabispeech.speaker_profiles import SpeakerProfileRegistry
from rabispeech.speech_records import SpeechRecordStore


def test_speech_records_persist_and_filter_speakers(tmp_path) -> None:
    store = SpeechRecordStore(tmp_path / "records")
    asr = store.append_asr(
        TranscriptionResult(
            text="你好。收到。",
            language="zh",
            duration=2.5,
            provider="dashscope-qwen",
            model="paraformer-v2",
            segments=[
                TranscriptSegment(id=0, start=0, end=1, text="你好。", speaker="Speaker 1"),
                TranscriptSegment(id=1, start=1, end=2.5, text="收到。", speaker="Speaker 2"),
            ],
        ),
        source="microphone",
        session_id="meeting-one",
        route_id="XinghaiBuilder-main",
    )
    tts = store.append_tts(
        text="会议结论已记录。",
        provider="dashscope-qwen",
        model="qwen3-tts-vc-2026-01-22",
        voice="XinghaiBuilder",
        session_id="meeting-one",
        route_id="XinghaiBuilder-main",
    )

    restored = SpeechRecordStore(tmp_path / "records")
    rows = restored.list(session_id="meeting-one")
    assert [row["kind"] for row in rows] == ["tts", "asr"]
    assert restored.list(kind="asr")[0]["segments"][1]["speaker"] == "Speaker 2"
    assert restored.list(kind="asr")[0]["segments"][1]["speaker_label"] == "Speaker 2"
    assert asr["id"]
    assert tts["id"]


def test_speech_records_emit_change_only_after_append(tmp_path) -> None:
    events: list[tuple[str, object]] = []
    store = SpeechRecordStore(
        tmp_path / "records",
        event_sink=lambda event_type, data: events.append((event_type, data)),
    )

    row = store.append_tts(
        text="事件刷新",
        provider="local",
        model="test",
        voice="default",
        session_id="session-one",
        route_id="route-one",
    )

    assert events == [
        (
            "records_changed",
            {
                "id": row["id"],
                "kind": "tts",
                "time": row["time"],
                "session_id": "session-one",
                "route_id": "route-one",
            },
        )
    ]
    assert "事件刷新" not in str(events)


def test_manual_binding_only_changes_the_selected_record_when_labels_repeat(tmp_path) -> None:
    registry = SpeakerProfileRegistry(tmp_path / "speaker-profiles.json")
    profile = registry.create_profile("秋雨")
    store = SpeechRecordStore(tmp_path / "records", registry)

    def append_phrase(text: str) -> dict[str, object]:
        return store.append_asr(
            TranscriptionResult(
                text=text,
                language="zh",
                duration=1.0,
                provider="dashscope-qwen",
                model="paraformer-v2",
                segments=[TranscriptSegment(id=0, start=0, end=1, text=text, speaker="0")],
            ),
            source="microphone",
            session_id="meeting-one",
        )

    first = append_phrase("第一句。")
    second = append_phrase("第二句。")
    registry.bind("meeting-one", "0", str(profile["id"]), record_id=str(first["id"]))

    rows = {str(row["id"]): row for row in store.list(kind="asr")}
    assert rows[str(first["id"])]["segments"][0]["speaker_name"] == "秋雨"
    assert rows[str(second["id"])]["segments"][0]["speaker_name"] is None


def test_tts_record_only_accepts_safe_relative_audio_paths(tmp_path) -> None:
    store = SpeechRecordStore(tmp_path / "records")
    row = store.append_tts(
        text="已生成。",
        provider="fake",
        model="fake",
        voice="Rabi",
        audio_file=r"nested\speech.wav",
    )
    assert row["audio_file"] == "nested/speech.wav"

    for unsafe in (
        "../escape.wav",
        "/absolute.wav",
        r"C:\absolute.wav",
        r"\\server\share\audio.wav",
        "file:C:/audio.wav",
        "%2e%2e/escape.wav",
        "line\nbreak.wav",
    ):
        with pytest.raises(ValueError, match="safe relative path"):
            store.append_tts(
                text="不应记录。",
                provider="fake",
                model="fake",
                voice="Rabi",
                audio_file=unsafe,
            )


def test_legacy_tts_records_omit_unsafe_audio_paths_without_breaking_list(tmp_path) -> None:
    store = SpeechRecordStore(tmp_path / "records")
    store.append({"id": "safe", "kind": "tts", "time": 1, "audio_file": "output/tts-audio/safe.wav"})
    store.append({"id": "absolute", "kind": "tts", "time": 2, "audio_file": r"C:\private\audio.wav"})
    store.append({"id": "traversal", "kind": "tts", "time": 3, "audio_file": "../escape.wav"})
    store.append({"id": "encoded", "kind": "tts", "time": 4, "audio_file": "%2e%2e/escape.wav"})

    rows = {str(row["id"]): row for row in store.list(kind="tts")}

    assert rows["safe"]["audio_file"] == "output/tts-audio/safe.wav"
    assert "audio_file" not in rows["absolute"]
    assert "audio_file" not in rows["traversal"]
    assert "audio_file" not in rows["encoded"]
