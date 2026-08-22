from __future__ import annotations

import asyncio
import base64
import binascii
import ipaddress
import logging
import mimetypes
import os
import socket
import tempfile
import time
from contextlib import asynccontextmanager, suppress
from dataclasses import asdict
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.background import BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from .audio import AudioTranscoder, subtitle_text
from .audio_stream_events import AudioStreamEventStore
from .config import Settings, load_settings
from .contracts import SpeechSynthesisRequest, TranscriptionRequest, TranscriptionResult
from .extensions import load_provider_extensions
from .events import SpeechEventHub
from .model_discovery import api_index, model_rows, public_capabilities
from .microphone import MicrophoneConfig, MicrophoneService, SpeechInputSource, SpeechUtteranceMetadata
from .persona_voice import (
    persona_speech_defaults_for_role,
    persona_tts_cache_dir,
    resolve_persona_role_dir,
)
from .playback import PlaybackCoordinator
from .providers import ApiAsrProvider, ApiTtsProvider, DashScopeAsrProvider, DashScopeTtsProvider, FasterWhisperProvider, LocalHttpAsrProvider, LocalTtsProvider
from .registry import ProviderRegistry
from .remote_audio import RemoteAudioHub, RemoteAudioServerConfig
from .speech_records import SpeechRecordStore
from .speaker_profiles import (
    SpeakerProfileRegistry,
    SpeakerRegistryConflictError,
    SpeakerRegistryNotFoundError,
    SpeakerRegistryStorageError,
)
from .speaker_recognition import SpeakerRecognitionService
from .tts_audio_store import TtsAudioStoreRegistry
from .windows_audio_session import WindowsAudioSessionKeepalive


_RABILINK_AUDIO_STALE_TIMEOUT_SECONDS = 90.0
_TTS_CLEANUP_RETRY_SECONDS = 60.0


class SpeechBody(BaseModel):
    model: str = "tts-local"
    input: str = Field(min_length=1, max_length=10000)
    voice: str = "default"
    response_format: str = "wav"
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    provider: str | None = None
    language: str | None = None
    instructions: str | None = Field(default=None, max_length=2000)
    sample_rate: int | None = Field(default=None, ge=8000, le=48000)
    play: bool = False
    session_id: str | None = Field(default=None, max_length=200)
    route_id: str | None = Field(default=None, max_length=200)


class DashScopeBody(BaseModel):
    model: str
    input: dict[str, Any] = Field(default_factory=dict)
    parameters: dict[str, Any] = Field(default_factory=dict)


class SpeakerProfileCreateBody(BaseModel):
    display_name: str
    aliases: list[str] = Field(default_factory=list)


class SpeakerProfileUpdateBody(BaseModel):
    display_name: str | None = None
    aliases: list[str] | None = None


class SpeakerBindingBody(BaseModel):
    session_id: str
    record_id: str
    speaker_label: str
    speaker_id: str


class SpeakerIdentityBody(BaseModel):
    session_id: str
    record_id: str
    speaker_label: str
    speaker_id: str | None = None
    display_name: str | None = None
    aliases: list[str] = Field(default_factory=list)


class PlaybackSettingsBody(BaseModel):
    volume: int = Field(strict=True, ge=0, le=100)


class AudioStreamSelectionBody(BaseModel):
    source: str
    client_id: str | None = None


class RabiLinkAudioStreamBody(BaseModel):
    stream_id: str
    name: str = "RabiLink mobile audio"
    device_kind: str = "mobile"
    device_model: str | None = None
    source_device_id: str | None = None
    route_profile_id: str | None = None
    session_id: str | None = None


def default_registry(settings: Settings, roles_root: Path | None = None) -> ProviderRegistry:
    persona_roles_root = (roles_root or settings.config_path.parents[2] / "data" / "roles").expanduser().resolve()
    registry = ProviderRegistry(settings.default_tts_provider, settings.default_asr_provider)
    if settings.local_tts.enabled:
        registry.register_tts(LocalTtsProvider(settings.local_tts))
    for api_tts in settings.api_tts:
        if api_tts.enabled:
            provider = (
                DashScopeTtsProvider(
                    api_tts,
                    settings.server.temp_dir,
                    roles_root=persona_roles_root,
                )
                if api_tts.protocol == "dashscope"
                else ApiTtsProvider(api_tts, settings.server.temp_dir)
            )
            registry.register_tts(provider)
    if settings.faster_whisper.enabled:
        registry.register_asr(FasterWhisperProvider(settings.faster_whisper))
    for http_asr in settings.http_asr:
        if http_asr.enabled:
            registry.register_asr(LocalHttpAsrProvider(http_asr))
    for api_asr in settings.api_asr:
        if api_asr.enabled:
            provider = DashScopeAsrProvider(api_asr) if api_asr.protocol == "dashscope" else ApiAsrProvider(api_asr)
            registry.register_asr(provider)
    load_provider_extensions(registry, settings)
    return registry


