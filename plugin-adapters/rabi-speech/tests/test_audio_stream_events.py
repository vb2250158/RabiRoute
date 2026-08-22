from __future__ import annotations

import json
import threading
from pathlib import Path

from rabispeech.audio_stream_events import AudioStreamEventStore


HOUR = 60 * 60


def _row(
    sequence: int,
    *,
    client_id: str | None = None,
    source_device_id: str | None = None,
    timestamp: float | None = None,
) -> dict[str, object]:
    return {
        "schema_version": 1,
        "id": f"audio-stream-event-{sequence}",
        "sequence": sequence,
        "time": float(sequence if timestamp is None else timestamp),
        "direction": "system",
        "stage": "transport",
        "kind": "event",
        "level": "info",
        "message": f"event-{sequence}",
        "client_id": client_id,
        "source_device_id": source_device_id,
        "device_model": None,
        "bytes": 0,
        "total_bytes": 0,
        "stream_sequence": None,
        "record_id": None,
        "route_id": None,
        "details": {},
    }


def _write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )


def _write_archive(root: Path, first: int, last: int) -> dict[str, object]:
    rows = [_row(sequence) for sequence in range(first, last + 1)]
    file_name = f"{first}~{last}.jsonl"
    _write_jsonl(root / "archive" / file_name, rows)
    return {
        "file": file_name,
        "firstSequence": first,
        "lastSequence": last,
        "count": len(rows),
        "firstTime": rows[0]["time"],
        "lastTime": rows[-1]["time"],
    }


def _write_index(root: Path, entries: list[dict[str, object]]) -> None:
    path = root / "archive" / "index.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"schemaVersion": 1, "archives": entries}),
        encoding="utf-8",
    )


