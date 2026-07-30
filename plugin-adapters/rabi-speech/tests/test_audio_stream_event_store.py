from __future__ import annotations

import json
from pathlib import Path

from rabispeech.audio_stream_events import AudioStreamEventStore


HOUR = 60 * 60


def test_audio_stream_events_survive_restart_and_filter_by_stable_device(tmp_path: Path) -> None:
    root = tmp_path / "audio-stream-events"
    store = AudioStreamEventStore(root)
    first = store.append({
        "time": 1_000,
        "direction": "system",
        "stage": "transport",
        "kind": "client_connected",
        "message": "connected",
        "client_id": "phone-one-audio",
        "source_device_id": "phone-one",
    })
    second = store.append({
        "time": 1_001,
        "direction": "pipeline",
        "stage": "asr",
        "kind": "transcription_empty",
        "message": "empty",
        "client_id": "phone-two-audio",
        "source_device_id": "phone-two",
    })

    reopened = AudioStreamEventStore(root)
    assert [row["id"] for row in reopened.list(limit=10)] == [second["id"], first["id"]]
    assert [row["id"] for row in reopened.list(source_device_id="phone-one", limit=10)] == [first["id"]]
    assert reopened.list(before_sequence=int(second["sequence"]), limit=10)[0]["id"] == first["id"]


def test_audio_stream_event_archive_uses_24_72_dynamic_windows(tmp_path: Path) -> None:
    root = tmp_path / "audio-stream-events"
    store = AudioStreamEventStore(root)
    now = 100 * HOUR
    oldest = store.append({"time": now - 73 * HOUR, "kind": "oldest", "message": "oldest"}, archive=False)
    recent_old = store.append({"time": now - 25 * HOUR, "kind": "recent-old", "message": "recent-old"}, archive=False)
    current = store.append({"time": now - 23 * HOUR, "kind": "current", "message": "current"}, archive=False)

    result = store.archive_if_due(now=now)

    assert result["archived"] is True
    assert result["first_sequence"] == oldest["sequence"]
    assert result["last_sequence"] == recent_old["sequence"]
    assert [row["id"] for row in store.list(limit=10)] == [current["id"], recent_old["id"], oldest["id"]]
    current_rows = [
        json.loads(line)
        for line in (root / "current.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert [row["id"] for row in current_rows] == [current["id"]]
    index = json.loads((root / "archive" / "index.json").read_text(encoding="utf-8"))
    assert index["archives"][0]["file"] == f"{oldest['sequence']}~{recent_old['sequence']}.jsonl"


def test_audio_stream_event_archive_does_not_cross_a_recent_prefix_gap(tmp_path: Path) -> None:
    root = tmp_path / "audio-stream-events"
    store = AudioStreamEventStore(root)
    now = 100 * HOUR
    first = store.append({"time": now - 73 * HOUR, "kind": "old", "message": "old"}, archive=False)
    recent = store.append({"time": now - 1 * HOUR, "kind": "recent", "message": "recent"}, archive=False)
    late_old = store.append({"time": now - 80 * HOUR, "kind": "late-old", "message": "late-old"}, archive=False)

    result = store.archive_if_due(now=now)

    assert result["archived"] is True
    assert result["first_sequence"] == first["sequence"]
    assert result["last_sequence"] == first["sequence"]
    current_ids = [
        json.loads(line)["id"]
        for line in (root / "current.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert current_ids == [recent["id"], late_old["id"]]


def test_audio_stream_event_archive_is_noop_at_exact_trigger_boundary(tmp_path: Path) -> None:
    root = tmp_path / "audio-stream-events"
    store = AudioStreamEventStore(root)
    now = 100 * HOUR
    store.append({"time": now - 72 * HOUR, "kind": "boundary", "message": "boundary"}, archive=False)

    assert store.archive_if_due(now=now)["archived"] is False
    assert not (root / "archive" / "index.json").exists()