def create_app(
    settings: Settings | None = None,
    registry: ProviderRegistry | None = None,
    playback: PlaybackCoordinator | None = None,
    audio_session_keepalive: WindowsAudioSessionKeepalive | None = None,
    roles_root: Path | None = None,
    rabilink_audio_stale_timeout_seconds: float = _RABILINK_AUDIO_STALE_TIMEOUT_SECONDS,
    speaker_recognition: SpeakerRecognitionService | None = None,
) -> FastAPI:
    current = settings or load_settings()
    persona_roles_root = (roles_root or current.config_path.parents[2] / "data" / "roles").expanduser().resolve()
    rabilink_audio_stale_timeout = float(rabilink_audio_stale_timeout_seconds)
    if rabilink_audio_stale_timeout <= 0:
        raise ValueError("RabiLink audio stale timeout must be greater than zero.")
    persona_cache_dirs = _persona_tts_cache_dirs(persona_roles_root)
    _validate_tts_cache_layout(current.server.tts_audio_dir, persona_roles_root, persona_cache_dirs)
    providers = registry or default_registry(current, persona_roles_root)
    transcoder = AudioTranscoder(current.server.temp_dir, current.server.ffmpeg)
    logger = logging.getLogger("rabispeech")
    event_hub = SpeechEventHub()
    audio_stream_events = AudioStreamEventStore(current.remote_audio.settings_path.parent / "audio-stream-events")
    remote_audio = RemoteAudioHub(
        RemoteAudioServerConfig(
            enabled=current.remote_audio.enabled,
            host=current.remote_audio.host,
            port=current.remote_audio.port,
            token=current.remote_audio.token,
            settings_path=current.remote_audio.settings_path,
            discovery_port=current.remote_audio.discovery_port,
            service_name=socket.gethostname(),
        ),
        local_player=PlaybackCoordinator._default_player,
        local_stopper=PlaybackCoordinator._default_stopper,
        event_sink=event_hub.publish,
        event_store=audio_stream_events,
    )
    playback_queue = playback or PlaybackCoordinator(
        current.server.playback_dir,
        player=remote_audio.play,
        stopper=remote_audio.stop_playback,
        event_sink=event_hub.publish,
    )
    mixer_keepalive = audio_session_keepalive or WindowsAudioSessionKeepalive(logger=logger)
    speaker_profiles = SpeakerProfileRegistry(current.server.records_dir.parent / "speaker-profiles.json")
    speaker_recognizer = speaker_recognition or SpeakerRecognitionService(
        current.speaker_recognition,
        current.server.records_dir.parent / "speaker-embeddings.json",
    )
    records = SpeechRecordStore(current.server.records_dir, speaker_profiles, event_sink=event_hub.publish)
    tts_audio_stores = TtsAudioStoreRegistry(current.server.tts_audio_retention_minutes)
    fallback_tts_audio = tts_audio_stores.get(current.server.tts_audio_dir)
    asr_audio_store = tts_audio_stores.get(current.server.records_dir.parent / "asr-audio")
    for cache_dir in persona_cache_dirs:
        if cache_dir.is_dir():
            tts_audio_stores.get(cache_dir)

    async def microphone_transcriber(audio_path: Path, config: MicrophoneConfig) -> TranscriptionResult:
        record_id = f"speech-{uuid4().hex}"
        result = await _transcribe(
            providers,
            audio_path,
            model=config.asr_model,
            provider=None,
            language=config.language,
            prompt=config.prompt,
            # Hot-delivery quality decisions require auditable word confidence.
            # Providers without it remain fail-closed and record-only.
            word_timestamps=True,
        )
        result = speaker_recognizer.analyze(
            audio_path,
            result,
            record_id=record_id,
            session_id=config.session_id,
            profile_names=speaker_profiles.profile_names(),
        )
        return speaker_profiles.resolve_transcription(
            result,
            session_id=config.session_id,
            record_id=record_id,
        )

    async def microphone_submitter(
        result: TranscriptionResult,
        session_id: str,
        utterance: SpeechUtteranceMetadata,
        input_source: SpeechInputSource,
    ) -> dict[str, object]:
        base = _manager_loopback_url()
        async with httpx.AsyncClient(timeout=45.0) as client:
            response = await client.post(
                f"{base}/api/speech/messages",
                json={
                    "recordId": result.record_id,
                    "text": result.text,
                    "sessionId": session_id,
                    "source": input_source.source,
                    "transport": input_source.transport,
                    "channelType": input_source.channel_type,
                    "messageAdapterType": input_source.message_adapter_type,
                    "routeProfileId": input_source.route_profile_id,
                    "sourceDeviceId": input_source.device_id,
                    "sourceDeviceName": input_source.device_name,
                    "sourceDeviceKind": input_source.device_kind,
                    "sourceStreamId": input_source.stream_id,
                    "audioFormat": input_source.audio_format,
                    "channels": input_source.channels,
                    "sampleRate": input_source.sample_rate,
                    "recordedAt": utterance.started_at,
                    "startedAt": utterance.started_at,
                    "completedAt": utterance.completed_at,
                    "peak": utterance.peak,
                    "rms": utterance.rms,
                    "provider": result.provider,
                    "model": result.model,
                    "language": result.language,
                    "duration": result.duration,
                    "segments": [asdict(segment) for segment in result.segments],
                },
            )
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            if response.is_error:
                detail = str(payload.get("message") or f"HTTP {response.status_code}").strip()
                raise RuntimeError(f"RabiRoute speech delivery failed: {detail}")
            data = payload.get("data")
            if not isinstance(data, dict) or data.get("status") not in {"delivered", "recorded"}:
                raise RuntimeError("RabiRoute speech delivery returned no terminal receipt.")
            return {
                "status": data["status"],
                "message_id": str(data.get("messageId") or "").strip(),
                "reason": str(data.get("reason") or "").strip(),
                "detail": str(data.get("detail") or "").strip(),
                "deliveries": data.get("deliveries") if isinstance(data.get("deliveries"), list) else [],
            }

    def publish_microphone_event(event_type: str, payload: object) -> None:
        event_hub.publish(event_type, payload)
        if event_type != "microphone_event" or not isinstance(payload, dict):
            return
        details = payload.get("details")
        safe_details = details if isinstance(details, dict) else {}
        audio_stream_events.append({
            "time": payload.get("time"),
            "direction": "pipeline",
            "stage": payload.get("stage"),
            "kind": payload.get("kind"),
            "level": payload.get("level"),
            "message": payload.get("message"),
            "client_id": remote_audio.selected_client_id,
            "source_device_id": remote_audio.selected_source_device_id,
            "device_model": remote_audio.selected_device_model,
            "record_id": safe_details.get("message_id"),
            "route_id": safe_details.get("route_id"),
            "details": safe_details,
        })

    def persist_asr_record(
        result: TranscriptionResult,
        *,
        source: str,
        audio_path: Path,
        session_id: str | None = None,
        route_id: str | None = None,
        recorded_at: float | None = None,
        record_id: str | None = None,
        input_source: SpeechInputSource | None = None,
    ) -> dict[str, object]:
        retained = asr_audio_store.retain(audio_path)
        return records.append_asr(
            result,
            source=source,
            session_id=session_id,
            route_id=route_id,
            recorded_at=recorded_at,
            record_id=record_id,
            audio_file=_asr_audio_record_file(asr_audio_store.relative_path(retained)),
            audio_expires_at=asr_audio_store.expires_at(retained),
            source_device_id=input_source.device_id if input_source else None,
            source_device_name=input_source.device_name if input_source else None,
            source_device_kind=input_source.device_kind if input_source else None,
            source_stream_id=input_source.stream_id if input_source else None,
            message_adapter_type=input_source.message_adapter_type if input_source else None,
        )

    microphone = MicrophoneService(
        state_path=current.server.temp_dir.parent / "microphone.json",
        temp_dir=current.server.temp_dir,
        transcriber=microphone_transcriber,
        submitter=microphone_submitter,
        playback_active=lambda: bool(playback_queue.snapshot().get("current")),
        stop_playback=lambda: playback_queue.stop(clear_pending=True),
        record_transcription=lambda result, config, started_at, audio_path, input_source: persist_asr_record(
            result,
            source="microphone",
            audio_path=audio_path,
            session_id=config.session_id,
            route_id=config.route_id,
            recorded_at=started_at,
            record_id=result.record_id,
            input_source=input_source,
        ),
        remote_audio=remote_audio,
        event_sink=publish_microphone_event,
    )
    remote_audio.set_feed(microphone.feed_remote)
    virtual_audio_lock = asyncio.Lock()
    virtual_audio_expiry: dict[str, asyncio.TimerHandle] = {}
    virtual_audio_generation: dict[str, int] = {}
    tts_cleanup_deadline: asyncio.TimerHandle | None = None
    tts_cleanup_task: asyncio.Task[None] | None = None
    tts_cleanup_closed = False
    provider_warmup_gate = asyncio.Event()

    def cancel_virtual_audio_expiry(stream_id: str | None = None) -> None:
        targets = [stream_id] if stream_id else list(virtual_audio_expiry)
        for target in targets:
            virtual_audio_generation[target] = virtual_audio_generation.get(target, 0) + 1
            handle = virtual_audio_expiry.pop(target, None)
            if handle is not None:
                handle.cancel()

    async def expire_virtual_audio_stream(stream_id: str, generation: int) -> None:
        async with virtual_audio_lock:
            if generation != virtual_audio_generation.get(stream_id) or not remote_audio.has_virtual_client(stream_id):
                return
            virtual_audio_expiry.pop(stream_id, None)
            remote_audio.stop_virtual_client(stream_id)
            logger.warning(
                "Stopped stale RabiLink audio stream %s after %.1f seconds without PCM",
                stream_id,
                rabilink_audio_stale_timeout,
            )

    def arm_virtual_audio_expiry(stream_id: str) -> None:
        cancel_virtual_audio_expiry(stream_id)
        generation = virtual_audio_generation.get(stream_id, 0)
        virtual_audio_expiry[stream_id] = asyncio.get_running_loop().call_later(
            rabilink_audio_stale_timeout,
            lambda: asyncio.create_task(
                expire_virtual_audio_stream(stream_id, generation),
                name="rabispeech-rabilink-audio-expiry",
            ),
        )

    def cancel_tts_cleanup_deadline() -> None:
        nonlocal tts_cleanup_deadline
        if tts_cleanup_deadline is not None:
            tts_cleanup_deadline.cancel()
            tts_cleanup_deadline = None

    async def run_tts_cleanup() -> None:
        nonlocal tts_cleanup_task
        retry_at: float | None = None
        try:
            await asyncio.to_thread(tts_audio_stores.cleanup)
        except Exception:
            logger.exception("TTS cache expiry cleanup failed")
            retry_at = time.time() + _TTS_CLEANUP_RETRY_SECONDS
        finally:
            tts_cleanup_task = None
            if not tts_cleanup_closed:
                arm_tts_cleanup_deadline(retry_at)

    def arm_tts_cleanup_deadline(expires_at: float | None = None) -> None:
        nonlocal tts_cleanup_deadline, tts_cleanup_task
        if tts_cleanup_closed:
            return
        try:
            deadline = tts_audio_stores.next_expiry() if expires_at is None else float(expires_at)
        except Exception:
            logger.exception("TTS cache expiry scan failed")
            deadline = time.time() + _TTS_CLEANUP_RETRY_SECONDS
        if deadline is None:
            cancel_tts_cleanup_deadline()
            return
        loop = asyncio.get_running_loop()
        delay = max(0.01, deadline - time.time() + 0.01)
        scheduled_at = loop.time() + delay
        if tts_cleanup_deadline is not None and tts_cleanup_deadline.when() <= scheduled_at:
            return
        cancel_tts_cleanup_deadline()

        def start_cleanup() -> None:
            nonlocal tts_cleanup_deadline, tts_cleanup_task
            tts_cleanup_deadline = None
            if tts_cleanup_closed or tts_cleanup_task is not None:
                return
            tts_cleanup_task = asyncio.create_task(run_tts_cleanup(), name="rabispeech-tts-cache-expiry")

        tts_cleanup_deadline = loop.call_later(delay, start_cleanup)

    def speaker_capability() -> dict[str, object]:
        capability = dict(speaker_profiles.capabilities())
        capability["mode"] = "record_embedding_matching"
        capability["stores_voice_embeddings"] = True
        capability["voiceprint"] = speaker_recognizer.capability()
        return capability

    @asynccontextmanager
    async def lifespan(_api: FastAPI):
        nonlocal tts_cleanup_closed, tts_cleanup_task
        async def warmup_providers() -> None:
            try:
                await provider_warmup_gate.wait()
                # Let the health response flush before Python/model imports can
                # briefly hold the GIL on a cold Windows filesystem.
                await asyncio.sleep(1.0)
                await providers.warmup()
            except Exception:
                logger.exception("RabiSpeech provider warmup failed; providers remain available for a later request.")

        fallback_warmup = asyncio.get_running_loop().call_later(30.0, provider_warmup_gate.set)
        provider_warmup_task = asyncio.create_task(
            warmup_providers(),
            name="rabispeech-provider-warmup",
        )
        await remote_audio.start()
        mixer_keepalive.start()
        await microphone.restore()
        tts_cleanup_task = asyncio.create_task(
            run_tts_cleanup(),
            name="rabispeech-tts-cache-initial-cleanup",
        )
        try:
            yield
        finally:
            tts_cleanup_closed = True
            fallback_warmup.cancel()
            cancel_virtual_audio_expiry()
            cancel_tts_cleanup_deadline()
            if tts_cleanup_task is not None:
                await tts_cleanup_task
            if not provider_warmup_task.done():
                provider_warmup_task.cancel()
            with suppress(asyncio.CancelledError):
                await provider_warmup_task
            await microphone.stop(persist=False)
            await remote_audio.stop()
            mixer_keepalive.stop()

    api = FastAPI(
        title="RabiSpeech Local API",
        version="0.1.0",
        description="TTS and ASR provider gateway. Local providers are the default; explicitly configured API providers are optional.",
        lifespan=lifespan,
    )

    @api.get("/health")
    async def health() -> dict[str, object]:
        provider_warmup_gate.set()
        return {
            "ok": True,
            "service": "RabiSpeech",
        }

    @api.get("/v1/events")
    async def events(request: Request) -> StreamingResponse:
        _require_loopback(request)
        return StreamingResponse(event_hub.stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})

    @api.get("/v1/capabilities")
    async def capabilities() -> dict[str, object]:
        provider_capabilities = await asyncio.to_thread(providers.capabilities)
        return {
            "object": "rabispeech.capabilities",
            "providers": public_capabilities(provider_capabilities),
            "api": api_index(),
            "relay_safe": _provider_capabilities_are_local(provider_capabilities),
            "streaming": False,
            "microphone": {"running": microphone.snapshot()["running"], "state": microphone.snapshot()["state"], "scope": "loopback-only"},
            "audio_stream": remote_audio.snapshot(),
            "speaker_identity": speaker_capability(),
        }

    @api.get("/v1/models")
    async def models() -> dict[str, object]:
        rows = await asyncio.to_thread(lambda: model_rows(providers.capabilities()))
        return {"object": "list", "data": rows, "api": api_index()}

    @api.get("/v1/models/{model_id:path}")
    async def model_detail(model_id: str) -> dict[str, object]:
        normalized = model_id.strip().strip("/").lower()
        rows = await asyncio.to_thread(lambda: model_rows(providers.capabilities()))
        for row in rows:
            if str(row.get("id") or "").lower() == normalized:
                return row
        raise HTTPException(status_code=404, detail=f"Unknown local model: {model_id}")

    @api.get("/v1/playback/status")
    async def playback_status() -> dict[str, object]:
        return playback_queue.snapshot()

    @api.get("/v1/audio-streams")
    async def audio_streams(request: Request) -> dict[str, object]:
        _require_loopback(request)
        return remote_audio.snapshot()

    @api.get("/v1/audio-streams/events")
    async def audio_stream_event_history(
        request: Request,
        limit: int = 200,
        client_id: str | None = None,
        source_device_id: str | None = None,
        before_sequence: int | None = None,
    ) -> dict[str, object]:
        _require_loopback(request)
        events = await asyncio.to_thread(
            remote_audio.list_events,
            limit=limit,
            client_id=client_id,
            source_device_id=source_device_id,
            before_sequence=before_sequence,
        )
        return {
            "ok": True,
            "events": events,
        }

    @api.post("/v1/audio-streams/token")
    async def audio_stream_token(request: Request) -> dict[str, object]:
        _require_loopback(request)
        if not current.remote_audio.enabled or not current.remote_audio.token:
            raise HTTPException(status_code=409, detail="Remote audio streaming is not enabled.")
        return {"token": current.remote_audio.token}

    @api.put("/v1/audio-streams/selection")
    async def audio_stream_selection(request: Request, body: AudioStreamSelectionBody) -> dict[str, object]:
        _require_loopback(request)
        was_running = bool(microphone.snapshot().get("running"))
        if was_running:
            await microphone.stop(persist=False)
        try:
            result = await remote_audio.select(body.source, body.client_id)
            if was_running:
                await microphone.start({}, persist=False)
            return result
        except ValueError as exc:
            if was_running and not microphone.snapshot().get("running"):
                await microphone.start({}, persist=False)
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @api.post("/v1/audio-streams/rabilink/start")
    async def rabilink_audio_stream_start(request: Request, body: RabiLinkAudioStreamBody) -> dict[str, object]:
        _require_loopback(request)
        async with virtual_audio_lock:
            was_running = bool(microphone.snapshot().get("running"))
            try:
                remote_audio.start_virtual_client(
                    client_id=body.stream_id,
                    name=body.name,
                    kind=body.device_kind,
                    device_model=body.device_model or "",
                    source_device_id=body.source_device_id or body.session_id or body.stream_id,
                    message_adapter_type="rabilink",
                    route_profile_id=body.route_profile_id or "",
                    session_id=body.session_id or "",
                    resume_running=was_running,
                )
                if not was_running:
                    await microphone.start({}, persist=False)
                arm_virtual_audio_expiry(body.stream_id)
                return remote_audio.snapshot()
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            except Exception:
                if remote_audio.has_virtual_client(body.stream_id):
                    remote_audio.stop_virtual_client(body.stream_id)
                raise

    @api.post("/v1/audio-streams/rabilink/chunk")
    async def rabilink_audio_stream_chunk(request: Request) -> dict[str, object]:
        _require_loopback(request)
        stream_id = str(request.query_params.get("streamId") or "").strip()
        try:
            sequence = int(str(request.query_params.get("sequence") or ""))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="RabiLink audio chunk sequence must be an integer.") from exc
        payload = await request.body()
        chunk_id = str(request.query_params.get("chunkId") or "").strip()
        async with virtual_audio_lock:
            try:
                accepted = remote_audio.feed_virtual_client(
                    stream_id,
                    payload,
                    sequence=sequence,
                    chunk_id=chunk_id or None,
                )
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
        if not accepted:
            raise HTTPException(status_code=409, detail="RabiLink audio stream is not active or capture is not ready.")
        arm_virtual_audio_expiry(stream_id)
        return {"ok": True, "accepted_bytes": len(payload), "sequence": sequence}

    @api.post("/v1/audio-streams/rabilink/keepalive")
    async def rabilink_audio_stream_keepalive(request: Request) -> dict[str, object]:
        _require_loopback(request)
        stream_id = str(request.query_params.get("streamId") or "").strip()
        async with virtual_audio_lock:
            if not stream_id or not remote_audio.has_virtual_client(stream_id):
                raise HTTPException(status_code=409, detail="RabiLink audio stream is not active.")
            arm_virtual_audio_expiry(stream_id)
        return {"ok": True, "received_bytes": 0}

    @api.post("/v1/audio-streams/rabilink/stop")
    async def rabilink_audio_stream_stop(request: Request, body: RabiLinkAudioStreamBody) -> dict[str, object]:
        _require_loopback(request)
        async with virtual_audio_lock:
            if not remote_audio.has_virtual_client(body.stream_id):
                raise HTTPException(status_code=409, detail="The requested RabiLink audio stream is not active.")
            cancel_virtual_audio_expiry(body.stream_id)
            try:
                remote_audio.stop_virtual_client(body.stream_id)
                return remote_audio.snapshot()
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

    @api.put("/v1/playback/settings")
    @api.patch("/v1/playback/settings")
    async def playback_settings(
        request: Request,
        body: PlaybackSettingsBody,
    ) -> dict[str, object]:
        _require_loopback(request)
        return playback_queue.set_volume(body.volume)

    @api.post("/v1/playback/stop")
    async def playback_stop() -> dict[str, object]:
        return playback_queue.stop(clear_pending=True)

    @api.get("/v1/records")
    async def speech_records(
        limit: int = 200,
        kind: str | None = None,
        session_id: str | None = None,
        route_id: str | None = None,
        since: float | None = None,
        until: float | None = None,
        source_device_id: str | None = None,
        before: float | None = None,
    ) -> dict[str, object]:
        rows = await asyncio.to_thread(
            records.list,
            limit=limit,
            kind=kind,
            session_id=session_id,
            route_id=route_id,
            since=since,
            until=until,
            source_device_id=source_device_id,
            before=before,
        )
        return {
            "object": "list",
            "data": rows,
        }

    @api.get("/v1/records/{record_id}/audio")
    async def speech_record_audio(record_id: str, request: Request) -> FileResponse:
        _require_loopback(request)
        record = records.read(record_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Speech record was not found.")
        if record.get("kind") != "asr" or not record.get("audio_file"):
            raise HTTPException(status_code=404, detail="This speech record has no retained source audio.")
        expires_at = float(record.get("audio_expires_at") or 0)
        if expires_at and time.time() >= expires_at:
            raise HTTPException(status_code=410, detail="The retained source audio has expired.")
        filename = Path(str(record["audio_file"])).name
        try:
            source_audio = asr_audio_store.resolve(asr_audio_store.root / filename)
        except (FileNotFoundError, ValueError):
            raise HTTPException(status_code=410, detail="The retained source audio is no longer available.")
        return FileResponse(
            source_audio,
            media_type=_audio_media_type(source_audio),
            filename=source_audio.name,
            headers={"Cache-Control": "private, no-store"},
        )

    @api.get("/v1/speaker-profiles")
    async def speaker_profile_list(request: Request, session_id: str | None = None) -> dict[str, object]:
        _require_loopback(request)
        snapshot = await asyncio.to_thread(speaker_profiles.snapshot, session_id=session_id)
        return {
            **snapshot,
            "capability": speaker_capability(),
            "clusters": await asyncio.to_thread(speaker_recognizer.public_clusters),
        }

    @api.post("/v1/speaker-profiles")
    async def speaker_profile_create(request: Request, body: SpeakerProfileCreateBody) -> dict[str, object]:
        _require_loopback(request)
        try:
            return speaker_profiles.create_profile(body.display_name, body.aliases)
        except (ValueError, SpeakerRegistryStorageError) as exc:
            raise _speaker_http_error(exc) from exc

    @api.patch("/v1/speaker-profiles/{speaker_id}")
    async def speaker_profile_update(
        speaker_id: str,
        request: Request,
        body: SpeakerProfileUpdateBody,
    ) -> dict[str, object]:
        _require_loopback(request)
        try:
            return speaker_profiles.update_profile(
                speaker_id,
                display_name=body.display_name,
                aliases=body.aliases,
                aliases_provided="aliases" in body.model_fields_set,
            )
        except (ValueError, SpeakerRegistryNotFoundError, SpeakerRegistryStorageError) as exc:
            raise _speaker_http_error(exc) from exc

    @api.delete("/v1/speaker-profiles/{speaker_id}")
    async def speaker_profile_delete(speaker_id: str, request: Request) -> dict[str, object]:
        _require_loopback(request)
        try:
            result = speaker_profiles.delete_profile(speaker_id)
            result["removed_voice_samples"] = speaker_recognizer.forget_profile(speaker_id)
            return result
        except (ValueError, SpeakerRegistryNotFoundError, SpeakerRegistryStorageError) as exc:
            raise _speaker_http_error(exc) from exc

    @api.put("/v1/speaker-bindings")
    async def speaker_binding_put(request: Request, body: SpeakerBindingBody) -> dict[str, object]:
        _require_loopback(request)
        try:
            binding = speaker_profiles.bind(
                body.session_id,
                body.speaker_label,
                body.speaker_id,
                record_id=body.record_id,
            )
            binding["voice_sample_confirmed"] = speaker_recognizer.confirm(
                body.record_id,
                body.speaker_label,
                body.speaker_id,
            )
            return binding
        except (ValueError, SpeakerRegistryNotFoundError, SpeakerRegistryStorageError) as exc:
            raise _speaker_http_error(exc) from exc

    @api.put("/v1/speaker-identities")
    async def speaker_identity_put(request: Request, body: SpeakerIdentityBody) -> dict[str, object]:
        _require_loopback(request)
        try:
            result = speaker_profiles.identify_and_bind(
                body.session_id,
                body.speaker_label,
                record_id=body.record_id,
                speaker_id=body.speaker_id,
                display_name=body.display_name,
                aliases=body.aliases,
            )
            result["voice_sample_confirmed"] = speaker_recognizer.confirm(
                body.record_id,
                body.speaker_label,
                str(result["profile"]["id"]),
            )
            return result
        except (
            ValueError,
            SpeakerRegistryConflictError,
            SpeakerRegistryNotFoundError,
            SpeakerRegistryStorageError,
        ) as exc:
            raise _speaker_http_error(exc) from exc

    @api.delete("/v1/speaker-bindings")
    async def speaker_binding_delete(
        request: Request,
        session_id: str,
        record_id: str,
        speaker_label: str,
    ) -> dict[str, object]:
        _require_loopback(request)
        try:
            binding = speaker_profiles.unbind(session_id, speaker_label, record_id=record_id)
            binding["voice_sample_unconfirmed"] = speaker_recognizer.unconfirm(record_id, speaker_label)
            return binding
        except (ValueError, SpeakerRegistryNotFoundError, SpeakerRegistryStorageError) as exc:
            raise _speaker_http_error(exc) from exc

    @api.get("/v1/microphone/status")
    async def microphone_status() -> dict[str, object]:
        return microphone.snapshot()

    @api.get("/v1/microphone/devices")
    async def microphone_devices() -> dict[str, object]:
        try:
            devices = await asyncio.to_thread(microphone.devices)
            return {"object": "list", "data": devices}
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"Microphone device scan failed: {exc}") from exc

    @api.post("/v1/microphone/start")
    async def microphone_start(body: dict[str, Any] | None = None) -> dict[str, object]:
        try:
            return await microphone.start(body or {})
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @api.put("/v1/microphone/settings")
    async def microphone_settings(request: Request, body: dict[str, Any] | None = None) -> dict[str, object]:
        _require_loopback(request)
        try:
            return await microphone.update_settings(body or {})
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @api.post("/v1/microphone/stop")
    async def microphone_stop() -> dict[str, object]:
        return await microphone.stop()

    async def synthesize(body: SpeechBody, background_tasks: BackgroundTasks) -> FileResponse:
        try:
            persona_role_dir = resolve_persona_role_dir(persona_roles_root, body.voice)
            persona_defaults = persona_speech_defaults_for_role(persona_role_dir)
            if persona_defaults:
                body = SpeechBody(**{
                    **body.model_dump(),
                    "model": persona_defaults.get("model") or body.model,
                    "language": persona_defaults.get("language") or body.language,
                    "instructions": persona_defaults.get("instructions") or body.instructions,
                    "speed": persona_defaults.get("speed") or body.speed,
                })
            provider, selection = providers.tts(body.provider, body.model)
            artifact = await provider.synthesize(
                SpeechSynthesisRequest(
                    text=body.input,
                    model=selection.model,
                    voice=body.voice,
                    response_format=body.response_format,
                    speed=body.speed,
                    language=body.language,
                    instructions=body.instructions,
                    sample_rate=body.sample_rate,
                )
            )
            prepared = await transcoder.prepare(artifact, body.response_format, body.sample_rate)
            cache_dir = persona_tts_cache_dir(persona_role_dir)
            selected_tts_audio = tts_audio_stores.get(cache_dir) if cache_dir is not None else fallback_tts_audio
            retained = selected_tts_audio.retain(prepared.path)
            arm_tts_cleanup_deadline(selected_tts_audio.expires_at(retained))
        except KeyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("TTS request failed")
            raise HTTPException(status_code=502, detail=f"TTS failed ({type(exc).__name__}). Check RabiSpeech logs.") from exc
        playback_job: dict[str, object] | None = None
        if body.play:
            try:
                playback_job = playback_queue.enqueue(
                    artifact.path,
                    provider=artifact.provider,
                    model=artifact.model,
                    voice=body.voice,
                    session_id=body.session_id,
                    route_id=body.route_id,
                )
            except Exception as exc:
                logger.exception("Playback enqueue failed")
                raise HTTPException(status_code=502, detail=f"Playback failed ({type(exc).__name__}). Check RabiSpeech logs.") from exc
        try:
            records.append_tts(
                text=body.input,
                provider=artifact.provider,
                model=artifact.model,
                voice=body.voice,
                session_id=body.session_id,
                route_id=body.route_id,
                playback_job_id=str(playback_job["id"]) if playback_job else None,
                playback_status=str(playback_job["status"]) if playback_job else None,
                audio_file=_tts_audio_record_file(
                    persona_role_dir,
                    selected_tts_audio.relative_path(retained),
                ),
                audio_expires_at=selected_tts_audio.expires_at(retained),
            )
        except Exception:
            logger.exception("TTS record persistence failed")
        if artifact.cleanup:
            background_tasks.add_task(artifact.path.unlink, missing_ok=True)
        if prepared.cleanup and prepared.path != artifact.path:
            background_tasks.add_task(prepared.path.unlink, missing_ok=True)
        return FileResponse(
            retained,
            media_type=prepared.media_type,
            filename=f"speech.{body.response_format.lower()}",
            headers={
                "X-RabiSpeech-Provider": prepared.provider,
                "X-RabiSpeech-Model": prepared.model,
                **({"X-RabiSpeech-Playback-Job": str(playback_job["id"])} if playback_job else {}),
            },
        )

    @api.post("/v1/audio/speech")
    async def audio_speech(body: SpeechBody, background_tasks: BackgroundTasks) -> FileResponse:
        return await synthesize(body, background_tasks)

    @api.post("/api/v1/services/audio/tts/SpeechSynthesizer")
    async def dashscope_speech(body: DashScopeBody, background_tasks: BackgroundTasks) -> FileResponse:
        input_data = body.input
        parameters = body.parameters
        text = str(input_data.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=422, detail="input.text is required.")
        request = SpeechBody(
            model=body.model,
            input=text,
            voice=str(input_data.get("voice") or parameters.get("voice") or "default"),
            response_format=str(input_data.get("format") or parameters.get("format") or "wav").lower(),
            speed=float(input_data.get("speech_rate") or parameters.get("speech_rate") or 1.0),
            provider=str(parameters.get("provider") or "") or None,
            language=str(input_data.get("language") or parameters.get("language") or "") or None,
            instructions=str(input_data.get("instructions") or parameters.get("instructions") or "") or None,
            sample_rate=int(input_data.get("sample_rate") or parameters.get("sample_rate") or 0) or None,
            play=bool(input_data.get("play") or parameters.get("play")),
            session_id=str(input_data.get("session_id") or parameters.get("session_id") or "") or None,
            route_id=str(input_data.get("route_id") or parameters.get("route_id") or "") or None,
        )
        return await synthesize(request, background_tasks)

    @api.post("/v1/audio/transcriptions")
    async def audio_transcriptions(
        file: Annotated[UploadFile, File()],
        background_tasks: BackgroundTasks,
        model: Annotated[str, Form()] = "asr-local",
        language: Annotated[str | None, Form()] = None,
        prompt: Annotated[str | None, Form()] = None,
        response_format: Annotated[str, Form()] = "json",
        provider: Annotated[str | None, Form()] = None,
        timestamp_granularities: Annotated[list[str] | None, Form()] = None,
        speaker_count: Annotated[int | None, Form()] = None,
        session_id: Annotated[str | None, Form()] = None,
        route_id: Annotated[str | None, Form()] = None,
    ) -> Response:
        audio_path = await _store_upload(file, current)
        background_tasks.add_task(audio_path.unlink, missing_ok=True)
        record_id = f"speech-{uuid4().hex}"
        result = await _transcribe(
            providers,
            audio_path,
            model=model,
            provider=provider,
            language=language,
            prompt=prompt,
            word_timestamps="word" in (timestamp_granularities or []),
            speaker_count=speaker_count,
        )
        result = speaker_recognizer.analyze(
            audio_path,
            result,
            record_id=record_id,
            session_id=session_id,
            profile_names=speaker_profiles.profile_names(),
        )
        result = speaker_profiles.resolve_transcription(
            result,
            session_id=session_id,
            record_id=record_id,
        )
        try:
            persist_asr_record(
                result,
                source="api",
                audio_path=audio_path,
                session_id=session_id,
                route_id=route_id,
                record_id=record_id,
            )
        except Exception:
            logger.exception("ASR record persistence failed")
        return _transcription_response(result, response_format)

    @api.post("/api/v1/services/audio/asr/transcription")
    async def dashscope_transcription(body: DashScopeBody, background_tasks: BackgroundTasks) -> JSONResponse:
        payload, suffix = _dashscope_audio(body.input)
        if len(payload) > current.server.max_upload_bytes:
            raise HTTPException(status_code=413, detail="Audio upload is too large.")
        audio_path = _store_bytes(payload, suffix, current)
        background_tasks.add_task(audio_path.unlink, missing_ok=True)
        language_hints = body.parameters.get("language_hints") or []
        language = str(language_hints[0]) if isinstance(language_hints, list) and language_hints else None
        record_id = f"speech-{uuid4().hex}"
        result = await _transcribe(
            providers,
            audio_path,
            model=body.model,
            provider=str(body.parameters.get("provider") or "") or None,
            language=language,
            prompt=str(body.parameters.get("prompt") or "") or None,
            word_timestamps=bool(body.parameters.get("enable_words")),
            speaker_count=int(body.parameters.get("speaker_count")) if body.parameters.get("speaker_count") else None,
        )
        session_id = str(body.parameters.get("session_id") or "") or None
        result = speaker_recognizer.analyze(
            audio_path,
            result,
            record_id=record_id,
            session_id=session_id,
            profile_names=speaker_profiles.profile_names(),
        )
        result = speaker_profiles.resolve_transcription(
            result,
            session_id=session_id,
            record_id=record_id,
        )
        try:
            persist_asr_record(
                result,
                source="dashscope-compatible-api",
                audio_path=audio_path,
                session_id=session_id,
                route_id=str(body.parameters.get("route_id") or "") or None,
                record_id=record_id,
            )
        except Exception:
            logger.exception("ASR record persistence failed")
        request_id = str(uuid4())
        return JSONResponse(
            {
                "request_id": request_id,
                "output": {
                    "task_id": request_id,
                    "task_status": "SUCCEEDED",
                    "text": result.text,
                    "results": [{"text": result.text, "language": result.language, "duration": result.duration}],
                },
                "usage": {"duration": result.duration},
            }
        )

    return api