def test_list_reads_current_first_and_stops_before_archives(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "audio-stream-events"
    entries = [_write_archive(root, 1, 100), _write_archive(root, 101, 200)]
    _write_index(root, entries)
    _write_jsonl(root / "current.jsonl", [_row(sequence) for sequence in range(201, 211)])
    store = AudioStreamEventStore(root)
    original_reader = store._read_jsonl_reverse

    def tracked_reader(path: Path, *, block_size: int = 64 * 1024):
        if path.parent == root / "archive":
            raise AssertionError(f"unexpected archive read: {path.name}")
        yield from original_reader(path, block_size=block_size)

    monkeypatch.setattr(store, "_read_jsonl_reverse", tracked_reader)

    assert [row["sequence"] for row in store.list(limit=5)] == [210, 209, 208, 207, 206]


def test_before_sequence_continues_from_current_into_archives(tmp_path: Path) -> None:
    root = tmp_path / "audio-stream-events"
    entries = [_write_archive(root, 1, 4), _write_archive(root, 5, 8)]
    _write_index(root, entries)
    _write_jsonl(root / "current.jsonl", [_row(sequence) for sequence in range(9, 13)])
    store = AudioStreamEventStore(root)

    assert [row["sequence"] for row in store.list(before_sequence=11, limit=6)] == [10, 9, 8, 7, 6, 5]


def test_filters_keep_scanning_until_limit_across_storage_files(tmp_path: Path) -> None:
    root = tmp_path / "audio-stream-events"
    archive_rows = [
        _row(1, client_id="other", source_device_id="phone-one"),
        _row(2, client_id="target", source_device_id="phone-one"),
        _row(3, client_id="target", source_device_id="phone-two"),
        _row(4, client_id="other", source_device_id="phone-two"),
    ]
    _write_jsonl(root / "archive" / "1~4.jsonl", archive_rows)
    _write_index(root, [{
        "file": "1~4.jsonl",
        "firstSequence": 1,
        "lastSequence": 4,
        "count": 4,
        "firstTime": 1.0,
        "lastTime": 4.0,
    }])
    _write_jsonl(root / "current.jsonl", [
        _row(5, client_id="target", source_device_id="phone-one"),
        _row(6, client_id="other", source_device_id="phone-one"),
        _row(7, client_id="target", source_device_id="phone-one"),
        _row(8, client_id="target", source_device_id="phone-two"),
    ])
    store = AudioStreamEventStore(root)

    result = store.list(client_id="target", source_device_id="phone-one", limit=3)

    assert [row["sequence"] for row in result] == [7, 5, 2]


def test_max_sequence_uses_valid_index_without_reading_archive_contents(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "audio-stream-events"
    entries = [_write_archive(root, 1, 4)]
    _write_index(root, entries)
    original_reader = AudioStreamEventStore._read_jsonl

    def guarded_reader(path: Path):
        if path.parent == root / "archive":
            raise AssertionError(f"unexpected archive scan: {path.name}")
        return original_reader(path)

    monkeypatch.setattr(AudioStreamEventStore, "_read_jsonl", staticmethod(guarded_reader))

    store = AudioStreamEventStore(root)
    appended = store.append({"time": 10, "kind": "next", "message": "next"}, archive=False)

    assert appended["sequence"] == 5


def test_corrupt_index_is_rebuilt_before_sequence_initialization(tmp_path: Path) -> None:
    root = tmp_path / "audio-stream-events"
    _write_archive(root, 1, 3)
    index_path = root / "archive" / "index.json"
    index_path.write_text("{broken", encoding="utf-8")

    store = AudioStreamEventStore(root)
    appended = store.append({"time": 10, "kind": "next", "message": "next"}, archive=False)
    rebuilt = json.loads(index_path.read_text(encoding="utf-8"))

    assert appended["sequence"] == 4
    assert rebuilt["archives"] == [{
        "file": "1~3.jsonl",
        "firstSequence": 1,
        "lastSequence": 3,
        "count": 3,
        "firstTime": 1.0,
        "lastTime": 3.0,
    }]


def test_archive_updates_index_with_existing_and_new_ranges(tmp_path: Path) -> None:
    root = tmp_path / "audio-stream-events"
    entries = [_write_archive(root, 1, 2)]
    _write_index(root, entries)
    store = AudioStreamEventStore(root)
    now = 100 * HOUR
    old = store.append({"time": now - 73 * HOUR, "kind": "old", "message": "old"}, archive=False)
    current = store.append({"time": now - HOUR, "kind": "current", "message": "current"}, archive=False)

    result = store.archive_if_due(now=now)
    index = json.loads((root / "archive" / "index.json").read_text(encoding="utf-8"))

    assert result["file"] == "3~3.jsonl"
    assert [(entry["file"], entry["count"]) for entry in index["archives"]] == [
        ("1~2.jsonl", 2),
        ("3~3.jsonl", 1),
    ]
    assert [row["sequence"] for row in store.list(limit=4)] == [current["sequence"], old["sequence"], 2, 1]


def test_list_releases_store_lock_before_scanning_files(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "audio-stream-events"
    entries = [_write_archive(root, 1, 4)]
    _write_index(root, entries)
    _write_jsonl(root / "current.jsonl", [_row(sequence) for sequence in range(5, 9)])
    store = AudioStreamEventStore(root)
    original_reader = store._read_jsonl_reverse
    probed = False

    def tracked_reader(path: Path, *, block_size: int = 64 * 1024):
        nonlocal probed
        if not probed:
            acquired: list[bool] = []

            def probe_lock() -> None:
                locked = store._lock.acquire(timeout=0.5)
                acquired.append(locked)
                if locked:
                    store._lock.release()

            thread = threading.Thread(target=probe_lock)
            thread.start()
            thread.join(timeout=1)
            assert acquired == [True]
            probed = True
        yield from original_reader(path, block_size=block_size)

    monkeypatch.setattr(store, "_read_jsonl_reverse", tracked_reader)

    assert [row["sequence"] for row in store.list(limit=6)] == [8, 7, 6, 5, 4, 3]
    assert probed is True


def test_list_keeps_pre_archive_snapshot_and_releases_current_before_replace(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "audio-stream-events"
    entries = [_write_archive(root, 1, 2)]
    _write_index(root, entries)
    store = AudioStreamEventStore(root)
    now = 100 * HOUR
    old = store.append({"time": now - 73 * HOUR, "kind": "old", "message": "old"}, archive=False)
    current = store.append({"time": now - HOUR, "kind": "current", "message": "current"}, archive=False)

    original_reverse_reader = store._read_jsonl_reverse
    original_reader = store._read_jsonl
    current_reader_open = threading.Event()
    allow_current_read = threading.Event()
    archive_called = threading.Event()
    archive_read_started = threading.Event()
    list_result: list[list[dict[str, object]]] = []
    archive_result: list[dict[str, object]] = []
    failures: list[BaseException] = []

    def blocking_reverse_reader(path: Path, *, block_size: int = 64 * 1024):
        if path == store.current_path:
            current_reader_open.set()
            if not allow_current_read.wait(timeout=2):
                raise AssertionError("timed out waiting to release current snapshot")
        yield from original_reverse_reader(path, block_size=block_size)

    def tracked_reader(path: Path):
        if path == store.current_path:
            archive_read_started.set()
        return original_reader(path)

    monkeypatch.setattr(store, "_read_jsonl_reverse", blocking_reverse_reader)
    monkeypatch.setattr(store, "_read_jsonl", tracked_reader)

    def run_list() -> None:
        try:
            list_result.append(store.list(limit=4))
        except BaseException as error:
            failures.append(error)

    def run_archive() -> None:
        archive_called.set()
        try:
            archive_result.append(store.archive_if_due(now=now))
        except BaseException as error:
            failures.append(error)

    list_thread = threading.Thread(target=run_list)
    list_thread.start()
    assert current_reader_open.wait(timeout=1)

    archive_thread = threading.Thread(target=run_archive)
    archive_thread.start()
    assert archive_called.wait(timeout=1)
    assert archive_read_started.wait(timeout=0.2) is False

    allow_current_read.set()
    list_thread.join(timeout=2)
    archive_thread.join(timeout=2)

    assert list_thread.is_alive() is False
    assert archive_thread.is_alive() is False
    assert failures == []
    assert archive_read_started.is_set() is True
    assert [row["sequence"] for row in list_result[0]] == [current["sequence"], old["sequence"], 2, 1]
    assert archive_result[0]["archived"] is True
    assert [row["sequence"] for row in store.list(limit=4)] == [current["sequence"], old["sequence"], 2, 1]
