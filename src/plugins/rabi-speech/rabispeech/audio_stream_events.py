from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any


_HOT_WINDOW_SECONDS = 24 * 60 * 60
_TRIGGER_WINDOW_SECONDS = 72 * 60 * 60
_MAX_MESSAGE_LENGTH = 500
_MAX_DETAILS = 100


class AudioStreamEventStore:
    """Durable, append-only transport and speech-pipeline event ledger.

    `current.jsonl` is the hot source. Once an event is strictly older than
    72 hours, the largest contiguous sequence prefix strictly older than
    24 hours is moved unchanged to a deterministic sequence-range archive.
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self.current_path = self.root / "current.jsonl"
        self.archive_dir = self.root / "archive"
        self.index_path = self.archive_dir / "index.json"
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._archive_pending = False
        self._current_readers = 0
        self._sequence = self._max_sequence()
        self._last_archive_check = 0.0

    def append(self, value: dict[str, object], *, archive: bool = True) -> dict[str, object]:
        with self._lock:
            while self._archive_pending:
                self._condition.wait()
            self._sequence += 1
            row = self._normalize(value, self._sequence)
            self.root.mkdir(parents=True, exist_ok=True)
            with self.current_path.open("a", encoding="utf-8", newline="\n") as output:
                output.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
                output.flush()
                try:
                    os.fsync(output.fileno())
                except OSError:
                    pass
            if archive and float(row["time"]) - self._last_archive_check >= 60 * 60:
                self.archive_if_due(now=float(row["time"]))
            return row

    def list(
        self,
        *,
        limit: int = 200,
        client_id: str | None = None,
        source_device_id: str | None = None,
        before_sequence: int | None = None,
    ) -> list[dict[str, object]]:
        maximum = min(1_000, max(1, int(limit)))
        normalized_client = _one_line(client_id)
        normalized_device = _one_line(source_device_id)
        before = int(before_sequence) if before_sequence is not None else None
        with self._lock:
            while self._archive_pending:
                self._condition.wait()
            archive_entries = list(self._archive_entries())
            self._current_readers += 1

        rows: list[dict[str, object]] = []
        seen_sequences: set[int] = set()

        def collect(path: Path) -> bool:
            iterator = self._read_jsonl_reverse(path)
            try:
                for row in iterator:
                    sequence = int(row.get("sequence") or 0)
                    if sequence in seen_sequences:
                        continue
                    seen_sequences.add(sequence)
                    if not self._matches(
                        row,
                        client_id=normalized_client,
                        source_device_id=normalized_device,
                        before_sequence=before,
                    ):
                        continue
                    rows.append(row)
                    if len(rows) >= maximum:
                        return True
                return False
            finally:
                close = getattr(iterator, "close", None)
                if callable(close):
                    close()

        try:
            current_complete = collect(self.current_path)
        finally:
            with self._lock:
                self._current_readers -= 1
                if self._current_readers == 0:
                    self._condition.notify_all()

        if current_complete:
            return rows

        for entry in reversed(archive_entries):
            if before is not None and int(entry["firstSequence"]) >= before:
                continue
            if collect(self.archive_dir / str(entry["file"])):
                break
        return rows

    def archive_if_due(self, *, now: float | None = None) -> dict[str, object]:
        checked_at = time.time() if now is None else float(now)
        with self._lock:
            while self._archive_pending:
                self._condition.wait()
            self._archive_pending = True
            try:
                while self._current_readers > 0:
                    self._condition.wait()
                return self._archive_if_due_locked(checked_at)
            finally:
                self._archive_pending = False
                self._condition.notify_all()

    def _archive_if_due_locked(self, checked_at: float) -> dict[str, object]:
        self._last_archive_check = checked_at
        current = self._read_jsonl(self.current_path)
        if not current or not any(checked_at - float(row.get("time") or checked_at) > _TRIGGER_WINDOW_SECONDS for row in current):
            return {"archived": False, "count": 0}
        hot_cutoff = checked_at - _HOT_WINDOW_SECONDS
        prefix: list[dict[str, object]] = []
        for row in current:
            if float(row.get("time") or checked_at) >= hot_cutoff:
                break
            prefix.append(row)
        if not prefix:
            return {"archived": False, "count": 0}
        first_sequence = int(prefix[0]["sequence"])
        last_sequence = int(prefix[-1]["sequence"])
        archive_name = f"{first_sequence}~{last_sequence}.jsonl"
        archive_path = self.archive_dir / archive_name
        encoded = "".join(
            json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
            for row in prefix
        )
        self.archive_dir.mkdir(parents=True, exist_ok=True)
        if archive_path.exists():
            if archive_path.read_text(encoding="utf-8") != encoded:
                raise RuntimeError(f"Audio stream archive conflicts with existing range: {archive_name}")
        else:
            self._atomic_write(archive_path, encoded)
        index = self._rebuild_index()
        self._atomic_write(
            self.index_path,
            json.dumps(index, ensure_ascii=False, indent=2) + "\n",
        )
        remainder = current[len(prefix):]
        self._atomic_write(
            self.current_path,
            "".join(
                json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
                for row in remainder
            ),
        )
        return {
            "archived": True,
            "count": len(prefix),
            "first_sequence": first_sequence,
            "last_sequence": last_sequence,
            "file": archive_name,
        }
    def _normalize(self, value: dict[str, object], sequence: int) -> dict[str, object]:
        timestamp = _positive_float(value.get("time"), time.time())
        details = value.get("details")
        safe_details = (
            {
                _one_line(key, 100): _safe_detail(item)
                for key, item in list(details.items())[:_MAX_DETAILS]
                if _one_line(key, 100)
            }
            if isinstance(details, dict)
            else {}
        )
        return {
            "schema_version": 1,
            "id": f"audio-stream-event-{sequence}",
            "sequence": sequence,
            "time": timestamp,
            "direction": _direction(value.get("direction")),
            "stage": _one_line(value.get("stage"), 50) or "transport",
            "kind": _one_line(value.get("kind"), 100) or "event",
            "level": _level(value.get("level")),
            "message": _one_line(value.get("message"), _MAX_MESSAGE_LENGTH),
            "client_id": _one_line(value.get("client_id")) or None,
            "source_device_id": _one_line(value.get("source_device_id")) or None,
            "device_model": _one_line(value.get("device_model"), 100) or None,
            "bytes": max(0, int(_positive_float(value.get("bytes"), 0))),
            "total_bytes": max(0, int(_positive_float(value.get("total_bytes"), 0))),
            "stream_sequence": _optional_nonnegative_int(value.get("stream_sequence")),
            "record_id": _one_line(value.get("record_id")) or None,
            "route_id": _one_line(value.get("route_id")) or None,
            "details": safe_details,
        }

    def _archive_entries(self) -> list[dict[str, Any]]:
        entries = self._read_index_entries()
        if entries is not None:
            return entries
        index = self._rebuild_index()
        entries = list(index["archives"])
        if self.index_path.exists() or entries:
            self._atomic_write(
                self.index_path,
                json.dumps(index, ensure_ascii=False, indent=2) + "\n",
            )
        return entries

    def _read_index_entries(self) -> list[dict[str, Any]] | None:
        if not self.index_path.is_file():
            return None
        try:
            value = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return None
        if not isinstance(value, dict) or value.get("schemaVersion") != 1:
            return None
        raw_entries = value.get("archives")
        if not isinstance(raw_entries, list):
            return None

        entries: list[dict[str, Any]] = []
        for raw_entry in raw_entries:
            entry = self._validated_index_entry(raw_entry)
            if entry is None:
                return None
            entries.append(entry)
        entries.sort(key=lambda item: (int(item["firstSequence"]), int(item["lastSequence"])))
        for previous, current in zip(entries, entries[1:]):
            if int(current["firstSequence"]) <= int(previous["lastSequence"]):
                return None

        indexed_files = {str(entry["file"]) for entry in entries}
        archive_files = (
            {path.name for path in self.archive_dir.glob("*~*.jsonl")}
            if self.archive_dir.exists()
            else set()
        )
        if indexed_files != archive_files:
            return None
        return entries

    def _validated_index_entry(self, value: object) -> dict[str, Any] | None:
        if not isinstance(value, dict):
            return None
        file_name = value.get("file")
        if not isinstance(file_name, str) or Path(file_name).name != file_name:
            return None
        try:
            first_text, last_text = Path(file_name).stem.split("~", 1)
            file_first = int(first_text)
            file_last = int(last_text)
            first = int(value["firstSequence"])
            last = int(value["lastSequence"])
            count = int(value["count"])
        except (KeyError, TypeError, ValueError):
            return None
        if (
            first <= 0
            or last < first
            or count != last - first + 1
            or first != file_first
            or last != file_last
        ):
            return None
        if not (self.archive_dir / file_name).is_file():
            return None
        return {
            "file": file_name,
            "firstSequence": first,
            "lastSequence": last,
            "count": count,
            "firstTime": value.get("firstTime"),
            "lastTime": value.get("lastTime"),
        }

    def _scan_archive_entries(self) -> list[dict[str, Any]]:
        if not self.archive_dir.exists():
            return []
        entries: list[dict[str, Any]] = []
        for path in self.archive_dir.glob("*~*.jsonl"):
            try:
                first_text, last_text = path.stem.split("~", 1)
                first = int(first_text)
                last = int(last_text)
            except (TypeError, ValueError):
                continue
            rows = self._read_jsonl(path)
            if not rows:
                continue
            entries.append({
                "file": path.name,
                "firstSequence": first,
                "lastSequence": last,
                "count": len(rows),
                "firstTime": rows[0].get("time"),
                "lastTime": rows[-1].get("time"),
            })
        return sorted(entries, key=lambda item: (int(item["firstSequence"]), int(item["lastSequence"])))

    def _rebuild_index(self) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "recordClass": "ledger",
            "sourceOfTruth": "current.jsonl + archive/*.jsonl",
            "stableId": "id",
            "orderBy": "sequence",
            "activityAt": "time",
            "hotWindowHours": 24,
            "triggerAfterHours": 72,
            "triggerOwner": "event",
            "action": "archive",
            "sourceRetention": "retained",
            "archives": self._scan_archive_entries(),
            "updatedAt": time.time(),
        }

    def _max_sequence(self) -> int:
        entries = self._archive_entries()
        archive_maximum = max((int(entry["lastSequence"]) for entry in entries), default=0)
        current_row = next(self._read_jsonl_reverse(self.current_path), None)
        current_maximum = int(current_row.get("sequence") or 0) if current_row is not None else 0
        return max(archive_maximum, current_maximum)

    @staticmethod
    def _matches(
        row: dict[str, object],
        *,
        client_id: str,
        source_device_id: str,
        before_sequence: int | None,
    ) -> bool:
        return (
            (not client_id or str(row.get("client_id") or "") == client_id)
            and (not source_device_id or str(row.get("source_device_id") or "") == source_device_id)
            and (before_sequence is None or int(row.get("sequence") or 0) < before_sequence)
        )

    @staticmethod
    def _read_jsonl(path: Path) -> list[dict[str, object]]:
        if not path.is_file():
            return []
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        rows: list[dict[str, object]] = []
        for line in lines:
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if isinstance(value, dict) and int(value.get("sequence") or 0) > 0:
                rows.append(value)
        return rows

    @staticmethod
    def _read_jsonl_reverse(path: Path, *, block_size: int = 64 * 1024) -> Iterator[dict[str, object]]:
        if not path.is_file():
            return
        try:
            with path.open("rb") as source:
                source.seek(0, os.SEEK_END)
                position = source.tell()
                remainder = b""
                while position > 0:
                    read_size = min(block_size, position)
                    position -= read_size
                    source.seek(position)
                    remainder = source.read(read_size) + remainder
                    lines = remainder.split(b"\n")
                    remainder = lines[0]
                    for line in reversed(lines[1:]):
                        row = AudioStreamEventStore._decode_jsonl_row(line)
                        if row is not None:
                            yield row
                row = AudioStreamEventStore._decode_jsonl_row(remainder)
                if row is not None:
                    yield row
        except OSError:
            return

    @staticmethod
    def _decode_jsonl_row(line: bytes) -> dict[str, object] | None:
        if not line.strip():
            return None
        try:
            value = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, TypeError, ValueError, json.JSONDecodeError):
            return None
        if isinstance(value, dict) and int(value.get("sequence") or 0) > 0:
            return value
        return None

    @staticmethod
    def _atomic_write(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as output:
            output.write(content)
            output.flush()
            try:
                os.fsync(output.fileno())
            except OSError:
                pass
        temporary.replace(path)


def _one_line(value: object, maximum: int = 200) -> str:
    return " ".join(str(value or "").split()).strip()[:maximum]


def _positive_float(value: object, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed >= 0 else fallback


def _optional_nonnegative_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return max(0, parsed)


def _direction(value: object) -> str:
    text = _one_line(value, 20).lower()
    return text if text in {"inbound", "outbound", "receipt", "system", "pipeline"} else "system"


def _level(value: object) -> str:
    text = _one_line(value, 20).lower()
    return text if text in {"info", "warning", "error"} else "info"


def _safe_detail(value: object) -> object:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _one_line(value, 500)
    if isinstance(value, list):
        return [_safe_detail(item) for item in value[:20]]
    if isinstance(value, dict):
        return {
            _one_line(key, 100): _safe_detail(item)
            for key, item in list(value.items())[:20]
            if _one_line(key, 100)
        }
    return _one_line(value, 500)


__all__ = ["AudioStreamEventStore"]
