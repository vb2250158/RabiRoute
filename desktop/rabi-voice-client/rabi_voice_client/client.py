from __future__ import annotations

import asyncio
import io
import json
import logging
import socket
import threading
import time
import wave
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np
import sounddevice as sd
from websockets.asyncio.client import connect

from .config import ClientConfig


@dataclass
class ClientState:
    connected: bool = False
    capture_enabled: bool = False
    playing: bool = False
    input_level: float = 0.0
    server_url: str = ""
    last_error: str = ""


class RabiVoiceClient:
    def __init__(
        self,
        config: ClientConfig,
        *,
        logger: logging.Logger | None = None,
        state_listener: Callable[[ClientState], None] | None = None,
    ) -> None:
        self.config = config
        self.state = ClientState()
        self.logger = logger or logging.getLogger("rabi-voice-client")
        self._stop = asyncio.Event()
        self._audio_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=50)
        self._input_stream: Any = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._pending_play: dict[str, Any] | None = None
        self._websocket: Any = None
        self._state_listener = state_listener
        self._last_level_notice = 0.0

    async def run(self) -> None:
        self._loop = asyncio.get_running_loop()
        while not self._stop.is_set():
            try:
                await self._run_connection()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._set_state(
                    connected=False,
                    capture_enabled=False,
                    input_level=0.0,
                    last_error=f"{type(exc).__name__}: {exc}",
                )
                self.logger.warning("audio stream disconnected: %s", self.state.last_error)
                await self._close_input()
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self.config.reconnect_seconds)
                except asyncio.TimeoutError:
                    pass

    async def stop(self) -> None:
        self._stop.set()
        await self._close_input()
        sd.stop()
        if self._websocket is not None:
            await self._websocket.close()

    def request_stop(self) -> None:
        loop = self._loop
        if loop is not None and loop.is_running():
            asyncio.run_coroutine_threadsafe(self.stop(), loop)

    async def _run_connection(self) -> None:
        server_url = self.config.server_url
        if server_url.lower() == "auto":
            server_url = await asyncio.to_thread(discover_server)
        self._set_state(server_url=server_url)
        async with connect(
            server_url,
            additional_headers={"Authorization": f"Bearer {self.config.token}"},
            max_size=32 * 1024 * 1024,
            ping_interval=20,
            ping_timeout=20,
        ) as websocket:
            self._websocket = websocket
            await websocket.send(json.dumps({
                "type": "hello",
                "clientId": self.config.client_id,
                "name": self.config.name,
                "deviceKind": "windows_pc",
                "sampleRate": self.config.sample_rate,
                "chunkMs": self.config.chunk_ms,
                "format": "pcm_s16le",
                "channels": 1,
            }, ensure_ascii=False))
            accepted = json.loads(await asyncio.wait_for(websocket.recv(), timeout=10))
            if not isinstance(accepted, dict) or accepted.get("type") != "hello-accepted":
                raise RuntimeError("RabiSpeech did not accept the audio client handshake.")
            self._set_state(connected=True, last_error="")
            self.logger.info("connected as %s", self.config.client_id)
            sender = asyncio.create_task(self._send_audio(websocket), name="rabi-voice-send")
            try:
                async for message in websocket:
                    if isinstance(message, bytes):
                        await self._play_binary(websocket, message)
                    else:
                        await self._handle_control(websocket, message)
            finally:
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)
                self._set_state(connected=False, capture_enabled=False, input_level=0.0)
                self._websocket = None
                await self._close_input()

    async def _handle_control(self, websocket: Any, raw: str) -> None:
        message = json.loads(raw)
        if not isinstance(message, dict):
            return
        kind = message.get("type")
        if kind == "capture":
            enabled = bool(message.get("enabled"))
            self._set_state(capture_enabled=enabled, input_level=0.0 if not enabled else self.state.input_level)
            if enabled:
                await self._open_input()
            else:
                await self._close_input()
        elif kind == "play":
            self._pending_play = message
        elif kind == "stop-playback":
            sd.stop()
            self._set_state(playing=False)

    async def _open_input(self) -> None:
        if self._input_stream is not None:
            return
        blocksize = max(1, round(self.config.sample_rate * self.config.chunk_ms / 1000))
        self._input_stream = sd.InputStream(
            device=self.config.input_device,
            channels=1,
            samplerate=self.config.sample_rate,
            blocksize=blocksize,
            dtype="int16",
            callback=self._audio_callback,
        )
        self._input_stream.start()

    async def _close_input(self) -> None:
        stream, self._input_stream = self._input_stream, None
        if stream is not None:
            await asyncio.to_thread(stream.stop)
            await asyncio.to_thread(stream.close)

    def _audio_callback(self, indata: Any, _frames: int, _time_info: Any, status: Any) -> None:
        if status:
            self.logger.debug("input warning: %s", status)
        loop = self._loop
        if loop is None or not self.state.capture_enabled or self.state.playing:
            return
        samples = np.asarray(indata, dtype="<i2").reshape(-1)
        payload = samples.tobytes()
        now = time.monotonic()
        if now - self._last_level_notice >= 0.08:
            normalized = samples.astype(np.float32) / 32768.0
            level = float(np.sqrt(np.mean(np.square(normalized)))) if normalized.size else 0.0
            self._last_level_notice = now
            self._set_state(input_level=min(1.0, level * 8.0))
        try:
            loop.call_soon_threadsafe(self._queue_audio, payload)
        except RuntimeError:
            pass

    def _queue_audio(self, payload: bytes) -> None:
        if self._audio_queue.full():
            try:
                self._audio_queue.get_nowait()
                self._audio_queue.task_done()
            except asyncio.QueueEmpty:
                pass
        self._audio_queue.put_nowait(payload)

    async def _send_audio(self, websocket: Any) -> None:
        while True:
            payload = await self._audio_queue.get()
            try:
                if self.state.capture_enabled and not self.state.playing:
                    await websocket.send(payload)
            finally:
                self._audio_queue.task_done()

    async def _play_binary(self, websocket: Any, payload: bytes) -> None:
        metadata, self._pending_play = self._pending_play, None
        if not metadata or metadata.get("contentType") != "audio/wav":
            return
        playback_id = str(metadata.get("id") or "")
        volume = min(100, max(0, int(metadata.get("volume") or 100)))
        self._set_state(playing=True, input_level=0.0)
        try:
            await asyncio.to_thread(self._play_wav, payload, volume)
        finally:
            self._set_state(playing=False)
        await websocket.send(json.dumps({"type": "playback-complete", "id": playback_id}))

    def _play_wav(self, payload: bytes, volume: int) -> None:
        with wave.open(io.BytesIO(payload), "rb") as source:
            if source.getnchannels() not in {1, 2} or source.getsampwidth() != 2:
                raise ValueError("Remote playback currently requires 16-bit mono or stereo WAV.")
            channels = source.getnchannels()
            sample_rate = source.getframerate()
            audio = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
            if channels == 2:
                audio = audio.reshape(-1, 2)
        if volume != 100:
            audio = audio * (volume / 100.0)
        sd.play(audio, sample_rate, device=self.config.output_device, blocking=True)

    def _set_state(self, **changes: Any) -> None:
        changed = False
        for key, value in changes.items():
            if getattr(self.state, key) != value:
                setattr(self.state, key, value)
                changed = True
        if changed and self._state_listener is not None:
            self._state_listener(ClientState(**vars(self.state)))


def list_audio_devices() -> str:
    return str(sd.query_devices())


def discover_server(*, port: int = 8783, timeout_seconds: float = 2.0) -> str:
    request = b"RABI_VOICE_DISCOVER_V1"
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.settimeout(timeout_seconds)
        sock.bind(("", 0))
        sock.sendto(request, ("255.255.255.255", port))
        while True:
            payload, address = sock.recvfrom(4096)
            try:
                response = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(response, dict) or response.get("service") != "rabi-voice-stream":
                continue
            stream_port = int(response.get("port") or 8782)
            return f"ws://{address[0]}:{stream_port}"
