from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import asdict, replace
from datetime import datetime
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import TYPE_CHECKING, Callable

from .contracts import TranscriptionResult

if TYPE_CHECKING:
    from .speaker_profiles import SpeakerProfileRegistry


class SpeechRecordStore:
    """Append-only runtime ledger for ASR and TTS text metadata."""

    def __init__(
        self,
        root: str | Path,
        speaker_registry: "SpeakerProfileRegistry | None" = None,
        *,
        event_sink: Callable[[str, object], None] | None = None,
    ) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.speaker_registry = speaker_registry
        self._event_sink = event_sink
        self._lock = threading.Lock()

    def append_asr(
        self,
        result: TranscriptionResult,
        *,
        source: str,
        session_id: str | None = None,
        route_id: str | None = None,
        recorded_at: float | None = None,
        record_id: str | None = None,
    ) -> dict[str, object]:
        record_id = str(record_id or result.record_id or f"speech-{uuid.uuid4().hex}")
        resolved = (
            self.speaker_registry.resolve_transcription(
                result,
                session_id=session_id,
                record_id=record_id,
            )
            if self.speaker_registry
            else replace(
                result,
                segments=[
                    replace(
                        segment,
                        speaker_label=segment.speaker_label or segment.speaker,
                        speaker_decision=segment.speaker_decision or (
                            "unbound_diarization_label" if segment.speaker_label or segment.speaker else "not_labeled"
                        ),
                    )
                    for segment in result.segments
                ],
            )
        )
        return self.append(
            {
                "id": record_id,
                "kind": "asr",
                "source": source,
                "time": recorded_at or time.time(),
                "session_id": session_id or None,
                "route_id": route_id or None,
                "provider": resolved.provider,
                "model": resolved.model,
                "text": resolved.text.strip(),
                "language": resolved.language or None,
                "duration": resolved.duration,
                "segments": [asdict(segment) for segment in resolved.segments],
            }
        )

    def append_tts(
        self,
        *,
        text: str,
        provider: str,
        model: str,
        voice: str,
        session_id: str | None = None,
        route_id: str | None = None,
        playback_job_id: str | None = None,
        playback_status: str | None = None,
        audio_file: str | None = None,
        audio_expires_at: float | None = None,
    ) -> dict[str, object]:
        relative_audio_file = _relative_audio_file(audio_file)
        return self.append(
            {
                "kind": "tts",
                "source": "api",
                "time": time.time(),
                "session_id": session_id or None,
                "route_id": route_id or None,
                "provider": provider,
                "model": model,
                "voice": voice,
                "text": text.strip(),
                "playback_job_id": playback_job_id or None,
                "playback_status": playback_status or None,
                "audio_file": relative_audio_file,
                "audio_expires_at": audio_expires_at,
            }
        )

    def append(self, value: dict[str, object]) -> dict[str, object]:
        row = {
            "id": str(value.get("id") or f"speech-{uuid.uuid4().hex}"),
            **value,
        }
        timestamp = float(row.get("time") or time.time())
        row["time"] = timestamp
        target = self.root / f"{datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d')}.jsonl"
        encoded = json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._lock:
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("a", encoding="utf-8", newline="\n") as output:
                output.write(encoded)
                output.flush()
        if self._event_sink is not None:
            self._event_sink(
                "records_changed",
                {
                    "id": row["id"],
                    "kind": row.get("kind"),
                    "time": row["time"],
                    "session_id": row.get("session_id"),
                    "route_id": row.get("route_id"),
                },
            )
        return row

    def list(
        self,
        *,
        limit: int = 200,
        kind: str | None = None,
        session_id: str | None = None,
        route_id: str | None = None,
        since: float | None = None,
        until: float | None = None,
    ) -> list[dict[str, object]]:
        maximum = min(1000, max(1, int(limit)))
        records: list[dict[str, object]] = []
        with self._lock:
            files = sorted(self.root.glob("*.jsonl"), reverse=True)
            for path in files:
                try:
                    lines = path.read_text(encoding="utf-8").splitlines()
                except OSError:
                    continue
                for line in reversed(lines):
                    try:
                        row = json.loads(line)
                    except (TypeError, ValueError, json.JSONDecodeError):
                        continue
                    if not isinstance(row, dict) or not self._matches(row, kind, session_id, route_id, since, until):
                        continue
                    row = self._safe_record(row)
                    row = self._resolve_speakers(row)
                    records.append(row)
                    if len(records) >= maximum:
                        return records
        return records

    @staticmethod
    def _safe_record(row: dict[str, object]) -> dict[str, object]:
        if "audio_file" not in row:
            return row
        safe = dict(row)
        raw_audio_file = safe.get("audio_file")
        try:
            audio_file = _relative_audio_file(raw_audio_file if isinstance(raw_audio_file, str) else None)
        except ValueError:
            audio_file = None
        if audio_file is None:
            safe.pop("audio_file", None)
        else:
            safe["audio_file"] = audio_file
        return safe

    def _resolve_speakers(self, row: dict[str, object]) -> dict[str, object]:
        if self.speaker_registry is None or row.get("kind") != "asr":
            return row
        session_id = str(row.get("session_id") or "").strip() or None
        record_id = str(row.get("id") or "").strip() or None
        segments = row.get("segments")
        if not isinstance(segments, list):
            return row
        resolved_segments: list[object] = []
        for value in segments:
            if not isinstance(value, dict):
                resolved_segments.append(value)
                continue
            segment = dict(value)
            label = str(segment.get("speaker_label") or segment.get("speaker") or "").strip() or None
            resolution = self.speaker_registry.resolve(session_id, label, record_id=record_id)
            segment["speaker"] = label
            if resolution.get("speaker_id"):
                segment.update(resolution)
            else:
                segment["speaker_label"] = resolution.get("speaker_label")
                segment["speaker_decision"] = segment.get("speaker_decision") or resolution.get("speaker_decision")
            resolved_segments.append(segment)
        return {**row, "segments": resolved_segments}

    @staticmethod
    def _matches(
        row: dict[str, object],
        kind: str | None,
        session_id: str | None,
        route_id: str | None,
        since: float | None,
        until: float | None,
    ) -> bool:
        timestamp = float(row.get("time") or 0)
        return not (
            (kind and str(row.get("kind") or "") != kind)
            or (session_id and str(row.get("session_id") or "") != session_id)
            or (route_id and str(row.get("route_id") or "") != route_id)
            or (since is not None and timestamp < since)
            or (until is not None and timestamp > until)
        )


def _relative_audio_file(value: str | None) -> str | None:
    text = str(value or "").strip().replace("\\", "/")
    if not text:
        return None
    if ":" in text or "%" in text or any(ord(character) < 32 or ord(character) == 127 for character in text):
        raise ValueError("Speech record audio_file must be a safe relative path.")
    windows_path = PureWindowsPath(text)
    posix_path = PurePosixPath(text)
    if windows_path.drive or windows_path.root or posix_path.is_absolute() or ".." in posix_path.parts:
        raise ValueError("Speech record audio_file must be a safe relative path.")
    normalized = posix_path.as_posix()
    if not normalized or normalized == ".":
        raise ValueError("Speech record audio_file must identify a file.")
    return normalized
