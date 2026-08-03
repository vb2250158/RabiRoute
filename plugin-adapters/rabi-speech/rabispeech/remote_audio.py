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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .audio_stream_events import AudioStreamEventStore


RemoteFeed = Callable[[str, np.ndarray], None]
LocalPlayer = Callable[[Path, int, threading.Event], None]
LocalStopper = Callable[[], None]


_VIRTUAL_CHUNK_DEDUP_MAX_SOURCES = 4096


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
    ) -> None:
        self.config = config
        self._local_player = local_player
        self._local_stopper = local_stopper
        self._event_sink = event_sink
        self._event_store = event_store
        self._feed: RemoteFeed | None = None
        self._clients: dict[str, _Client] = {}
        self._virtual_clients: dict[str, _VirtualClient] = {}
        self._last_virtual_chunk_by_source: dict[str, tuple[str, str, float]] = {}
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
        chunk_sha256 = hashlib.sha256(payload).hexdigest()
        if sequence == client.last_sequence:
            if client.last_chunk_sha256 != chunk_sha256:
                raise ValueError(f"RabiLink audio chunk {sequence} was retried with different PCM bytes.")
            client.last_audio_at = time.time()
            return True
        expected = client.last_sequence + 1
        if sequence != expected:
            raise ValueError(f"RabiLink audio chunk sequence mismatch: expected {expected}, received {sequence}.")
        normalized_chunk_id = str(chunk_id or "").strip()[:200]
        if normalized_chunk_id:
            now = time.time()
            previous = self._last_virtual_chunk_by_source.get(client.source_device_id)
            if previous is not None and previous[0] == normalized_chunk_id:
                if previous[1] != chunk_sha256:
                    raise ValueError(
                        f"RabiLink audio chunk id {normalized_chunk_id!r} was retried with different PCM bytes."
                    )
                self._last_virtual_chunk_by_source[client.source_device_id] = (
                    normalized_chunk_id,
                    chunk_sha256,
                    now,
                )
                client.last_audio_at = now
                client.last_sequence = sequence
                client.last_chunk_sha256 = chunk_sha256
                return True
        client.last_audio_at = time.time()
        client.last_sequence = sequence
        client.last_chunk_sha256 = chunk_sha256
        if self._capture_enabled and self._selected_client_id == client.id and self._feed is not None:
            samples = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
            self._feed(client.id, samples)
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
        if normalized_chunk_id:
            self._last_virtual_chunk_by_source[client.source_device_id] = (
                normalized_chunk_id,
                chunk_sha256,
                client.last_audio_at,
            )
            self._prune_virtual_chunk_sources()
        return True

    def _prune_virtual_chunk_sources(self) -> None:
        excess = len(self._last_virtual_chunk_by_source) - _VIRTUAL_CHUNK_DEDUP_MAX_SOURCES
        if excess <= 0:
            return
        oldest = sorted(self._last_virtual_chunk_by_source.items(), key=lambda item: item[1][2])[:excess]
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
