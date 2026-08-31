from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import json
import threading
import time
import uuid
import socket
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .audio_stream_events import AudioStreamEventStore


RemoteFeed = Callable[[str, np.ndarray], None]
LocalPlayer = Callable[[Path, int, threading.Event], None]
LocalStopper = Callable[[], None]


_VIRTUAL_CHUNK_DEDUP_MAX_SOURCES = 4096
_DURABLE_LEDGER_SCHEMA_VERSION = 3
_DURABLE_LEDGER_MAX_PAGE = 1_000
_DURABLE_LEDGER_SNAPSHOT_TUPLES = 64
_DURABLE_LEDGER_SNAPSHOT_RESOLUTIONS = 50


class _DurableChunkLedger:
    """Cross-process claim/commit ledger for RabiLink audio shards.

    A lease is recoverable only while the row remains ``claimed``. Once a
    worker records ``delivery_started`` the downstream ASR side effect is not
    knowable after a crash, so replay stays unacknowledged and is not fed again.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._connect() as database:
            database.execute(
                """
                CREATE TABLE IF NOT EXISTS processed_chunks (
                    source_device_id TEXT NOT NULL,
                    chunk_id TEXT NOT NULL,
                    accepted_bytes INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    processed_at REAL NOT NULL,
                    result TEXT NOT NULL,
                    PRIMARY KEY (source_device_id, chunk_id)
                )
                """
            )
            database.commit()
            database.execute("BEGIN IMMEDIATE")
            columns = {str(row[1]) for row in database.execute("PRAGMA table_info(processed_chunks)")}
            migrations = {
                "state": "ALTER TABLE processed_chunks ADD COLUMN state TEXT NOT NULL DEFAULT 'processed'",
                "owner_id": "ALTER TABLE processed_chunks ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''",
                "lease_until": "ALTER TABLE processed_chunks ADD COLUMN lease_until REAL NOT NULL DEFAULT 0",
                "updated_at": "ALTER TABLE processed_chunks ADD COLUMN updated_at REAL NOT NULL DEFAULT 0",
                "source_sequence": "ALTER TABLE processed_chunks ADD COLUMN source_sequence INTEGER NOT NULL DEFAULT 0",
                "stream_sequence": "ALTER TABLE processed_chunks ADD COLUMN stream_sequence INTEGER NOT NULL DEFAULT 0",
            }
            for column, statement in migrations.items():
                if column not in columns:
                    database.execute(statement)
            database.execute(
                "UPDATE processed_chunks SET state = 'processed', updated_at = processed_at "
                "WHERE result = 'processed' AND state != 'processed'"
            )
            database.execute(
                "CREATE TABLE IF NOT EXISTS retired_sources ("
                "source_device_id TEXT PRIMARY KEY, retired_at REAL NOT NULL, removed_chunks INTEGER NOT NULL, "
                "removed_bytes INTEGER NOT NULL, confirmation_sha256 TEXT NOT NULL)"
            )
            database.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS processed_chunks_source_sequence "
                "ON processed_chunks(source_device_id, source_sequence) WHERE source_sequence > 0"
            )
            database.execute(
                "CREATE TABLE IF NOT EXISTS resolution_audit ("
                "event_id TEXT PRIMARY KEY, source_device_id TEXT NOT NULL, chunk_id TEXT NOT NULL, "
                "accepted_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, source_sequence INTEGER NOT NULL, "
                "decision TEXT NOT NULL, resolved_at REAL NOT NULL, operator TEXT NOT NULL, "
                "action TEXT NOT NULL, result TEXT NOT NULL)"
            )
            database.execute(f"PRAGMA user_version = {_DURABLE_LEDGER_SCHEMA_VERSION}")

    def _connect(self) -> sqlite3.Connection:
        database = sqlite3.connect(self.path, timeout=10)
        database.execute("PRAGMA busy_timeout=10000")
        database.execute("PRAGMA journal_mode=WAL")
        database.execute("PRAGMA synchronous=FULL")
        return database

    def find(self, source_device_id: str, chunk_id: str) -> tuple[int, str, str] | None:
        with self._lock, self._connect() as database:
            row = database.execute(
                "SELECT accepted_bytes, sha256, state FROM processed_chunks "
                "WHERE source_device_id = ? AND chunk_id = ?",
                (source_device_id, chunk_id),
            ).fetchone()
        if row is None:
            return None
        return int(row[0]), str(row[1]), str(row[2])

    def claim(
        self,
        source_device_id: str,
        chunk_id: str,
        accepted_bytes: int,
        sha256: str,
        source_sequence: int,
        stream_sequence: int,
        owner_id: str,
        lease_seconds: float,
    ) -> str:
        now = time.time()
        with self._lock, self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            if database.execute(
                "SELECT 1 FROM retired_sources WHERE source_device_id = ?", (source_device_id,)
            ).fetchone() is not None:
                raise ValueError(
                    f"RabiLink audio source {source_device_id!r} is retired; reconnect it with a new stable source id."
                )
            existing = database.execute(
                "SELECT accepted_bytes, sha256, state, owner_id, lease_until, source_sequence FROM processed_chunks "
                "WHERE source_device_id = ? AND chunk_id = ?",
                (source_device_id, chunk_id),
            ).fetchone()
            if existing is None:
                if source_sequence > 0:
                    sequence_owner = database.execute(
                        "SELECT chunk_id FROM processed_chunks WHERE source_device_id = ? AND source_sequence = ?",
                        (source_device_id, source_sequence),
                    ).fetchone()
                    if sequence_owner is not None:
                        raise ValueError(
                            f"RabiLink audio source sequence {source_sequence} conflicts with chunk id {sequence_owner[0]!r}."
                        )
                database.execute(
                    "INSERT INTO processed_chunks "
                    "(source_device_id, chunk_id, accepted_bytes, sha256, processed_at, result, "
                    "state, owner_id, lease_until, updated_at, source_sequence, stream_sequence) "
                    "VALUES (?, ?, ?, ?, 0, 'pending', 'claimed', ?, ?, ?, ?, ?)",
                    (source_device_id, chunk_id, accepted_bytes, sha256, owner_id,
                     now + max(0.1, lease_seconds), now, source_sequence, stream_sequence),
                )
                return "owned"
            if (int(existing[0]), str(existing[1])) != (accepted_bytes, sha256):
                raise ValueError(f"RabiLink audio chunk id {chunk_id!r} conflicts with its durable ledger record.")
            persisted_source_sequence = int(existing[5] or 0)
            if source_sequence > 0 and persisted_source_sequence not in {0, source_sequence}:
                raise ValueError(f"RabiLink audio chunk id {chunk_id!r} conflicts with its durable source sequence.")
            if persisted_source_sequence == 0 and source_sequence > 0:
                sequence_owner = database.execute(
                    "SELECT chunk_id FROM processed_chunks WHERE source_device_id = ? AND source_sequence = ? "
                    "AND chunk_id != ?",
                    (source_device_id, source_sequence, chunk_id),
                ).fetchone()
                if sequence_owner is not None:
                    raise ValueError(
                        f"RabiLink audio source sequence {source_sequence} conflicts with chunk id {sequence_owner[0]!r}."
                    )
                database.execute(
                    "UPDATE processed_chunks SET source_sequence = ?, stream_sequence = ? "
                    "WHERE source_device_id = ? AND chunk_id = ?",
                    (source_sequence, stream_sequence, source_device_id, chunk_id),
                )
            state = str(existing[2])
            if state == "processed":
                return "processed"
            if state == "delivery_started":
                return "busy" if float(existing[4] or 0) > now else "ambiguous"
            lease_until = float(existing[4] or 0)
            if state == "claimed" and (str(existing[3]) == owner_id or lease_until <= now):
                database.execute(
                    "UPDATE processed_chunks SET owner_id = ?, lease_until = ?, updated_at = ? "
                    "WHERE source_device_id = ? AND chunk_id = ?",
                    (owner_id, now + max(0.1, lease_seconds), now, source_device_id, chunk_id),
                )
                return "owned"
            return "busy"

    def mark_delivery_started(self, source_device_id: str, chunk_id: str, owner_id: str) -> None:
        now = time.time()
        with self._lock, self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            changed = database.execute(
                "UPDATE processed_chunks SET state = 'delivery_started', result = 'ambiguous', "
                "updated_at = ? WHERE source_device_id = ? AND chunk_id = ? "
                "AND state = 'claimed' AND owner_id = ?",
                (now, source_device_id, chunk_id, owner_id),
            ).rowcount
            if changed != 1:
                raise ValueError(f"RabiLink audio chunk id {chunk_id!r} lost its durable processing claim.")

    def commit_processed(self, source_device_id: str, chunk_id: str, owner_id: str) -> None:
        now = time.time()
        with self._lock, self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            changed = database.execute(
                "UPDATE processed_chunks SET state = 'processed', result = 'processed', processed_at = ?, "
                "updated_at = ?, lease_until = 0 WHERE source_device_id = ? AND chunk_id = ? "
                "AND state = 'delivery_started' AND owner_id = ?",
                (now, now, source_device_id, chunk_id, owner_id),
            ).rowcount
            if changed != 1:
                raise ValueError(f"RabiLink audio chunk id {chunk_id!r} could not commit its durable processing claim.")

    def resolve_ambiguous(
        self,
        source_device_id: str,
        chunk_id: str,
        accepted_bytes: int,
        sha256: str,
        decision: str,
        operator: str = "loopback_operator",
    ) -> dict[str, object]:
        normalized_decision = str(decision or "").strip().lower()
        if normalized_decision not in {"replay", "skip"}:
            raise ValueError("Ambiguous RabiLink audio resolution must be 'replay' or 'skip'.")
        normalized_operator = _safe_operator(operator)
        now = time.time()
        event_id = uuid.uuid4().hex
        terminal_state = "claimed" if normalized_decision == "replay" else "processed"
        with self._lock, self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            existing = database.execute(
                "SELECT accepted_bytes, sha256, state, source_sequence FROM processed_chunks "
                "WHERE source_device_id = ? AND chunk_id = ?",
                (source_device_id, chunk_id),
            ).fetchone()
            if existing is None:
                raise ValueError(f"RabiLink audio chunk id {chunk_id!r} has no durable ledger record.")
            if (int(existing[0]), str(existing[1])) != (accepted_bytes, sha256):
                raise ValueError(f"RabiLink audio chunk id {chunk_id!r} conflicts with its durable ledger record.")
            if str(existing[2]) != "delivery_started":
                raise ValueError(f"RabiLink audio chunk id {chunk_id!r} is not awaiting ambiguous delivery resolution.")
            if normalized_decision == "replay":
                database.execute(
                    "UPDATE processed_chunks SET state = 'claimed', result = 'operator_replay', owner_id = '', "
                    "lease_until = 0, updated_at = ? WHERE source_device_id = ? AND chunk_id = ?",
                    (now, source_device_id, chunk_id),
                )
            else:
                database.execute(
                    "UPDATE processed_chunks SET state = 'processed', result = 'operator_confirmed_processed', "
                    "processed_at = ?, owner_id = '', lease_until = 0, updated_at = ? "
                    "WHERE source_device_id = ? AND chunk_id = ?",
                    (now, now, source_device_id, chunk_id),
                )
            database.execute(
                "INSERT INTO resolution_audit "
                "(event_id, source_device_id, chunk_id, accepted_bytes, sha256, source_sequence, "
                "decision, resolved_at, operator, action, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    event_id,
                    source_device_id,
                    chunk_id,
                    accepted_bytes,
                    sha256,
                    int(existing[3] or 0),
                    normalized_decision,
                    now,
                    normalized_operator,
                    "resolve_ambiguous",
                    terminal_state,
                ),
            )
        return {
            "source_device_id": source_device_id,
            "chunk_id": chunk_id,
            "accepted_bytes": accepted_bytes,
            "sha256": sha256,
            "decision": normalized_decision,
            "state": terminal_state,
            "audit_event_id": event_id,
        }

    def tuple_page(
        self,
        source_device_id: str,
        *,
        after_source_sequence: int = 0,
        limit: int = 500,
    ) -> dict[str, object]:
        """Return one bounded, ordered maintenance page without paths, payloads, or credentials."""
        normalized_source = str(source_device_id or "").strip()[:200]
        if not normalized_source:
            raise ValueError("A stable RabiLink source device id is required.")
        normalized_after = max(0, int(after_source_sequence))
        normalized_limit = min(_DURABLE_LEDGER_MAX_PAGE, max(1, int(limit)))
        with self._lock, self._connect() as database:
            rows = database.execute(
                "SELECT source_device_id, chunk_id, accepted_bytes, sha256, source_sequence, stream_sequence, "
                "state, result, processed_at FROM processed_chunks "
                "WHERE source_device_id = ? AND source_sequence > ? "
                "ORDER BY source_sequence, chunk_id LIMIT ?",
                (normalized_source, normalized_after, normalized_limit + 1),
            ).fetchall()
        has_more = len(rows) > normalized_limit
        visible = rows[:normalized_limit]
        records = [self._tuple_record(row) for row in visible]
        next_after = int(visible[-1][4]) if visible else normalized_after
        return {
            "source_device_id": normalized_source,
            "after_source_sequence": normalized_after,
            "limit": normalized_limit,
            "records": records,
            "has_more": has_more,
            "next_after_source_sequence": next_after,
            "redaction": "no_audio_payload_paths_credentials_or_owner_leases",
        }

    def retire_source(
        self,
        source_device_id: str,
        *,
        phone_spool_empty: bool,
        maximum_phone_retention_elapsed: bool,
        operator_confirmation: str,
    ) -> dict[str, object]:
        confirmation = str(operator_confirmation or "").strip()
        if confirmation != f"retire:{source_device_id}":
            raise ValueError("Durable source retirement requires the exact operator confirmation string.")
        if not phone_spool_empty or not maximum_phone_retention_elapsed:
            raise ValueError("Durable source retirement requires an empty phone spool and elapsed phone retention window.")
        now = time.time()
        with self._lock, self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            ambiguous = int(database.execute(
                "SELECT COUNT(*) FROM processed_chunks WHERE source_device_id = ? AND state = 'delivery_started'",
                (source_device_id,),
            ).fetchone()[0])
            if ambiguous:
                raise ValueError("Resolve every ambiguous RabiLink audio chunk before retiring its source.")
            removed_chunks, removed_bytes = database.execute(
                "SELECT COUNT(*), COALESCE(SUM(accepted_bytes), 0) FROM processed_chunks WHERE source_device_id = ?",
                (source_device_id,),
            ).fetchone()
            confirmation_sha256 = hashlib.sha256(confirmation.encode("utf-8")).hexdigest()
            database.execute(
                "INSERT INTO retired_sources "
                "(source_device_id, retired_at, removed_chunks, removed_bytes, confirmation_sha256) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_device_id) DO NOTHING",
                (source_device_id, now, int(removed_chunks), int(removed_bytes), confirmation_sha256),
            )
            database.execute("DELETE FROM processed_chunks WHERE source_device_id = ?", (source_device_id,))
        with self._lock, self._connect() as database:
            database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            database.execute("VACUUM")
        return {
            "source_device_id": source_device_id,
            "retired": True,
            "removed_chunks": int(removed_chunks),
            "removed_bytes": int(removed_bytes),
            "audit_retained": True,
        }

    def maintenance_snapshot(self) -> dict[str, object]:
        with self._lock, self._connect() as database:
            rows = dict(database.execute("SELECT state, COUNT(*) FROM processed_chunks GROUP BY state"))
            source_rows = database.execute(
                "SELECT source_device_id, "
                "SUM(CASE WHEN state = 'processed' THEN 1 ELSE 0 END), "
                "SUM(CASE WHEN state = 'processed' THEN accepted_bytes ELSE 0 END), "
                "SUM(CASE WHEN state = 'delivery_started' THEN 1 ELSE 0 END) "
                "FROM processed_chunks GROUP BY source_device_id ORDER BY source_device_id"
            ).fetchall()
            retired_sources = int(database.execute("SELECT COUNT(*) FROM retired_sources").fetchone()[0])
            tuple_rows = database.execute(
                "SELECT source_device_id, chunk_id, accepted_bytes, sha256, source_sequence, stream_sequence, "
                "state, result, processed_at FROM processed_chunks WHERE source_sequence > 0 AND state = 'processed' "
                "ORDER BY updated_at DESC, source_device_id, source_sequence LIMIT ?",
                (_DURABLE_LEDGER_SNAPSHOT_TUPLES,),
            ).fetchall()
            resolution_count = int(database.execute("SELECT COUNT(*) FROM resolution_audit").fetchone()[0])
            resolution_rows = database.execute(
                "SELECT event_id, source_device_id, chunk_id, accepted_bytes, sha256, source_sequence, "
                "decision, resolved_at, operator, action, result FROM resolution_audit "
                "ORDER BY resolved_at DESC, event_id DESC LIMIT ?",
                (_DURABLE_LEDGER_SNAPSHOT_RESOLUTIONS,),
            ).fetchall()
            schema_version = int(database.execute("PRAGMA user_version").fetchone()[0])
            database.execute("PRAGMA wal_checkpoint(PASSIVE)")
        database_bytes = sum(
            candidate.stat().st_size for candidate in (
                self.path,
                Path(f"{self.path}-wal"),
                Path(f"{self.path}-shm"),
            ) if candidate.exists()
        )
        watermark_bytes = 512 * 1024 * 1024
        return {
            "processed": int(rows.get("processed", 0)),
            "claimed": int(rows.get("claimed", 0)),
            "ambiguous": int(rows.get("delivery_started", 0)),
            "sources": [
                {
                    "source_device_id": str(row[0]),
                    "processed": int(row[1] or 0),
                    "processed_bytes": int(row[2] or 0),
                    "ambiguous": int(row[3] or 0),
                }
                for row in source_rows
            ],
            "database_bytes": database_bytes,
            "watermark_bytes": watermark_bytes,
            "over_watermark": database_bytes > watermark_bytes,
            "retention": "indefinite_until_explicit_source_retirement",
            "automatic_pruning": False,
            "schema_version": schema_version,
            "retired_sources": retired_sources,
            "terminal_tuple_sample": [self._tuple_record(row) for row in tuple_rows],
            "terminal_tuple_sample_limit": _DURABLE_LEDGER_SNAPSHOT_TUPLES,
            "resolution_audit_count": resolution_count,
            "recent_resolutions": [
                {
                    "event_id": str(row[0]),
                    "source_device_id": str(row[1]),
                    "chunk_id": str(row[2]),
                    "accepted_bytes": int(row[3]),
                    "sha256": str(row[4]),
                    "source_sequence": int(row[5] or 0),
                    "decision": str(row[6]),
                    "resolved_at": float(row[7]),
                    "operator": str(row[8]),
                    "action": str(row[9]),
                    "result": str(row[10]),
                }
                for row in resolution_rows
            ],
            "recent_resolution_limit": _DURABLE_LEDGER_SNAPSHOT_RESOLUTIONS,
            "maintenance_redaction": "no_audio_payload_paths_credentials_or_owner_leases",
            "ambiguous_resolution": {
                "automatic": False,
                "decisions": ["replay", "skip"],
                "scope": "loopback_operator_only",
            },
            "safe_prune_requires": [
                "source_retired",
                "phone_spool_empty",
                "maximum_phone_retention_elapsed",
                "operator_confirmation",
            ],
        }

    @staticmethod
    def _tuple_record(row: tuple[object, ...]) -> dict[str, object]:
        state = str(row[6])
        result = str(row[7])
        return {
            "source_device_id": str(row[0]),
            "chunk_id": str(row[1]),
            "accepted_bytes": int(row[2]),
            "sha256": str(row[3]),
            "source_sequence": int(row[4] or 0),
            "stream_sequence": int(row[5] or 0),
            "terminal": state == "processed",
            "terminal_status": result if state == "processed" else state,
            "processed_at": float(row[8] or 0),
        }


@dataclass(frozen=True)
class RemoteAudioServerConfig:
    enabled: bool
    host: str
    port: int
    token: str
    settings_path: Path
    discovery_port: int
    service_name: str


@dataclass
class _Client:
    id: str
    name: str
    kind: str
    device_model: str
    message_adapter_type: str
    route_profile_id: str
    session_id: str
    websocket: Any
    sample_rate: int
    chunk_ms: int
    connected_at: float
    last_audio_at: float = 0.0
    received_bytes: int = 0
    accepted_chunks: int = 0
    playback_waiter: asyncio.Future[None] | None = None
    playback_id: str = ""


@dataclass
class _VirtualClient:
    id: str
    name: str
    kind: str
    device_model: str
    source_device_id: str
    message_adapter_type: str
    route_profile_id: str
    session_id: str
    connected_at: float
    last_audio_at: float = 0.0
    last_sequence: int = 0
    last_chunk_id: str = ""
    last_chunk_bytes: int = 0
    last_chunk_sha256: str = ""
    received_bytes: int = 0
    accepted_chunks: int = 0
    resume_client_id: str | None = None
    resume_running: bool = False


class RemoteAudioHub:
    """Authenticated network sound-card hub.

    Remote clients only exchange mono PCM/WAV audio. Host-side RabiSpeech keeps
    ownership of VAD, phrase segmentation, ASR, routing, TTS FIFO, and playback
    suppression.
    """

    def __init__(
        self,
        config: RemoteAudioServerConfig,
        *,
        local_player: LocalPlayer,
        local_stopper: LocalStopper,
        event_sink: Callable[[str, object], None] | None = None,
        event_store: AudioStreamEventStore | None = None,
        durable_chunk_owner_id: str | None = None,
        durable_chunk_lease_seconds: float = 30.0,
        durable_chunk_cutpoint: Callable[[str, str, str], None] | None = None,
    ) -> None:
        self.config = config
        self._local_player = local_player
        self._local_stopper = local_stopper
        self._event_sink = event_sink
        self._event_store = event_store
        self._durable_chunk_ledger = _DurableChunkLedger(
            self.config.settings_path.parent / "rabilink-audio-ack-ledger.sqlite3"
        )
        self._durable_chunk_owner_id = durable_chunk_owner_id or str(uuid.uuid4())
        self._durable_chunk_lease_seconds = max(0.1, float(durable_chunk_lease_seconds))
        self._durable_chunk_cutpoint = durable_chunk_cutpoint
        self._feed: RemoteFeed | None = None
        self._clients: dict[str, _Client] = {}
        self._virtual_clients: dict[str, _VirtualClient] = {}
        # Stable shard identity is independent of a temporary stream's sequence.
        # A rebuilt stream restarts at sequence 1, while chunk id + bytes + SHA remain stable.
        self._last_virtual_chunk_by_source: dict[str, tuple[str, int, str, float]] = {}
        self._virtual_pcm_totals_by_source: dict[str, tuple[int, int]] = {}
        self._server: Any = None
        self._discovery_transport: asyncio.DatagramTransport | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._capture_enabled = False
        self._capture_sample_rate = 16_000
        self._capture_chunk_ms = 100
        self._selected_client_id = self._read_selection()
        self._events: list[dict[str, object]] = []
        self._event_sequence = 0
        self._last_event_at: dict[tuple[str, str], float] = {}

    @property
    def selected_client_id(self) -> str | None:
        return self._selected_client_id

    @property
    def selected_client_name(self) -> str | None:
        virtual_client = self._selected_virtual_client()
        if virtual_client is not None:
            return virtual_client.name
        client = self._clients.get(self._selected_client_id or "")
        return client.name if client is not None else None

    @property
    def selected_client_kind(self) -> str | None:
        virtual_client = self._selected_virtual_client()
        if virtual_client is not None:
            return virtual_client.kind
        client = self._clients.get(self._selected_client_id or "")
        return client.kind if client is not None else None

    @property
    def selected_device_model(self) -> str | None:
        virtual_client = self._selected_virtual_client()
        if virtual_client is not None:
            return virtual_client.device_model or None
        client = self._clients.get(self._selected_client_id or "")
        return (client.device_model or None) if client is not None else None

    @property
    def selected_source_device_id(self) -> str | None:
        virtual_client = self._selected_virtual_client()
        if virtual_client is not None:
            return virtual_client.source_device_id or virtual_client.id
        client = self._clients.get(self._selected_client_id or "")
        return client.id if client is not None else None

    @property
    def selected_message_adapter_type(self) -> str | None:
        virtual_client = self._selected_virtual_client()
        if virtual_client is not None:
            return virtual_client.message_adapter_type
        client = self._clients.get(self._selected_client_id or "")
        return client.message_adapter_type if client is not None else None

    @property
    def selected_route_profile_id(self) -> str | None:
        virtual_client = self._selected_virtual_client()
        if virtual_client is not None:
            return virtual_client.route_profile_id or None
        client = self._clients.get(self._selected_client_id or "")
        return (client.route_profile_id or None) if client is not None else None

    @property
    def selected_session_id(self) -> str | None:
        virtual_client = self._selected_virtual_client()
        if virtual_client is not None:
            return virtual_client.session_id or None
        client = self._clients.get(self._selected_client_id or "")
        return (client.session_id or None) if client is not None else None

    @property
    def active_virtual_client_id(self) -> str | None:
        return self._selected_client_id if self._selected_client_id in self._virtual_clients else None

    def has_virtual_client(self, client_id: str) -> bool:
        return _safe_id(client_id) in self._virtual_clients

    def _selected_virtual_client(self) -> _VirtualClient | None:
        return self._virtual_clients.get(self._selected_client_id or "")

    @property
    def source(self) -> str:
        return "remote" if self._selected_client_id else "local"

    def set_feed(self, callback: RemoteFeed) -> None:
        self._feed = callback

    def _emit_changed(self) -> None:
        if self._event_sink is not None:
            self._event_sink("audio_stream_changed", self.snapshot())

    def _append_event(
        self,
        *,
        direction: str,
        kind: str,
        message: str,
        client_id: str = "",
        byte_count: int = 0,
        total_bytes: int = 0,
        stream_sequence: int | None = None,
        min_interval_seconds: float = 0.0,
        stage: str = "transport",
        level: str = "info",
        source_device_id: str = "",
        device_model: str = "",
        record_id: str = "",
        route_id: str = "",
        details: dict[str, object] | None = None,
    ) -> bool:
        now = time.time()
        throttle_key = (client_id, kind)
        if min_interval_seconds > 0 and now - self._last_event_at.get(throttle_key, 0.0) < min_interval_seconds:
            return False
        self._last_event_at[throttle_key] = now
        client = self._virtual_clients.get(client_id) or self._clients.get(client_id)
        resolved_source_device_id = source_device_id or (
            client.source_device_id if isinstance(client, _VirtualClient) else client.id if client is not None else ""
        )
        resolved_device_model = device_model or (client.device_model if client is not None else "")
        self._event_sequence += 1
        event: dict[str, object] = {
            "sequence": self._event_sequence,
            "time": now,
            "direction": direction,
            "stage": stage,
            "kind": kind,
            "level": level,
            "message": message[:200],
            "client_id": client_id or None,
            "source_device_id": resolved_source_device_id or None,
            "device_model": resolved_device_model or None,
            "bytes": max(0, int(byte_count)),
            "total_bytes": max(0, int(total_bytes)),
            "record_id": record_id or None,
            "route_id": route_id or None,
            "details": details or {},
        }
        if stream_sequence is not None:
            event["stream_sequence"] = max(0, int(stream_sequence))
        if self._event_store is not None:
            event = self._event_store.append(event)
            self._event_sequence = max(self._event_sequence, int(event["sequence"]))
        self._events.append(event)
        if len(self._events) > 200:
            del self._events[:-200]
        return True

    def list_events(
        self,
        *,
        limit: int = 200,
        client_id: str | None = None,
        source_device_id: str | None = None,
        before_sequence: int | None = None,
    ) -> list[dict[str, object]]:
        if self._event_store is not None:
            return self._event_store.list(
                limit=limit,
                client_id=client_id,
                source_device_id=source_device_id,
                before_sequence=before_sequence,
            )
        rows = [
            row
            for row in reversed(self._events)
            if (
                (not client_id or str(row.get("client_id") or "") == client_id)
                and (not source_device_id or str(row.get("source_device_id") or "") == source_device_id)
                and (before_sequence is None or int(row.get("sequence") or 0) < before_sequence)
            )
        ]
        return rows[: min(1_000, max(1, int(limit)))]

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        if not self.config.enabled:
            return
        if not self.config.token:
            raise RuntimeError("Remote audio streaming is enabled but no token is configured.")
        from websockets.asyncio.server import serve

        self._server = await serve(
            self._handle_client,
            self.config.host,
            self.config.port,
            max_size=2 * 1024 * 1024,
            ping_interval=20,
            ping_timeout=20,
        )
        loop = asyncio.get_running_loop()
        transport, _protocol = await loop.create_datagram_endpoint(
            lambda: _DiscoveryProtocol(self.config),
            local_addr=("0.0.0.0", self.config.discovery_port),
        )
        self._discovery_transport = transport

    async def stop(self) -> None:
        self._capture_enabled = False
        self._virtual_clients.clear()
        clients = list(self._clients.values())
        self._clients.clear()
        for client in clients:
            try:
                await client.websocket.close(code=1001, reason="RabiSpeech stopping")
            except Exception:
                pass
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        if self._discovery_transport is not None:
            self._discovery_transport.close()
            self._discovery_transport = None

    def snapshot(self) -> dict[str, object]:
        now = time.time()
        rows = [
                {
                    "id": client.id,
                    "name": client.name,
                    "kind": client.kind,
                    "device_model": client.device_model or None,
                "source_device_id": client.id,
                    "message_adapter_type": client.message_adapter_type,
                    "route_profile_id": client.route_profile_id or None,
                    "session_id": client.session_id or None,
                    "sample_rate": client.sample_rate,
                    "chunk_ms": client.chunk_ms,
                    "connected_at": client.connected_at,
                    "last_audio_at": client.last_audio_at or None,
                    "received_bytes": client.received_bytes,
                    "accepted_chunks": client.accepted_chunks,
                    "selected": client.id == self._selected_client_id,
                    "online": True,
                }
                for client in self._clients.values()
            ]
        for client in self._virtual_clients.values():
            rows.append({
                "id": client.id,
                "name": client.name,
                "kind": client.kind,
                "device_model": client.device_model or None,
                "source_device_id": client.source_device_id or client.id,
                "message_adapter_type": client.message_adapter_type,
                "route_profile_id": client.route_profile_id or None,
                "session_id": client.session_id or None,
                "sample_rate": 16_000,
                "chunk_ms": 100,
                "connected_at": client.connected_at,
                "last_audio_at": client.last_audio_at or None,
                "last_sequence": client.last_sequence,
                "last_chunk_id": client.last_chunk_id or None,
                "last_chunk_bytes": client.last_chunk_bytes,
                "last_chunk_sha256": client.last_chunk_sha256 or None,
                "received_bytes": client.received_bytes,
                "accepted_chunks": client.accepted_chunks,
                "selected": client.id == self._selected_client_id,
                "online": True,
                "virtual": True,
            })
        clients = sorted(
            rows,
            key=lambda item: (not bool(item["selected"]), str(item["name"]).lower()),
        )
        selected_online = (
            self._selected_client_id in self._clients
            or self._selected_client_id in self._virtual_clients
        ) if self._selected_client_id else True
        return {
            "ok": True,
            "rabilink_chunk_protocol": {
                "version": 2,
                "durable_ack_tuple": True,
                "cross_process_claim": True,
                "ambiguous_replay_policy": "retain_without_ack",
                "ambiguous_resolution": "explicit_operator_decision",
            },
            "durable_chunk_ledger": self._durable_chunk_ledger.maintenance_snapshot(),
            "enabled": self.config.enabled,
            "listening": self._server is not None,
            "host": self.config.host if self.config.enabled else "",
            "port": self.config.port if self.config.enabled else 0,
            "discovery_port": self.config.discovery_port if self.config.enabled else 0,
            "source": self.source,
            "selected_client_id": self._selected_client_id,
            "selected_online": selected_online,
            "capture_enabled": self._capture_enabled,
            "clients": clients,
            "events": self.list_events(limit=100),
            "checked_at": now,
        }

    async def select(self, source: str, client_id: str | None = None) -> dict[str, object]:
        normalized = str(source or "").strip().lower()
        if normalized == "local":
            self._selected_client_id = None
        elif normalized == "remote":
            selected = str(client_id or "").strip()
            if not selected:
                raise ValueError("A remote audio client id is required.")
            if selected not in self._clients and selected not in self._virtual_clients:
                raise ValueError("The selected remote audio client is not online.")
            self._selected_client_id = selected
        else:
            raise ValueError("Audio stream source must be local or remote.")
        self._write_selection()
        await self._sync_capture_commands()
        self._append_event(
            direction="system",
            kind="selection_changed",
            message="已切换到本机音频" if self._selected_client_id is None else "已选择远端音频设备",
            client_id=self._selected_client_id or "",
        )
        result = self.snapshot()
        self._emit_changed()
        return result

    def start_virtual_client(
        self,
        *,
        client_id: str,
        name: str,
        kind: str,
        message_adapter_type: str,
        device_model: str = "",
        source_device_id: str = "",
        route_profile_id: str = "",
        session_id: str = "",
        resume_running: bool = False,
    ) -> dict[str, object]:
        normalized_id = _safe_id(client_id)
        normalized_source_device_id = _safe_id(source_device_id or normalized_id)
        received_bytes, accepted_chunks = self._virtual_pcm_totals_by_source.get(
            normalized_source_device_id,
            (0, 0),
        )
        previous_virtual = self._virtual_clients.get(normalized_id)
        if previous_virtual is not None and previous_virtual.source_device_id != normalized_source_device_id:
            raise ValueError("RabiLink stable stream id is already owned by another source device.")
        repeated_start = previous_virtual is not None
        if previous_virtual is not None:
            previous_virtual.name = str(name or normalized_id).strip()[:100] or normalized_id
            previous_virtual.kind = _safe_kind(kind)
            previous_virtual.device_model = str(device_model or "").strip()[:100]
            previous_virtual.message_adapter_type = _message_adapter_type(message_adapter_type, previous_virtual.kind)
            previous_virtual.route_profile_id = str(route_profile_id or "").strip()[:200]
            previous_virtual.session_id = str(session_id or "").strip()[:200]
        else:
            self._virtual_clients[normalized_id] = _VirtualClient(
                id=normalized_id,
                name=str(name or normalized_id).strip()[:100] or normalized_id,
                kind=_safe_kind(kind),
                device_model=str(device_model or "").strip()[:100],
                source_device_id=normalized_source_device_id,
                message_adapter_type=_message_adapter_type(message_adapter_type, _safe_kind(kind)),
                route_profile_id=str(route_profile_id or "").strip()[:200],
                session_id=str(session_id or "").strip()[:200],
                connected_at=time.time(),
                received_bytes=received_bytes,
                accepted_chunks=accepted_chunks,
                resume_running=resume_running,
            )
        if self._selected_client_id is None:
            # Preserve the single-phone zero-configuration experience. Later
            # phones register without stealing the explicit/persisted choice.
            self._selected_client_id = normalized_id
            self._write_selection()
        elif (
            self._selected_client_id != normalized_id
            and isinstance(self._virtual_clients.get(self._selected_client_id), _VirtualClient)
            and self._virtual_clients[self._selected_client_id].source_device_id == normalized_source_device_id
        ):
            # A rebuilt stream registers before the old stream is stopped. Move
            # selection while both records exist so the same physical source
            # stays online through the handoff.
            self._selected_client_id = normalized_id
            self._write_selection()
        elif (
            self._selected_client_id
            and self._selected_client_id not in self._clients
            and self._selected_client_id not in self._virtual_clients
            and self._selected_client_id.startswith(f"{normalized_source_device_id}-")
        ):
            # Migrate the old per-session RabiLink stream selection to the new
            # stable stream id without allowing an unrelated phone to steal it.
            self._selected_client_id = normalized_id
            self._write_selection()
        if not repeated_start:
            self._append_event(
                direction="system",
                kind="client_connected",
                message="RabiLink 远端音频设备已连接",
                client_id=normalized_id,
            )
        result = self.snapshot()
        self._emit_changed()
        return result

    def feed_virtual_client(
        self,
        client_id: str,
        payload: bytes,
        *,
        sequence: int,
        chunk_id: str | None = None,
    ) -> bool:
        client = self._virtual_clients.get(_safe_id(client_id))
        if client is None:
            return False
        if not payload or len(payload) % 2:
            return False
        if sequence <= 0:
            raise ValueError("RabiLink audio chunk sequence must be a positive integer.")
        normalized_chunk_id = str(chunk_id or "").strip()[:200]
        if not normalized_chunk_id:
            raise ValueError("RabiLink audio chunk id is required for durable acknowledgement.")
        chunk_sha256 = hashlib.sha256(payload).hexdigest()
        if sequence == client.last_sequence:
            if (
                client.last_chunk_id != normalized_chunk_id
                or client.last_chunk_bytes != len(payload)
                or client.last_chunk_sha256 != chunk_sha256
            ):
                raise ValueError(
                    f"RabiLink audio chunk {sequence} retry conflicts with its id, byte count, or checksum."
                )
            client.last_audio_at = time.time()
            return True
        expected = client.last_sequence + 1
        if sequence != expected:
            raise ValueError(f"RabiLink audio chunk sequence mismatch: expected {expected}, received {sequence}.")
        now = time.time()
        previous = self._last_virtual_chunk_by_source.get(client.source_device_id)
        if previous is not None and previous[0] == normalized_chunk_id:
            if previous[1:3] != (len(payload), chunk_sha256):
                raise ValueError(
                    f"RabiLink audio chunk id {normalized_chunk_id!r} retry conflicts with its byte count or checksum."
                )
            self._last_virtual_chunk_by_source[client.source_device_id] = (
                normalized_chunk_id,
                len(payload),
                chunk_sha256,
                now,
            )
            client.last_audio_at = now
            client.last_sequence = sequence
            client.last_chunk_id = normalized_chunk_id
            client.last_chunk_bytes = len(payload)
            client.last_chunk_sha256 = chunk_sha256
            return True
        if not (self._capture_enabled and self._selected_client_id == client.id and self._feed is not None):
            return False
        claim = self._durable_chunk_ledger.claim(
            client.source_device_id,
            normalized_chunk_id,
            len(payload),
            chunk_sha256,
            _stable_source_sequence(normalized_chunk_id),
            sequence,
            self._durable_chunk_owner_id,
            self._durable_chunk_lease_seconds,
        )
        if claim == "busy":
            raise ValueError(f"RabiLink audio chunk id {normalized_chunk_id!r} is being processed by another worker.")
        if claim == "ambiguous":
            raise ValueError(
                f"RabiLink audio chunk id {normalized_chunk_id!r} has an ambiguous prior ASR delivery; "
                "it remains unacknowledged to prevent duplicate transcription."
            )
        if claim == "processed":
            if client.last_sequence > 0:
                raise ValueError(
                    f"RabiLink audio chunk id {normalized_chunk_id!r} cannot be reused at a new sequence in one stream."
                )
            client.last_audio_at = now
            client.last_sequence = sequence
            client.last_chunk_id = normalized_chunk_id
            client.last_chunk_bytes = len(payload)
            client.last_chunk_sha256 = chunk_sha256
            return True
        if self._durable_chunk_cutpoint is not None:
            self._durable_chunk_cutpoint("claimed", client.source_device_id, normalized_chunk_id)
        samples = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
        # A deterministic crash before the callback remains recoverable. Once
        # the non-transactional ASR callback is entered, a crash is ambiguous
        # and must never be auto-refed without an explicit operator decision.
        if self._durable_chunk_cutpoint is not None:
            self._durable_chunk_cutpoint("delivery_started", client.source_device_id, normalized_chunk_id)
        self._durable_chunk_ledger.mark_delivery_started(
            client.source_device_id, normalized_chunk_id, self._durable_chunk_owner_id
        )
        self._feed(client.id, samples)
        if self._durable_chunk_cutpoint is not None:
            self._durable_chunk_cutpoint("feed_returned", client.source_device_id, normalized_chunk_id)
        self._durable_chunk_ledger.commit_processed(
            client.source_device_id, normalized_chunk_id, self._durable_chunk_owner_id
        )
        client.last_audio_at = time.time()
        client.last_sequence = sequence
        client.last_chunk_id = normalized_chunk_id
        client.last_chunk_bytes = len(payload)
        client.last_chunk_sha256 = chunk_sha256
        client.received_bytes += len(payload)
        client.accepted_chunks += 1
        self._virtual_pcm_totals_by_source[client.source_device_id] = (
            client.received_bytes,
            client.accepted_chunks,
        )
        if self._append_event(
            direction="inbound",
            kind="pcm_received",
            message="已从远端设备接收 PCM",
            client_id=client.id,
            byte_count=len(payload),
            total_bytes=client.received_bytes,
            stream_sequence=sequence,
            min_interval_seconds=1.0,
        ):
            self._emit_changed()
        self._last_virtual_chunk_by_source[client.source_device_id] = (
            normalized_chunk_id,
            len(payload),
            chunk_sha256,
            client.last_audio_at,
        )
        self._prune_virtual_chunk_sources()
        return True

    def resolve_ambiguous_chunk(
        self,
        source_device_id: str,
        chunk_id: str,
        accepted_bytes: int,
        sha256: str,
        decision: str,
        operator: str = "loopback_operator",
    ) -> dict[str, object]:
        return self._durable_chunk_ledger.resolve_ambiguous(
            source_device_id, chunk_id, accepted_bytes, sha256, decision, operator
        )

    def durable_tuple_page(
        self,
        source_device_id: str,
        *,
        after_source_sequence: int = 0,
        limit: int = 500,
    ) -> dict[str, object]:
        return self._durable_chunk_ledger.tuple_page(
            source_device_id,
            after_source_sequence=after_source_sequence,
            limit=limit,
        )

    def retire_durable_source(
        self,
        source_device_id: str,
        *,
        phone_spool_empty: bool,
        maximum_phone_retention_elapsed: bool,
        operator_confirmation: str,
    ) -> dict[str, object]:
        if any(client.source_device_id == source_device_id for client in self._virtual_clients.values()):
            raise ValueError("Disconnect every active RabiLink stream before retiring its durable source.")
        result = self._durable_chunk_ledger.retire_source(
            source_device_id,
            phone_spool_empty=phone_spool_empty,
            maximum_phone_retention_elapsed=maximum_phone_retention_elapsed,
            operator_confirmation=operator_confirmation,
        )
        self._last_virtual_chunk_by_source.pop(source_device_id, None)
        self._virtual_pcm_totals_by_source.pop(source_device_id, None)
        return result

    def _prune_virtual_chunk_sources(self) -> None:
        excess = len(self._last_virtual_chunk_by_source) - _VIRTUAL_CHUNK_DEDUP_MAX_SOURCES
        if excess <= 0:
            return
        oldest = sorted(self._last_virtual_chunk_by_source.items(), key=lambda item: item[1][3])[:excess]
        for key, _ in oldest:
            self._last_virtual_chunk_by_source.pop(key, None)

    def stop_virtual_client(self, client_id: str) -> tuple[dict[str, object], bool]:
        client = self._virtual_clients.pop(_safe_id(client_id), None)
        if client is None:
            return self.snapshot(), False
        resume_running = client.resume_running
        self._append_event(
            direction="system",
            kind="client_disconnected",
            message="RabiLink 远端音频设备已断开",
            client_id=client.id,
            total_bytes=client.received_bytes,
            stream_sequence=client.last_sequence,
            source_device_id=client.source_device_id,
            device_model=client.device_model,
        )
        result = self.snapshot()
        self._emit_changed()
        return result, resume_running

    def stale_virtual_client_id(
        self,
        timeout_seconds: float,
        *,
        client_id: str | None = None,
        now: float | None = None,
    ) -> str | None:
        client = self._virtual_clients.get(_safe_id(client_id)) if client_id else self._selected_virtual_client()
        if client is None:
            return None
        deadline_base = client.last_audio_at or client.connected_at
        checked_at = time.time() if now is None else now
        return client.id if checked_at - deadline_base >= timeout_seconds else None

    async def start_capture(self, sample_rate: int, chunk_ms: int) -> None:
        self._capture_enabled = True
        self._capture_sample_rate = sample_rate
        self._capture_chunk_ms = chunk_ms
        selected_virtual = self._selected_client_id in self._virtual_clients
        if self._selected_client_id and self._selected_client_id not in self._clients and not selected_virtual:
            raise RuntimeError("The selected remote audio client is offline.")
        await self._sync_capture_commands()
        self._emit_changed()

    async def stop_capture(self) -> None:
        self._capture_enabled = False
        await self._sync_capture_commands()
        self._emit_changed()

    def play(self, path: Path, volume: int, cancel: threading.Event) -> None:
        client_id = self._selected_client_id
        if client_id in self._virtual_clients:
            self._local_player(path, volume, cancel)
            return
        if not client_id:
            self._local_player(path, volume, cancel)
            return
        loop = self._loop
        if loop is None or not loop.is_running():
            raise RuntimeError("Remote audio event loop is unavailable.")
        future = asyncio.run_coroutine_threadsafe(self._play_remote(client_id, path, volume, cancel), loop)
        future.result()

    def stop_playback(self) -> None:
        client_id = self._selected_client_id
        if client_id in self._virtual_clients:
            self._local_stopper()
            return
        loop = self._loop
        if not client_id or loop is None or not loop.is_running():
            self._local_stopper()
            return
        asyncio.run_coroutine_threadsafe(self._send_stop(client_id), loop)

    async def _handle_client(self, websocket: Any) -> None:
        if not self._authorized(websocket):
            await websocket.close(code=4401, reason="Unauthorized")
            return
        client: _Client | None = None
        try:
            raw_hello = await asyncio.wait_for(websocket.recv(), timeout=10)
            if not isinstance(raw_hello, str):
                raise ValueError("The first frame must be a JSON hello message.")
            hello = json.loads(raw_hello)
            if not isinstance(hello, dict) or hello.get("type") != "hello":
                raise ValueError("Missing audio client hello message.")
            client_id = _safe_id(hello.get("clientId"))
            name = str(hello.get("name") or client_id).strip()[:100] or client_id
            kind = _safe_kind(hello.get("deviceKind"))
            device_model = str(hello.get("deviceModel") or "").strip()[:100]
            # Network sound-card clients always belong to the standalone speech
            # endpoint. Only the loopback RabiLink virtual-stream API may create
            # a rabilink source, so an untrusted hello cannot change Route class.
            message_adapter_type = "speech"
            route_profile_id = str(hello.get("routeProfileId") or "").strip()[:200]
            session_id = str(hello.get("sessionId") or "").strip()[:200]
            sample_rate = int(hello.get("sampleRate") or 16_000)
            chunk_ms = int(hello.get("chunkMs") or 100)
            if sample_rate != 16_000 or not 20 <= chunk_ms <= 1_000:
                raise ValueError("Remote audio clients must stream mono PCM s16le at 16000 Hz.")
            previous = self._clients.get(client_id)
            if previous is not None:
                await previous.websocket.close(code=4009, reason="Replaced by a newer connection")
            client = _Client(
                id=client_id,
                name=name,
                kind=kind,
                device_model=device_model,
                message_adapter_type=message_adapter_type,
                route_profile_id=route_profile_id,
                session_id=session_id,
                websocket=websocket,
                sample_rate=sample_rate,
                chunk_ms=chunk_ms,
                connected_at=time.time(),
            )
            self._clients[client_id] = client
            await websocket.send(json.dumps({"type": "hello-accepted", "clientId": client_id}, ensure_ascii=False))
            await self._sync_capture_commands()
            self._append_event(
                direction="system",
                kind="client_connected",
                message="远端语音客户端已连接",
                client_id=client.id,
            )
            self._emit_changed()
            async for message in websocket:
                if isinstance(message, bytes):
                    self._handle_audio(client, message)
                else:
                    self._handle_control(client, message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            try:
                await websocket.close(code=4400, reason=str(exc)[:120])
            except Exception:
                pass
        finally:
            if client is not None and self._clients.get(client.id) is client:
                self._clients.pop(client.id, None)
                self._append_event(
                    direction="system",
                    kind="client_disconnected",
                    message="远端语音客户端已断开",
                    client_id=client.id,
                    total_bytes=client.received_bytes,
                    source_device_id=client.id,
                    device_model=client.device_model,
                )
                self._emit_changed()
                if client.playback_waiter and not client.playback_waiter.done():
                    client.playback_waiter.set_exception(RuntimeError("Remote audio client disconnected during playback."))

    def _authorized(self, websocket: Any) -> bool:
        request = getattr(websocket, "request", None)
        headers = getattr(request, "headers", {})
        authorization = str(headers.get("authorization") or "")
        supplied = authorization[7:].strip() if authorization.lower().startswith("bearer ") else str(headers.get("x-rabi-speech-token") or "").strip()
        return bool(supplied) and hmac.compare_digest(supplied, self.config.token)

    def _handle_audio(self, client: _Client, payload: bytes) -> None:
        if not self._capture_enabled or client.id != self._selected_client_id or not payload or len(payload) % 2:
            return
        client.last_audio_at = time.time()
        if self._feed is None:
            return
        samples = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
        self._feed(client.id, samples)
        client.received_bytes += len(payload)
        client.accepted_chunks += 1
        if self._append_event(
            direction="inbound",
            kind="pcm_received",
            message="已从远端设备接收 PCM",
            client_id=client.id,
            byte_count=len(payload),
            total_bytes=client.received_bytes,
            min_interval_seconds=1.0,
        ):
            self._emit_changed()

    def _handle_control(self, client: _Client, raw: str) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            return
        if not isinstance(message, dict):
            return
        if message.get("type") == "playback-complete" and str(message.get("id") or "") == client.playback_id:
            if client.playback_waiter and not client.playback_waiter.done():
                client.playback_waiter.set_result(None)
                self._append_event(
                    direction="receipt",
                    kind="playback_completed",
                    message="远端设备确认播放完成",
                    client_id=client.id,
                )
                self._emit_changed()

    async def _sync_capture_commands(self) -> None:
        for client in list(self._clients.values()):
            enabled = self._capture_enabled and client.id == self._selected_client_id
            try:
                await client.websocket.send(json.dumps({
                    "type": "capture",
                    "enabled": enabled,
                    "sampleRate": self._capture_sample_rate,
                    "chunkMs": self._capture_chunk_ms,
                }))
            except Exception:
                pass

    async def _play_remote(self, client_id: str, path: Path, volume: int, cancel: threading.Event) -> None:
        client = self._clients.get(client_id)
        if client is None:
            raise RuntimeError("The selected remote audio client is offline.")
        playback_id = uuid.uuid4().hex
        client.playback_id = playback_id
        client.playback_waiter = asyncio.get_running_loop().create_future()
        payload = path.read_bytes()
        await client.websocket.send(json.dumps({
            "type": "play",
            "id": playback_id,
            "contentType": "audio/wav",
            "bytes": len(payload),
            "volume": int(volume),
        }))
        await client.websocket.send(payload)
        self._append_event(
            direction="outbound",
            kind="audio_sent",
            message="已向远端设备发送 WAV",
            client_id=client.id,
            byte_count=len(payload),
        )
        self._emit_changed()
        while not cancel.is_set():
            try:
                await asyncio.wait_for(asyncio.shield(client.playback_waiter), timeout=0.2)
                return
            except asyncio.TimeoutError:
                continue
        await self._send_stop(client_id)

    async def _send_stop(self, client_id: str) -> None:
        client = self._clients.get(client_id)
        if client is None:
            return
        try:
            await client.websocket.send(json.dumps({"type": "stop-playback"}))
        except Exception:
            pass
        if client.playback_waiter and not client.playback_waiter.done():
            client.playback_waiter.set_result(None)

    def _read_selection(self) -> str | None:
        try:
            data = json.loads(self.config.settings_path.read_text(encoding="utf-8"))
            value = _safe_id(data.get("selected_client_id"), allow_empty=True) if isinstance(data, dict) else ""
            return value or None
        except (OSError, ValueError, json.JSONDecodeError):
            return None

    def _write_selection(self) -> None:
        self.config.settings_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.config.settings_path.with_suffix(self.config.settings_path.suffix + ".tmp")
        temporary.write_text(
            json.dumps({"version": 1, "selected_client_id": self._selected_client_id}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(self.config.settings_path)


def _safe_id(value: object, *, allow_empty: bool = False) -> str:
    text = str(value or "").strip()
    if allow_empty and not text:
        return ""
    if not text or len(text) > 100 or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in text):
        raise ValueError("Invalid remote audio client id.")
    return text


def _stable_source_sequence(chunk_id: str) -> int:
    """Extract the phone spool's durable sequence without guessing legacy ids."""
    prefix = "audio-"
    if not chunk_id.startswith(prefix):
        return 0
    value = chunk_id[len(prefix):]
    if not value.isdigit():
        return 0
    sequence = int(value)
    return sequence if sequence > 0 else 0


def _safe_operator(value: object) -> str:
    text = str(value or "loopback_operator").strip()
    if not text or len(text) > 100 or any(
        character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in text
    ):
        raise ValueError("Invalid RabiLink durable-audio operator id.")
    return text


def _safe_kind(value: object) -> str:
    text = str(value or "remote_audio_client").strip().lower().replace("-", "_")[:50]
    return text if text and all(character.isalnum() or character == "_" for character in text) else "remote_audio_client"


def _message_adapter_type(value: object, _device_kind: str) -> str:
    requested = str(value or "").strip().lower()
    return "rabilink" if requested == "rabilink" else "speech"


class _DiscoveryProtocol(asyncio.DatagramProtocol):
    def __init__(self, config: RemoteAudioServerConfig) -> None:
        self.config = config
        self.transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self.transport = transport  # type: ignore[assignment]

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        if data.strip() != b"RABI_VOICE_DISCOVER_V1" or self.transport is None:
            return
        payload = json.dumps({
            "service": "rabi-voice-stream",
            "version": 1,
            "name": self.config.service_name,
            "port": self.config.port,
            "transport": "ws",
            "authentication": "bearer",
        }, ensure_ascii=False).encode("utf-8")
        self.transport.sendto(payload, addr)