def _provider_capabilities_are_local(capabilities: dict[str, object]) -> bool:
    for kind in ("tts", "asr"):
        providers = capabilities.get(kind)
        if not isinstance(providers, dict):
            continue
        for detail in providers.values():
            if not isinstance(detail, dict) or detail.get("enabled", True) is False:
                continue
            if detail.get("local_only") is False:
                return False
    return True


def _persona_tts_cache_dirs(roles_root: Path) -> list[Path]:
    root = roles_root.expanduser().resolve()
    if not root.is_dir():
        return []
    cache_dirs: list[Path] = []
    for item in root.iterdir():
        if not item.is_dir():
            continue
        role_dir = resolve_persona_role_dir(root, item.name)
        if role_dir is None:
            continue
        cache_dir = persona_tts_cache_dir(role_dir)
        if cache_dir is not None:
            cache_dirs.append(cache_dir)
    return cache_dirs


def _paths_overlap(first: Path, second: Path) -> bool:
    return (
        first == second
        or first.is_relative_to(second)
        or second.is_relative_to(first)
    )


def _validate_tts_cache_layout(fallback_root: Path, roles_root: Path, persona_cache_dirs: list[Path]) -> None:
    fallback = fallback_root.expanduser().resolve()
    roles = roles_root.expanduser().resolve()
    if _paths_overlap(fallback, roles):
        raise ValueError("Fallback TTS cache and persona roles root must not overlap.")
    for cache_dir in persona_cache_dirs:
        cache = cache_dir.expanduser().resolve()
        if not cache.is_relative_to(roles):
            raise ValueError("Persona TTS cache must stay inside the configured roles root.")
        if _paths_overlap(fallback, cache):
            raise ValueError("Fallback and persona TTS caches must not overlap.")


