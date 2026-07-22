from __future__ import annotations

import asyncio
import json
import math
import tempfile
import time
import wave
from collections import deque
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Awaitable, Callable

import numpy as np

from .contracts import TranscriptionResult


@dataclass(frozen=True)
class MicrophoneConfig:
    enabled: bool = False
    device: int | str | None = None
    sample_rate: int = 16_000
    chunk_ms: int = 100
    pre_roll_ms: int = 1_500
    record_threshold: float = 0.01
    transcribe_threshold: float = 0.015
    adaptive_threshold: bool = True
    adaptive_multiplier: float = 2.5
    adaptive_margin: float = 0.004
    silence_ms: int = 500
    min_utterance_ms: int = 1_000
    max_utterance_ms: int = 60_000
    input_gain: float = 1.0
    asr_model: str = "faster-whisper/small"
    language: str | None = "zh"
    prompt: str | None = None
    auto_submit: bool = True
    route_id: str | None = None
    session_id: str = "rabispeech-microphone"
    suppress_during_playback: bool = True

    @classmethod
    def from_mapping(cls, value: object, fallback: "MicrophoneConfig | None" = None) -> "MicrophoneConfig":
        current = fallback or cls()
        data = value if isinstance(value, dict) else {}
        device = data.get("device", current.device)
        if isinstance(device, bool):
            device = None
        elif isinstance(device, str):
            device = device.strip() or None
            if isinstance(device, str) and device.isdigit():
                device = int(device)
        legacy_route_id = _optional_text(data.get("route_id"), 200)
        session_id = _text(data.get("session_id"), current.session_id, 200) or current.session_id
        if legacy_route_id and session_id == f"speech-{legacy_route_id}":
            session_id = cls().session_id
        config = cls(
            enabled=_boolean(data.get("enabled"), current.enabled),
            device=device if isinstance(device, (int, str)) else None,
            sample_rate=_integer(data.get("sample_rate"), current.sample_rate, 8_000, 48_000),
            chunk_ms=_integer(data.get("chunk_ms"), current.chunk_ms, 20, 1_000),
            pre_roll_ms=_integer(data.get("pre_roll_ms"), current.pre_roll_ms, 0, 5_000),
            record_threshold=_number(data.get("record_threshold"), current.record_threshold, 0.0001, 1.0),
            transcribe_threshold=_number(data.get("transcribe_threshold"), current.transcribe_threshold, 0.0001, 1.0),
            adaptive_threshold=_boolean(data.get("adaptive_threshold"), current.adaptive_threshold),
            adaptive_multiplier=_number(data.get("adaptive_multiplier"), current.adaptive_multiplier, 1.0, 10.0),
            adaptive_margin=_number(data.get("adaptive_margin"), current.adaptive_margin, 0.0, 0.5),
            silence_ms=_integer(data.get("silence_ms"), current.silence_ms, 100, 10_000),
            min_utterance_ms=_integer(data.get("min_utterance_ms"), current.min_utterance_ms, 50, 10_000),
            max_utterance_ms=_integer(data.get("max_utterance_ms"), current.max_utterance_ms, 1_000, 300_000),
            input_gain=_number(data.get("input_gain"), current.input_gain, 0.1, 10.0),
            asr_model=_text(data.get("asr_model"), current.asr_model, 200) or current.asr_model,
            language=_optional_text(data.get("language", current.language), 40),
            prompt=_optional_text(data.get("prompt", current.prompt), 2_000),
            # Resident transcripts always enter Manager's broadcast endpoint.
            # Keep these fields only for backward-compatible status payloads.
            auto_submit=True,
            route_id=None,
            session_id=session_id,
            suppress_during_playback=_boolean(data.get("suppress_during_playback"), current.suppress_during_playback),
        )
        if config.transcribe_threshold < config.record_threshold:
            config = replace(config, transcribe_threshold=config.record_threshold)
        if config.max_utterance_ms <= config.min_utterance_ms:
            config = replace(config, max_utterance_ms=max(1_000, config.min_utterance_ms + 500))
        return config

    def public(self) -> dict[str, object]:
        return asdict(self)


Transcriber = Callable[[Path, MicrophoneConfig], Awaitable[TranscriptionResult]]
Submitter = Callable[[str, str], Awaitable[dict[str, object]]]
StreamFactory = Callable[[MicrophoneConfig, Callable[..., None]], Any]
RecordTranscription = Callable[[TranscriptionResult, MicrophoneConfig, float], None]


