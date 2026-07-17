from __future__ import annotations

import base64
import binascii
import logging
import os
import tempfile
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.background import BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

from .audio import AudioTranscoder, subtitle_text
from .config import Settings, load_settings
from .contracts import SpeechSynthesisRequest, TranscriptionRequest, TranscriptionResult
from .extensions import load_provider_extensions
from .model_discovery import api_index, model_rows, public_capabilities
from .microphone import MicrophoneConfig, MicrophoneService
from .playback import PlaybackCoordinator
from .providers import FasterWhisperProvider, LocalHttpAsrProvider, LocalTtsProvider
from .registry import ProviderRegistry


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


def default_registry(settings: Settings) -> ProviderRegistry:
    registry = ProviderRegistry(settings.default_tts_provider, settings.default_asr_provider)
    if settings.local_tts.enabled:
        registry.register_tts(LocalTtsProvider(settings.local_tts))
    if settings.faster_whisper.enabled:
        registry.register_asr(FasterWhisperProvider(settings.faster_whisper))
    for http_asr in settings.http_asr:
        if http_asr.enabled:
            registry.register_asr(LocalHttpAsrProvider(http_asr))
    load_provider_extensions(registry, settings)
    return registry


def create_app(
    settings: Settings | None = None,
    registry: ProviderRegistry | None = None,
    playback: PlaybackCoordinator | None = None,
) -> FastAPI:
    current = settings or load_settings()
    providers = registry or default_registry(current)
    transcoder = AudioTranscoder(current.server.temp_dir, current.server.ffmpeg)
    playback_queue = playback or PlaybackCoordinator(current.server.playback_dir)
    logger = logging.getLogger("rabispeech")

    async def microphone_transcriber(audio_path: Path, config: MicrophoneConfig) -> TranscriptionResult:
        return await _transcribe(
            providers,
            audio_path,
            model=config.asr_model,
            provider=None,
            language=config.language,
            prompt=config.prompt,
            word_timestamps=False,
        )

    async def microphone_submitter(route_id: str, text: str, session_id: str) -> None:
        base = _manager_loopback_url()
        async with httpx.AsyncClient(timeout=15.0) as client:
            result = await client.post(
                f"{base}/api/speech/messages",
                json={"gatewayId": route_id, "text": text, "sessionId": session_id},
            )
            result.raise_for_status()

    microphone = MicrophoneService(
        state_path=current.server.temp_dir.parent / "microphone.json",
        temp_dir=current.server.temp_dir,
        transcriber=microphone_transcriber,
        submitter=microphone_submitter,
        playback_active=lambda: bool(playback_queue.snapshot().get("current")),
    )

    @asynccontextmanager
    async def lifespan(_api: FastAPI):
        await providers.warmup()
        await microphone.restore()
        try:
            yield
        finally:
            await microphone.stop(persist=False)

    api = FastAPI(
        title="RabiSpeech Local API",
        version="0.1.0",
        description="Local-only provider gateway for TTS and ASR. RabiLink may proxy these endpoints without exposing the PC.",
        lifespan=lifespan,
    )

    @api.get("/health")
    async def health() -> dict[str, object]:
        return {
            "ok": True,
            "service": "RabiSpeech",
            "local_only": current.server.host in {"127.0.0.1", "localhost", "::1"},
            "providers": public_capabilities(providers.capabilities()),
            "microphone": {"running": microphone.snapshot()["running"], "state": microphone.snapshot()["state"]},
        }

    @api.get("/v1/capabilities")
    async def capabilities() -> dict[str, object]:
        return {
            "object": "rabispeech.capabilities",
            "providers": public_capabilities(providers.capabilities()),
            "api": api_index(),
            "relay_safe": True,
            "streaming": False,
            "microphone": {"running": microphone.snapshot()["running"], "state": microphone.snapshot()["state"], "scope": "loopback-only"},
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

    @api.post("/v1/playback/stop")
    async def playback_stop() -> dict[str, object]:
        return playback_queue.stop(clear_pending=True)

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

    @api.post("/v1/microphone/stop")
    async def microphone_stop() -> dict[str, object]:
        return await microphone.stop()

    async def synthesize(body: SpeechBody, background_tasks: BackgroundTasks) -> FileResponse:
        try:
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
        except KeyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Local TTS request failed")
            raise HTTPException(status_code=502, detail=f"Local TTS failed ({type(exc).__name__}). Check local RabiSpeech logs.") from exc
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
                logger.exception("Local playback enqueue failed")
                raise HTTPException(status_code=502, detail=f"Local playback failed ({type(exc).__name__}). Check local RabiSpeech logs.") from exc
        if artifact.cleanup:
            background_tasks.add_task(artifact.path.unlink, missing_ok=True)
        if prepared.cleanup and prepared.path != artifact.path:
            background_tasks.add_task(prepared.path.unlink, missing_ok=True)
        return FileResponse(
            prepared.path,
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
    ) -> Response:
        audio_path = await _store_upload(file, current)
        background_tasks.add_task(audio_path.unlink, missing_ok=True)
        result = await _transcribe(
            providers,
            audio_path,
            model=model,
            provider=provider,
            language=language,
            prompt=prompt,
            word_timestamps="word" in (timestamp_granularities or []),
        )
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
        result = await _transcribe(
            providers,
            audio_path,
            model=body.model,
            provider=str(body.parameters.get("provider") or "") or None,
            language=language,
            prompt=str(body.parameters.get("prompt") or "") or None,
            word_timestamps=bool(body.parameters.get("enable_words")),
        )
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


async def _transcribe(
    registry: ProviderRegistry,
    audio_path: Path,
    *,
    model: str,
    provider: str | None,
    language: str | None,
    prompt: str | None,
    word_timestamps: bool,
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
            )
        )
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Local ASR failed: {exc}") from exc


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
