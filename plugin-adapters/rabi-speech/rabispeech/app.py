from __future__ import annotations

import asyncio
import base64
import binascii
import ipaddress
import logging
import os
import socket
import tempfile
from contextlib import asynccontextmanager, suppress
from dataclasses import asdict
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.background import BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

from .audio import AudioTranscoder, subtitle_text
from .config import Settings, load_settings
from .contracts import SpeechSynthesisRequest, TranscriptionRequest, TranscriptionResult
from .extensions import load_provider_extensions
from .model_discovery import api_index, model_rows, public_capabilities
from .microphone import MicrophoneConfig, MicrophoneService
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


_DEFAULT_TTS_CLEANUP_INTERVAL_SECONDS = 60.0


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
    tts_cleanup_interval_seconds: float = _DEFAULT_TTS_CLEANUP_INTERVAL_SECONDS,
    speaker_recognition: SpeakerRecognitionService | None = None,
) -> FastAPI:
    current = settings or load_settings()
    persona_roles_root = (roles_root or current.config_path.parents[2] / "data" / "roles").expanduser().resolve()
    cleanup_interval = float(tts_cleanup_interval_seconds)
    if cleanup_interval <= 0:
        raise ValueError("TTS cleanup interval must be greater than zero.")
    persona_cache_dirs = _persona_tts_cache_dirs(persona_roles_root)
    _validate_tts_cache_layout(current.server.tts_audio_dir, persona_roles_root, persona_cache_dirs)
    providers = registry or default_registry(current, persona_roles_root)
    transcoder = AudioTranscoder(current.server.temp_dir, current.server.ffmpeg)
    logger = logging.getLogger("rabispeech")
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
    )
    playback_queue = playback or PlaybackCoordinator(
        current.server.playback_dir,
        player=remote_audio.play,
        stopper=remote_audio.stop_playback,
    )
    mixer_keepalive = audio_session_keepalive or WindowsAudioSessionKeepalive(logger=logger)
    speaker_profiles = SpeakerProfileRegistry(current.server.records_dir.parent / "speaker-profiles.json")
    speaker_recognizer = speaker_recognition or SpeakerRecognitionService(
        current.speaker_recognition,
        current.server.records_dir.parent / "speaker-embeddings.json",
    )
    records = SpeechRecordStore(current.server.records_dir, speaker_profiles)
    tts_audio_stores = TtsAudioStoreRegistry(current.server.tts_audio_retention_minutes)
    fallback_tts_audio = tts_audio_stores.get(current.server.tts_audio_dir)
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
            word_timestamps=False,
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

    async def microphone_submitter(text: str, session_id: str) -> dict[str, object]:
        base = _manager_loopback_url()
        async with httpx.AsyncClient(timeout=45.0) as client:
            result = await client.post(
                f"{base}/api/speech/messages",
                json={"text": text, "sessionId": session_id},
            )
            try:
                payload = result.json()
            except ValueError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            if result.is_error:
                detail = str(payload.get("message") or f"HTTP {result.status_code}").strip()
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

    microphone = MicrophoneService(
        state_path=current.server.temp_dir.parent / "microphone.json",
        temp_dir=current.server.temp_dir,
        transcriber=microphone_transcriber,
        submitter=microphone_submitter,
        playback_active=lambda: bool(playback_queue.snapshot().get("current")),
        record_transcription=lambda result, config, started_at: records.append_asr(
            result,
            source="microphone",
            session_id=config.session_id,
            route_id=config.route_id,
            recorded_at=started_at,
            record_id=result.record_id,
        ),
        remote_audio=remote_audio,
    )
    remote_audio.set_feed(microphone.feed_remote)

    def speaker_capability() -> dict[str, object]:
        capability = dict(speaker_profiles.capabilities())
        capability["mode"] = "record_embedding_matching"
        capability["stores_voice_embeddings"] = True
        capability["voiceprint"] = speaker_recognizer.capability()
        return capability

    @asynccontextmanager
    async def lifespan(_api: FastAPI):
        await providers.warmup()
        await remote_audio.start()
        mixer_keepalive.start()
        await microphone.restore()
        cleanup_task = asyncio.create_task(
            _periodic_tts_cleanup(tts_audio_stores, cleanup_interval, logger),
            name="rabispeech-tts-cache-cleanup",
        )
        try:
            yield
        finally:
            cleanup_task.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup_task
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
        return {
            "ok": True,
            "service": "RabiSpeech",
            "local_only": current.server.host in {"127.0.0.1", "localhost", "::1"} and providers.local_only(),
            "providers": public_capabilities(providers.capabilities()),
            "microphone": {"running": microphone.snapshot()["running"], "state": microphone.snapshot()["state"]},
            "playback": {"mixer_session_active": mixer_keepalive.active},
            "audio_stream": remote_audio.snapshot(),
        }

    @api.get("/v1/capabilities")
    async def capabilities() -> dict[str, object]:
        return {
            "object": "rabispeech.capabilities",
            "providers": public_capabilities(providers.capabilities()),
            "api": api_index(),
            "relay_safe": providers.local_only(),
            "streaming": False,
            "microphone": {"running": microphone.snapshot()["running"], "state": microphone.snapshot()["state"], "scope": "loopback-only"},
            "audio_stream": remote_audio.snapshot(),
            "speaker_identity": speaker_capability(),
        }

    @api.get("/v1/models")
    async def models() -> dict[str, object]:
        rows = model_rows(providers.capabilities())
        return {"object": "list", "data": rows, "api": api_index()}

    @api.get("/v1/models/{model_id:path}")
    async def model_detail(model_id: str) -> dict[str, object]:
        normalized = model_id.strip().strip("/").lower()
        for row in model_rows(providers.capabilities()):
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
    ) -> dict[str, object]:
        return {
            "object": "list",
            "data": records.list(
                limit=limit,
                kind=kind,
                session_id=session_id,
                route_id=route_id,
                since=since,
                until=until,
            ),
        }

    @api.get("/v1/speaker-profiles")
    async def speaker_profile_list(request: Request, session_id: str | None = None) -> dict[str, object]:
        _require_loopback(request)
        snapshot = speaker_profiles.snapshot(session_id=session_id)
        return {**snapshot, "capability": speaker_capability(), "clusters": speaker_recognizer.public_clusters()}

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
            return {"object": "list", "data": microphone.devices()}
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
            records.append_asr(result, source="api", session_id=session_id, route_id=route_id, record_id=record_id)
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
            records.append_asr(
                result,
                source="dashscope-compatible-api",
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


async def _periodic_tts_cleanup(
    stores: TtsAudioStoreRegistry,
    interval_seconds: float,
    logger: logging.Logger,
) -> None:
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            await asyncio.to_thread(stores.cleanup)
        except Exception:
            logger.exception("Periodic TTS cache cleanup failed")


def _tts_audio_record_file(persona_role_dir: Path | None, cache_relative_path: str) -> str:
    prefix = (
        (persona_role_dir.name, "voice", "cache", "tts-audio")
        if persona_role_dir is not None
        else ("output", "tts-audio")
    )
    return (Path(*prefix) / cache_relative_path).as_posix()


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