def _tts_audio_record_file(persona_role_dir: Path | None, cache_relative_path: str) -> str:
    prefix = (
        (persona_role_dir.name, "voice", "cache", "tts-audio")
        if persona_role_dir is not None
        else ("output", "tts-audio")
    )
    return (Path(*prefix) / cache_relative_path).as_posix()

def _asr_audio_record_file(cache_relative_path: str) -> str:
    return (Path("output") / "asr-audio" / cache_relative_path).as_posix()


def _audio_media_type(path: Path) -> str:
    guessed, _encoding = mimetypes.guess_type(path.name)
    return guessed if guessed and guessed.startswith("audio/") else "application/octet-stream"


def _require_loopback(request: Request) -> None:
    host = (request.client.host if request.client else "").split("%", 1)[0]
    if host == "testclient":
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise HTTPException(status_code=403, detail="This RabiSpeech control API is loopback-only.")


def _speaker_http_error(error: Exception) -> HTTPException:
    if isinstance(error, SpeakerRegistryNotFoundError):
        return HTTPException(status_code=404, detail=str(error).strip("'"))
    if isinstance(error, SpeakerRegistryConflictError):
        return HTTPException(status_code=409, detail=str(error))
    if isinstance(error, SpeakerRegistryStorageError):
        return HTTPException(status_code=503, detail=str(error))
    return HTTPException(status_code=422, detail=str(error))