class RemoteAudioController:
    selected_client_id: str | None

    async def start_capture(self, sample_rate: int, chunk_ms: int) -> None: ...

    async def stop_capture(self) -> None: ...


class MicrophoneService:
    """Host-resident microphone segmentation and ASR owned by RabiSpeech.

    PortAudio's callback only copies samples and schedules them on the service event loop.
    Segmentation, ASR, persistence, and one Manager broadcast submission stay serialized there.
    """

    def __init__(
        self,
        *,
        state_path: Path,
        temp_dir: Path,
        transcriber: Transcriber,
        submitter: Submitter,
        playback_active: Callable[[], bool],
        record_transcription: RecordTranscription | None = None,
        stream_factory: StreamFactory | None = None,
        remote_audio: RemoteAudioController | None = None,
    ) -> None:
        self.state_path = state_path.expanduser().resolve()
        self.temp_dir = temp_dir.expanduser().resolve()
        self._transcriber = transcriber
        self._submitter = submitter
        self._playback_active = playback_active
        self._record_transcription = record_transcription
        self._stream_factory = stream_factory or _sounddevice_stream
        self._remote_audio = remote_audio
        self.config = self._read_config()
        self._lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stream: Any = None
        self._consumer: asyncio.Task[None] | None = None
        self._phrases: asyncio.Queue[tuple[np.ndarray, float, float]] = asyncio.Queue(maxsize=8)
        self._running = False
        self._state = "stopped"
        self._error = ""
        self._last_submit_error = ""
        self._level = 0.0
        self._display_level = 0.0
        self._level_history: deque[float] = deque(maxlen=120)
        self._noise_floor = max(0.0005, self.config.record_threshold / 3.0)
        self._dynamic_threshold = self.config.record_threshold
        self._utterance_active = False
        self._pre_chunks: deque[np.ndarray] = deque()
        self._pre_samples = 0
        self._utterance_chunks: list[np.ndarray] = []
        self._utterance_samples = 0
        self._voiced_samples = 0
        self._silence_samples = 0
        self._peak = 0.0
        self._started_at = 0.0
        self._history: deque[dict[str, object]] = deque(maxlen=50)
        self._events: deque[dict[str, object]] = deque(maxlen=100)
        self._event_sequence = 0
        self._captured = 0
        self._recognized = 0
        self._empty = 0
        self._delivered = 0
        self._recorded = 0
        self._delivery_failed = 0
        self._submitted = 0
        self._submit_failed = 0
        self._dropped = 0

    async def restore(self) -> None:
        if not self.config.enabled:
            return
        try:
            await self.start({}, persist=False)
        except Exception as exc:
            self._state = "error"
            self._error = f"{type(exc).__name__}: {exc}"

    async def start(self, updates: object = None, *, persist: bool = True) -> dict[str, object]:
        async with self._lock:
            if self._running:
                if updates:
                    raise RuntimeError("Stop the resident microphone before changing its configuration.")
                return self.snapshot()
            self.config = replace(MicrophoneConfig.from_mapping(updates, self.config), enabled=True)
            self._reset_segment()
            self._display_level = 0.0
            self._level_history.clear()
            self._noise_floor = max(0.0005, self.config.record_threshold / 3.0)
            self._dynamic_threshold = self.config.record_threshold
            self._loop = asyncio.get_running_loop()
            self._state = "starting"
            self._error = ""
            try:
                if self._remote_audio is not None and self._remote_audio.selected_client_id:
                    await self._remote_audio.start_capture(self.config.sample_rate, self.config.chunk_ms)
                else:
                    self._stream = self._stream_factory(self.config, self._audio_callback)
                    self._stream.start()
            except Exception as exc:
                self._stream = None
                self._state = "error"
                self._error = f"{type(exc).__name__}: {exc}"
                self._emit_event("microphone", "microphone_start_failed", "麦克风启动失败", level="error", error=self._error)
                raise RuntimeError(f"Microphone start failed: {exc}") from exc
            self._running = True
            self._state = "listening"
            self._consumer = asyncio.create_task(self._consume(), name="rabispeech-microphone-asr")
            if persist:
                self._write_config()
            self._emit_event(
                "microphone",
                "microphone_started",
                "麦克风常驻监听已启动",
                device=self.config.device,
                audio_source="remote" if self._remote_audio is not None and self._remote_audio.selected_client_id else "local",
                remote_client_id=self._remote_audio.selected_client_id if self._remote_audio is not None else None,
                asr_model=self.config.asr_model,
                broadcast=True,
            )
            return self.snapshot()

    async def update_settings(self, updates: object = None) -> dict[str, object]:
        was_running = self._running
        if was_running:
            await self.stop(persist=False)
            await self.start(updates or {}, persist=True)
        else:
            async with self._lock:
                self.config = replace(MicrophoneConfig.from_mapping(updates, self.config), enabled=False)
                self._write_config()
        self._emit_event(
            "microphone",
            "microphone_settings_updated",
            "主机语音设置已更新",
            running=self._running,
            asr_model=self.config.asr_model,
        )
        return self.snapshot()

    async def stop(self, *, persist: bool = True) -> dict[str, object]:
        async with self._lock:
            self._running = False
            stream, self._stream = self._stream, None
            if stream is not None:
                try:
                    stream.stop()
                finally:
                    stream.close()
            if self._remote_audio is not None:
                await self._remote_audio.stop_capture()
            consumer, self._consumer = self._consumer, None
            if consumer is not None:
                consumer.cancel()
                try:
                    await consumer
                except asyncio.CancelledError:
                    pass
            while not self._phrases.empty():
                try:
                    self._phrases.get_nowait()
                    self._phrases.task_done()
                except asyncio.QueueEmpty:
                    break
            self._reset_segment()
            self._level = 0.0
            self._state = "stopped"
            self._error = ""
            self.config = replace(self.config, enabled=False)
            if persist:
                self._write_config()
            self._emit_event("microphone", "microphone_stopped", "麦克风常驻监听已停止")
            return self.snapshot()

    def snapshot(self) -> dict[str, object]:
        return {
            "ok": True,
            "mode": "host_resident",
            "audio_stream": {
                "source": "remote" if self._remote_audio is not None and self._remote_audio.selected_client_id else "local",
                "client_id": self._remote_audio.selected_client_id if self._remote_audio is not None else None,
            },
            "running": self._running,
            "state": self._state,
            "error": self._error,
            "last_submit_error": self._last_submit_error,
            "level": round(self._level, 6),
            "level_history": list(self._level_history),
            "noise_floor": round(self._noise_floor, 6),
            "dynamic_threshold": round(self._dynamic_threshold, 6),
            "utterance_active": self._utterance_active,
            "pending": self._phrases.qsize(),
            "dropped": self._dropped,
            "stats": {
                "captured": self._captured,
                "recognized": self._recognized,
                "empty": self._empty,
                "delivered": self._delivered,
                "recorded": self._recorded,
                "delivery_failed": self._delivery_failed,
                "submitted": self._submitted,
                "submit_failed": self._submit_failed,
                "dropped": self._dropped,
            },
            "config": self.config.public(),
            "history": list(self._history),
            "events": list(self._events),
        }

    def _emit_event(self, stage: str, kind: str, message: str, *, level: str = "info", **details: object) -> None:
        self._event_sequence += 1
        self._events.appendleft(
            {
                "sequence": self._event_sequence,
                "time": time.time(),
                "stage": stage,
                "kind": kind,
                "level": level,
                "message": message,
                "details": {key: value for key, value in details.items() if value is not None},
            }
        )

    @staticmethod
    def devices() -> list[dict[str, object]]:
        try:
            import sounddevice as sd
        except ImportError as exc:
            raise RuntimeError("sounddevice is not installed. Run scripts/install.ps1.") from exc
        default_input = None
        try:
            default_input = int(sd.default.device[0])
        except (TypeError, ValueError, IndexError):
            pass
        rows: list[dict[str, object]] = []
        for index, raw in enumerate(sd.query_devices()):
            detail = dict(raw)
            channels = int(detail.get("max_input_channels") or 0)
            if channels <= 0:
                continue
            rows.append(
                {
                    "index": index,
                    "name": str(detail.get("name") or f"Input {index}"),
                    "channels": channels,
                    "default_sample_rate": int(float(detail.get("default_samplerate") or 0)),
                    "default": index == default_input,
                }
            )
        return rows

    def feed_for_test(self, samples: np.ndarray) -> None:
        """Deterministic segmentation hook; production audio enters through PortAudio."""
        self._ingest(np.asarray(samples, dtype=np.float32).reshape(-1))

    def feed_remote(self, client_id: str, samples: np.ndarray) -> None:
        if self._remote_audio is None or client_id != self._remote_audio.selected_client_id:
            return
        self._ingest(np.asarray(samples, dtype=np.float32).reshape(-1))

    def _audio_callback(self, indata: Any, _frames: int, _time_info: Any, status: Any) -> None:
        loop = self._loop
        if loop is None or loop.is_closed() or not self._running:
            return
        chunk = np.asarray(indata, dtype=np.float32)
        if chunk.ndim > 1:
            chunk = chunk[:, 0]
        copied = chunk.copy()
        try:
            loop.call_soon_threadsafe(self._ingest, copied, str(status or ""))
        except RuntimeError:
            return

    def _ingest(self, chunk: np.ndarray, status: str = "") -> None:
        if not self._running or chunk.size == 0:
            return
        if status:
            self._error = f"Audio warning: {status}"[:500]
        if self.config.input_gain != 1.0:
            chunk = np.clip(chunk * self.config.input_gain, -1.0, 1.0)
        level = _rms(chunk)
        self._level = level
        self._display_level = self._display_level * 0.75 + level * 0.25
        self._level_history.append(round(self._display_level, 6))
        if self.config.suppress_during_playback and self._playback_active():
            if self._state != "playback_suppressed":
                self._emit_event("microphone", "playback_suppressed", "检测到主机播放，暂时抑制麦克风触发")
            self._reset_segment()
            self._state = "playback_suppressed"
            return
        if self._state == "playback_suppressed":
            self._state = "listening"
            self._emit_event("microphone", "playback_resumed", "主机播放结束，恢复麦克风监听")

        if not self._utterance_active:
            self._append_pre_roll(chunk)
            self._dynamic_threshold = (
                max(self.config.record_threshold, self._noise_floor * self.config.adaptive_multiplier + self.config.adaptive_margin)
                if self.config.adaptive_threshold
                else self.config.record_threshold
            )
            if level < self._dynamic_threshold:
                if self.config.adaptive_threshold:
                    self._noise_floor = self._noise_floor * 0.95 + level * 0.05
                return
            self._utterance_active = True
            self._utterance_chunks = list(self._pre_chunks)
            self._utterance_samples = self._pre_samples
            self._pre_chunks.clear()
            self._pre_samples = 0
            self._started_at = time.time() - self._utterance_samples / self.config.sample_rate
            self._peak = level
            self._voiced_samples = chunk.size
            self._silence_samples = 0
            self._state = "recording"
            self._emit_event(
                "vad",
                "utterance_started",
                "声音超过触发阈值，开始收音",
                level_value=round(level, 6),
                threshold=round(self._dynamic_threshold, 6),
            )
            return

        self._utterance_chunks.append(chunk.copy())
        self._utterance_samples += chunk.size
        self._peak = max(self._peak, level)
        if level >= self._dynamic_threshold:
            self._voiced_samples += chunk.size
        if level >= self.config.transcribe_threshold:
            self._silence_samples = 0
        else:
            self._silence_samples += chunk.size

        sample_rate = self.config.sample_rate
        min_samples = round(sample_rate * self.config.min_utterance_ms / 1000)
        silence_samples = round(sample_rate * self.config.silence_ms / 1000)
        max_samples = round(sample_rate * self.config.max_utterance_ms / 1000)
        phrase_done = self._silence_samples >= silence_samples
        if phrase_done or self._utterance_samples >= max_samples:
            self._finish_segment(min_voiced_samples=min_samples)

    def _append_pre_roll(self, chunk: np.ndarray) -> None:
        limit = round(self.config.sample_rate * self.config.pre_roll_ms / 1000)
        if limit <= 0:
            return
        self._pre_chunks.append(chunk.copy())
        self._pre_samples += chunk.size
        while self._pre_samples > limit and len(self._pre_chunks) > 1:
            self._pre_samples -= self._pre_chunks.popleft().size

    def _finish_segment(self, *, min_voiced_samples: int = 0) -> None:
        audio = np.concatenate(self._utterance_chunks).astype(np.float32) if self._utterance_chunks else np.array([], dtype=np.float32)
        peak = self._peak
        voiced_samples = self._voiced_samples
        started_at = self._started_at or time.time()
        duration = round(audio.size / self.config.sample_rate, 3) if self.config.sample_rate else 0.0
        voiced_duration = round(voiced_samples / self.config.sample_rate, 3) if self.config.sample_rate else 0.0
        self._reset_segment()
        self._state = "listening"
        if audio.size == 0 or peak < self.config.transcribe_threshold or voiced_samples < min_voiced_samples:
            self._emit_event(
                "vad",
                "segment_discarded",
                "片段未达到最短有效语音或转写阈值，已丢弃",
                level="warning",
                duration=duration,
                voiced_duration=voiced_duration,
                peak=round(peak, 6),
            )
            return
        try:
            self._phrases.put_nowait((audio, started_at, peak))
            self._captured += 1
            self._emit_event(
                "vad",
                "segment_queued",
                "语音片段已进入识别队列",
                duration=duration,
                peak=round(peak, 6),
                pending=self._phrases.qsize(),
            )
        except asyncio.QueueFull:
            self._dropped += 1
            self._emit_event("vad", "segment_dropped", "识别队列已满，语音片段被丢弃", level="error", duration=duration)

    def _reset_segment(self) -> None:
        self._utterance_active = False
        self._pre_chunks.clear()
        self._pre_samples = 0
        self._utterance_chunks = []
        self._utterance_samples = 0
        self._voiced_samples = 0
        self._silence_samples = 0
        self._peak = 0.0
        self._started_at = 0.0

    async def _consume(self) -> None:
        while True:
            audio, started_at, peak = await self._phrases.get()
            target: Path | None = None
            try:
                self._state = "transcribing"
                duration = round(audio.size / self.config.sample_rate, 3)
                self._emit_event(
                    "asr",
                    "transcription_started",
                    "开始语音识别",
                    duration=duration,
                    model=self.config.asr_model,
                )
                target = _write_wav(self.temp_dir, audio, self.config.sample_rate)
                result = await self._transcriber(target, self.config)
                text = result.text.strip()
                if not text:
                    self._empty += 1
                    self._emit_event("asr", "transcription_empty", "识别完成，但没有得到有效文字", level="warning", duration=duration)
                    self._state = "listening"
                    continue
                self._recognized += 1
                self._emit_event(
                    "asr",
                    "transcription_succeeded",
                    "语音识别完成",
                    provider=result.provider,
                    model=result.model,
                    duration=duration,
                    text_length=len(text),
                )
                item: dict[str, object] = {
                    "record_id": result.record_id,
                    "time": time.time(),
                    "started_at": started_at,
                    "duration": round(audio.size / self.config.sample_rate, 3),
                    "peak": round(peak, 6),
                    "text": text,
                    "provider": result.provider,
                    "model": result.model,
                    "segments": [asdict(segment) for segment in result.segments],
                    "submitted": False,
                }
                if self.config.auto_submit:
                    self._emit_event(
                        "route",
                        "route_submission_started",
                        "开始广播到已启用的语音消息端",
                        session_id=self.config.session_id,
                    )
                    try:
                        receipt = await self._submitter(text, self.config.session_id)
                        if not isinstance(receipt, dict):
                            raise RuntimeError("Manager returned no terminal broadcast receipt.")
                        delivery_status = str(receipt.get("status") or "").strip()
                        if delivery_status not in {"delivered", "recorded"}:
                            raise RuntimeError("Manager returned no delivered/recorded broadcast receipt.")
                        message_id = str(receipt.get("message_id") or receipt.get("messageId") or "").strip()
                        delivery_reason = str(receipt.get("reason") or "").strip()
                        deliveries = receipt.get("deliveries") if isinstance(receipt.get("deliveries"), list) else []
                        item["submitted"] = True
                        item["delivery_status"] = delivery_status
                        item["deliveries"] = deliveries
                        if message_id:
                            item["message_id"] = message_id
                        if delivery_reason:
                            item["delivery_reason"] = delivery_reason
                        self._submitted += 1
                        self._last_submit_error = ""
                        if deliveries:
                            for delivery in deliveries:
                                if not isinstance(delivery, dict):
                                    continue
                                route_id = str(delivery.get("routeId") or delivery.get("route_id") or "").strip()
                                route_status = str(delivery.get("status") or "").strip()
                                route_message_id = str(delivery.get("messageId") or delivery.get("message_id") or "").strip()
                                route_reason = str(delivery.get("reason") or "").strip()
                                route_detail = str(delivery.get("detail") or "").strip()
                                if route_status == "delivered":
                                    self._delivered += 1
                                    self._emit_event(
                                        "route",
                                        "route_delivery_succeeded",
                                        "Desktop 目标任务已接收语音消息",
                                        route_id=route_id,
                                        session_id=self.config.session_id,
                                        message_id=route_message_id,
                                    )
                                elif route_status == "recorded":
                                    self._recorded += 1
                                    self._emit_event(
                                        "route",
                                        "route_recorded_only",
                                        "语音已记录，未唤醒 Agent",
                                        route_id=route_id,
                                        session_id=self.config.session_id,
                                        message_id=route_message_id,
                                        reason=route_reason,
                                    )
                                elif route_status == "failed":
                                    self._delivery_failed += 1
                                    self._emit_event(
                                        "route",
                                        "route_submission_failed",
                                        "Route 投递失败",
                                        level="error",
                                        route_id=route_id,
                                        error=route_detail or route_reason or "Unknown Route delivery failure.",
                                    )
                        else:
                            self._recorded += 1
                            self._emit_event(
                                "route",
                                "route_recorded_only",
                                "语音已记录，当前没有启用的语音消息端",
                                session_id=self.config.session_id,
                                message_id=message_id,
                                reason=delivery_reason,
                            )
                    except Exception as exc:
                        self._delivery_failed += 1
                        self._submit_failed += 1
                        self._last_submit_error = f"{type(exc).__name__}: {exc}"[:500]
                        item["delivery_status"] = "failed"
                        item["submit_error"] = self._last_submit_error
                        self._emit_event(
                            "route",
                            "route_submission_failed",
                            "语音广播失败",
                            level="error",
                            error=self._last_submit_error,
                        )
                if self._record_transcription is not None:
                    try:
                        self._record_transcription(result, self.config, started_at)
                    except Exception as exc:
                        self._emit_event(
                            "storage",
                            "record_persistence_failed",
                            "语音记录写入失败，已保留本次转写与投递状态",
                            level="error",
                            session_id=self.config.session_id,
                            error=f"{type(exc).__name__}: {exc}"[:500],
                        )
                self._history.appendleft(item)
                self._error = ""
                self._state = "listening"
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._state = "error"
                self._error = f"{type(exc).__name__}: {exc}"[:500]
                self._emit_event("asr", "transcription_failed", "语音识别失败", level="error", error=self._error)
            finally:
                if target is not None:
                    target.unlink(missing_ok=True)
                self._phrases.task_done()

    def _read_config(self) -> MicrophoneConfig:
        if not self.state_path.is_file():
            return MicrophoneConfig()
        try:
            return MicrophoneConfig.from_mapping(json.loads(self.state_path.read_text(encoding="utf-8")))
        except (OSError, ValueError, json.JSONDecodeError):
            return MicrophoneConfig()

    def _write_config(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
        temporary.write_text(json.dumps(self.config.public(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(self.state_path)


def _sounddevice_stream(config: MicrophoneConfig, callback: Callable[..., None]) -> Any:
    try:
        import sounddevice as sd
    except ImportError as exc:
        raise RuntimeError("sounddevice is not installed. Run scripts/install.ps1.") from exc
    blocksize = max(1, round(config.sample_rate * config.chunk_ms / 1000))
    return sd.InputStream(
        device=config.device,
        channels=1,
        samplerate=config.sample_rate,
        blocksize=blocksize,
        dtype="float32",
        callback=callback,
    )


def _write_wav(temp_dir: Path, audio: np.ndarray, sample_rate: int) -> Path:
    temp_dir.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(prefix="rabispeech-mic-", suffix=".wav", dir=temp_dir, delete=False)
    target = Path(handle.name)
    handle.close()
    pcm = (np.clip(audio, -1.0, 1.0) * 32_767).astype("<i2").tobytes()
    try:
        with wave.open(str(target), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            output.writeframes(pcm)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return target


def _rms(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    return float(math.sqrt(float(np.mean(np.square(samples, dtype=np.float32)))))


def _boolean(value: object, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    return fallback if not text else text in {"1", "true", "yes", "on", "enabled"}


def _integer(value: object, fallback: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = fallback
    return min(maximum, max(minimum, parsed))


def _number(value: object, fallback: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = fallback
    if not math.isfinite(parsed):
        parsed = fallback
    return min(maximum, max(minimum, parsed))


def _text(value: object, fallback: str, limit: int) -> str:
    text = str(value if value is not None else fallback).strip()
    return text[:limit]


def _optional_text(value: object, limit: int) -> str | None:
    text = str(value or "").strip()
    return text[:limit] or None
