from __future__ import annotations

import asyncio
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


RemoteFeed = Callable[[str, np.ndarray], None]
LocalPlayer = Callable[[Path, int, threading.Event], None]
LocalStopper = Callable[[], None]


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
    websocket: Any
    sample_rate: int
    chunk_ms: int
    connected_at: float
    last_audio_at: float = 0.0
    playback_waiter: asyncio.Future[None] | None = None
    playback_id: str = ""


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
    ) -> None:
        self.config = config
        self._local_player = local_player
        self._local_stopper = local_stopper
        self._feed: RemoteFeed | None = None
        self._clients: dict[str, _Client] = {}
        self._server: Any = None
        self._discovery_transport: asyncio.DatagramTransport | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._capture_enabled = False
        self._capture_sample_rate = 16_000
        self._capture_chunk_ms = 100
        self._selected_client_id = self._read_selection()

    @property
    def selected_client_id(self) -> str | None:
        return self._selected_client_id

    @property
    def source(self) -> str:
        return "remote" if self._selected_client_id else "local"

    def set_feed(self, callback: RemoteFeed) -> None:
        self._feed = callback

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
        clients = sorted(
            (
                {
                    "id": client.id,
                    "name": client.name,
                    "sample_rate": client.sample_rate,
                    "chunk_ms": client.chunk_ms,
                    "connected_at": client.connected_at,
                    "last_audio_at": client.last_audio_at or None,
                    "selected": client.id == self._selected_client_id,
                    "online": True,
                }
                for client in self._clients.values()
            ),
            key=lambda item: (not bool(item["selected"]), str(item["name"]).lower()),
        )
        selected_online = self._selected_client_id in self._clients if self._selected_client_id else True
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
            if selected not in self._clients:
                raise ValueError("The selected remote audio client is not online.")
            self._selected_client_id = selected
        else:
            raise ValueError("Audio stream source must be local or remote.")
        self._write_selection()
        await self._sync_capture_commands()
        return self.snapshot()

    async def start_capture(self, sample_rate: int, chunk_ms: int) -> None:
        self._capture_enabled = True
        self._capture_sample_rate = sample_rate
        self._capture_chunk_ms = chunk_ms
        if self._selected_client_id and self._selected_client_id not in self._clients:
            raise RuntimeError("The selected remote audio client is offline.")
        await self._sync_capture_commands()

    async def stop_capture(self) -> None:
        self._capture_enabled = False
        await self._sync_capture_commands()

    def play(self, path: Path, volume: int, cancel: threading.Event) -> None:
        client_id = self._selected_client_id
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
            sample_rate = int(hello.get("sampleRate") or 16_000)
            chunk_ms = int(hello.get("chunkMs") or 100)
            if sample_rate != 16_000 or not 20 <= chunk_ms <= 1_000:
                raise ValueError("Remote audio clients must stream mono PCM s16le at 16000 Hz.")
            previous = self._clients.get(client_id)
            if previous is not None:
                await previous.websocket.close(code=4009, reason="Replaced by a newer connection")
            client = _Client(client_id, name, websocket, sample_rate, chunk_ms, time.time())
            self._clients[client_id] = client
            await websocket.send(json.dumps({"type": "hello-accepted", "clientId": client_id}, ensure_ascii=False))
            await self._sync_capture_commands()
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