async def _transcribe(
    registry: ProviderRegistry,
    audio_path: Path,
    *,
    model: str,
    provider: str | None,
    language: str | None,
    prompt: str | None,
    word_timestamps: bool,
    speaker_count: int | None = None,
) -> TranscriptionResult:
    try:
        selected, selection = registry.asr(provider, model)
        return await selected.transcribe(
            TranscriptionRequest(
                audio_path=audio_path,
                model=selection.model,
                language=language,
                prompt=prompt,
                word_timestamps=word_timestamps,
                speaker_count=speaker_count,
            )
        )
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ASR failed: {exc}") from exc


async def _store_upload(upload: UploadFile, settings: Settings) -> Path:
    suffix = Path(upload.filename or "audio.wav").suffix.lower()
    allowed = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".opus", ".webm", ".mp4", ".aac"}
    if suffix not in allowed:
        suffix = ".audio"
    settings.server.temp_dir.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(prefix="rabispeech-asr-", suffix=suffix, dir=settings.server.temp_dir, delete=False)
    target = Path(handle.name)
    total = 0
    try:
        while chunk := await upload.read(1024 * 1024):
            total += len(chunk)
            if total > settings.server.max_upload_bytes:
                raise HTTPException(status_code=413, detail="Audio upload is too large.")
            handle.write(chunk)
    except Exception:
        handle.close()
        target.unlink(missing_ok=True)
        raise
    finally:
        handle.close()
        await upload.close()
    if total == 0:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="Audio upload is empty.")
    return target


def _store_bytes(payload: bytes, suffix: str, settings: Settings) -> Path:
    settings.server.temp_dir.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(prefix="rabispeech-asr-", suffix=suffix, dir=settings.server.temp_dir, delete=False)
    handle.write(payload)
    handle.close()
    return Path(handle.name)


def _dashscope_audio(input_data: dict[str, Any]) -> tuple[bytes, str]:
    candidates = [input_data.get("audio"), input_data.get("audio_data"), input_data.get("file_url")]
    messages = input_data.get("messages")
    if isinstance(messages, list):
        candidates.extend(messages)
    data_uri = _find_data_uri(candidates)
    if not data_uri:
        raise HTTPException(
            status_code=422,
            detail="This local-only endpoint requires an audio data URI; public HTTP file URLs are not fetched.",
        )
    header, encoded = data_uri.split(",", 1)
    mime = header[5:].split(";", 1)[0].lower()
    suffix = {"audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/flac": ".flac", "audio/ogg": ".ogg"}.get(mime, ".audio")
    try:
        return base64.b64decode(encoded, validate=True), suffix
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Invalid Base64 audio data URI.") from exc


def _find_data_uri(value: object) -> str:
    if isinstance(value, str):
        return value if value.startswith("data:audio/") and ";base64," in value else ""
    if isinstance(value, list):
        for item in value:
            found = _find_data_uri(item)
            if found:
                return found
    if isinstance(value, dict):
        for item in value.values():
            found = _find_data_uri(item)
            if found:
                return found
    return ""


def _transcription_response(result: TranscriptionResult, response_format: str) -> Response:
    kind = response_format.strip().lower() or "json"
    if kind == "text":
        return PlainTextResponse(result.text)
    if kind in {"srt", "vtt"}:
        return PlainTextResponse(subtitle_text(result.segments, kind), media_type="text/plain; charset=utf-8")
    if kind == "json":
        return JSONResponse({"text": result.text})
    if kind != "verbose_json":
        raise HTTPException(status_code=422, detail=f"Unsupported response_format: {kind}")
    return JSONResponse(
        {
            "task": "transcribe",
            "language": result.language,
            "duration": result.duration,
            "text": result.text,
            "provider": result.provider,
            "model": result.model,
            "segments": [asdict(segment) for segment in result.segments],
        }
    )


def _manager_loopback_url() -> str:
    raw = os.environ.get("RABIROUTE_MANAGER_URL", "http://127.0.0.1:8790").strip().rstrip("/")
    parsed = urlparse(raw)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("RABIROUTE_MANAGER_URL must be an HTTP loopback URL.")
    return raw
