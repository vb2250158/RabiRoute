from __future__ import annotations

import base64
import asyncio
import json
import os
import re
import tempfile
import wave
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import httpx

from ..config import ApiProviderSettings
from ..contracts import SpeechAudioArtifact, SpeechSynthesisRequest, TranscriptSegment, TranscriptionRequest, TranscriptionResult
from ..persona_voice import persona_voice_dir, resolve_persona_role_dir


_GENERATION_PATH = "/api/v1/services/aigc/multimodal-generation/generation"
_TRANSCRIPTION_PATH = "/api/v1/services/audio/asr/transcription"


class _DashScopeMeetingTaskError(RuntimeError):
    def __init__(self, *, task_id: str, status: str, code: str = "") -> None:
        self.task_id = task_id
        self.status = status
        self.code = code
        detail = (
            f"DashScope meeting ASR task failed; task_id={_safe_identifier(task_id)}; "
            f"status={_safe_identifier(status)}"
        )
        if code:
            detail += f"; code={_safe_identifier(code)}"
        super().__init__(detail + ".")


class DashScopeTtsProvider:
    def __init__(
        self,
        settings: ApiProviderSettings,
        temp_dir: Path,
        transport: httpx.AsyncBaseTransport | None = None,
        roles_root: Path | None = None,
    ) -> None:
        self.settings = settings
        self.provider_id = settings.id
        self.temp_dir = temp_dir
        self.transport = transport
        self.roles_root = roles_root
        _validate_remote_base_url(settings.base_url)

    def capabilities(self) -> dict[str, object]:
        configured = bool(self._api_key())
        return {
            "kind": "tts",
            "enabled": self.settings.enabled,
            "transport": "dashscope-multimodal-generation",
            "local_only": False,
            "local_files_only": False,
            "formats": ["wav", "mp3", "flac", "opus", "aac", "pcm"],
            "voice_binding": "DashScope voice or voice id",
            "model": self.settings.default_model,
            "models": [
                {
                    "id": model.id,
                    "name": model.name,
                    "family": self.provider_id,
                    "installed": configured,
                    "languages": list(model.languages),
                    "features": list(model.features),
                    "status": "ready" if configured else "missing_api_key",
                    "parameters": {
                        "voice": {"type": "string", "default": self.settings.default_voice},
                        "instructions": {"type": ["string", "null"]},
                    },
                }
                for model in self.settings.models
            ],
        }

    async def synthesize(self, request: SpeechSynthesisRequest) -> SpeechAudioArtifact:
        if not self.settings.enabled:
            raise RuntimeError(f"{self.provider_id} TTS provider is disabled.")
        model = _resolve_model(self.settings, request.model, {"", "default", "tts-api"})
        voice = self._resolve_voice(request.voice.strip() or self.settings.default_voice, model)
        if not voice:
            raise ValueError("DashScope TTS requires a voice or voice id.")
        input_payload: dict[str, object] = {
            "text": request.text,
            "voice": voice,
            "language_type": request.language or "Auto",
            "stream": False,
        }
        if model.lower().startswith("qwen3-tts-instruct-") and request.instructions:
            input_payload["instructions"] = request.instructions
            input_payload["optimize_instructions"] = True
        payload = {"model": model, "input": input_payload}

        timeout = httpx.Timeout(self.settings.timeout_seconds, connect=15.0)
        async with httpx.AsyncClient(timeout=timeout, transport=self.transport) as client:
            response = await client.post(
                _generation_url(self.settings.base_url),
                headers=self._headers(),
                json=payload,
            )
            _raise_safe_status(response, "DashScope TTS")
            data = _json_object(response, "DashScope TTS")
            _raise_provider_error(data, "DashScope TTS")
            raw, media_type = await _dashscope_audio(client, data)
        if not raw:
            raise RuntimeError("DashScope TTS returned empty audio data.")

        suffix = _suffix_for_media_type(media_type)
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(prefix="rabispeech-dashscope-tts-", suffix=suffix, dir=self.temp_dir, delete=False)
        handle.write(raw)
        handle.close()
        return SpeechAudioArtifact(
            path=Path(handle.name),
            media_type=media_type,
            provider=self.provider_id,
            model=model,
            cleanup=True,
        )

    def _api_key(self) -> str:
        return os.environ.get(self.settings.api_key_env, "").strip()

    def _resolve_voice(self, requested: str, model: str) -> str:
        if not self.roles_root or not requested:
            return requested
        role_dir = resolve_persona_role_dir(self.roles_root, requested)
        voice_dir = persona_voice_dir(role_dir)
        if voice_dir is None:
            return requested
        profile_path = voice_dir / "voice-profile.json"
        if not profile_path.is_file():
            return requested
        try:
            profile = json.loads(profile_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            return requested
        engine_options = profile.get("engine_options") if isinstance(profile, dict) else None
        if not isinstance(engine_options, dict):
            return requested
        options = engine_options.get(self.provider_id) or engine_options.get("dashscope")
        if not isinstance(options, dict):
            return requested
        configured_model = str(options.get("model") or "").strip()
        if configured_model and configured_model.lower() != model.lower():
            raise ValueError(
                f"Persona {requested!r} requires model {configured_model!r}, not {model!r}."
            )
        voice_env = str(options.get("voice_env") or "").strip()
        voice = _environment_value(voice_env) if voice_env else ""
        if not voice:
            raise RuntimeError(
                f"Persona {requested!r} requires voice environment variable: {voice_env or '<not configured>'}"
            )
        return voice

    def _headers(self) -> dict[str, str]:
        key = self._api_key()
        if not key:
            raise RuntimeError(f"Missing API key environment variable: {self.settings.api_key_env or '<not configured>'}")
        return {"authorization": f"Bearer {key}", "content-type": "application/json"}


class DashScopeAsrProvider:
    def __init__(
        self,
        settings: ApiProviderSettings,
        transport: httpx.AsyncBaseTransport | None = None,
        uploader: Callable[[str, Path, str], str] | None = None,
    ) -> None:
        self.settings = settings
        self.provider_id = settings.id
        self.transport = transport
        self.uploader = uploader
        _validate_remote_base_url(settings.base_url)

    def capabilities(self) -> dict[str, object]:
        configured = bool(self._api_key())
        return {
            "kind": "asr",
            "enabled": self.settings.enabled,
            "transport": "dashscope-multimodal-generation",
            "local_only": False,
            "local_files_only": False,
            "model": self.settings.default_model,
            "formats": ["wav", "mp3", "flac", "m4a", "ogg", "opus", "webm", "mp4", "aac"],
            "models": [
                {
                    "id": model.id,
                    "name": model.name,
                    "family": self.provider_id,
                    "installed": configured,
                    "languages": list(model.languages),
                    "features": list(model.features),
                    "status": "ready" if configured else "missing_api_key",
                    **(
                        {
                            "parameters": {
                                "speaker_count": {
                                    "type": ["integer", "null"],
                                    "minimum": 1,
                                    "description": "Optional known participant count for speaker diarization.",
                                }
                            }
                        }
                        if "speaker_diarization" in {feature.lower() for feature in model.features}
                        else {}
                    ),
                }
                for model in self.settings.models
            ],
        }

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        if not self.settings.enabled:
            raise RuntimeError(f"{self.provider_id} ASR provider is disabled.")
        model = _resolve_model(self.settings, request.model, {"", "default", "asr-api"})
        if _is_diarization_model(self.settings, model):
            return await self._transcribe_meeting(request, model)
        prompt = request.prompt or "Please transcribe this audio accurately."
        payload: dict[str, object] = {
            "model": model,
            "input": {
                "messages": [
                    {"role": "system", "content": [{"text": prompt}]},
                    {"role": "user", "content": [{"audio": _audio_data_uri(request.audio_path)}]},
                ]
            },
            "parameters": {"asr_options": {"enable_itn": False}},
        }
        if request.language:
            payload["parameters"]["asr_options"]["language"] = request.language  # type: ignore[index]

        timeout = httpx.Timeout(self.settings.timeout_seconds, connect=15.0)
        async with httpx.AsyncClient(timeout=timeout, transport=self.transport) as client:
            response = await client.post(
                _generation_url(self.settings.base_url),
                headers=self._headers(),
                json=payload,
            )
            _raise_safe_status(response, "DashScope ASR")
        data = _json_object(response, "DashScope ASR")
        _raise_provider_error(data, "DashScope ASR")
        text = _extract_text(data).strip()
        if not text:
            request_id = _safe_identifier(data.get("request_id") or data.get("requestId"))
            raise RuntimeError(f"DashScope ASR response did not contain transcript text; request_id={request_id}.")
        return TranscriptionResult(
            text=text,
            language=request.language or "",
            duration=_wav_duration(request.audio_path),
            provider=self.provider_id,
            model=model,
        )

    async def _transcribe_meeting(self, request: TranscriptionRequest, model: str) -> TranscriptionResult:
        key = self._api_key()
        if not key:
            raise RuntimeError(f"Missing API key environment variable: {self.settings.api_key_env or '<not configured>'}")
        audio_url = (
            await asyncio.to_thread(self.uploader, model, request.audio_path, key)
            if self.uploader
            else _audio_data_uri(request.audio_path)
        )
        parameters: dict[str, object] = {"diarization_enabled": True}
        if request.language and request.language.strip().lower() not in {"auto", "automatic"}:
            parameters["language_hints"] = [request.language.strip()]
        if request.speaker_count and request.speaker_count > 0:
            parameters["speaker_count"] = request.speaker_count
        payload = {"model": model, "input": {"file_urls": [audio_url]}, "parameters": parameters}
        timeout = httpx.Timeout(self.settings.timeout_seconds, connect=15.0)
        async with httpx.AsyncClient(timeout=timeout, transport=self.transport) as client:
            response = await client.post(
                self.settings.base_url.rstrip("/") + _TRANSCRIPTION_PATH,
                headers={**self._headers(), "x-dashscope-async": "enable"},
                json=payload,
            )
            _raise_safe_status(response, "DashScope meeting ASR submit")
            submitted = _json_object(response, "DashScope meeting ASR submit")
            _raise_provider_error(submitted, "DashScope meeting ASR submit")
            task_id = _task_id(submitted)
            if not task_id:
                raise RuntimeError("DashScope meeting ASR submit did not return a task id.")
            try:
                result = await _poll_task(
                    client,
                    self.settings.base_url,
                    task_id,
                    self.settings.timeout_seconds,
                    self._headers(),
                )
            except _DashScopeMeetingTaskError as exc:
                if exc.code.upper() == "SUCCESS_WITH_NO_VALID_FRAGMENT":
                    return TranscriptionResult(
                        text="",
                        language=request.language or "",
                        duration=_wav_duration(request.audio_path),
                        provider=self.provider_id,
                        model=model,
                    )
                raise
            result_url = _transcription_result_url(result)
            if result_url:
                parsed = urlparse(result_url)
                if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                    raise RuntimeError("DashScope meeting ASR returned an unsafe result URL.")
                downloaded = await client.get(result_url)
                _raise_safe_status(downloaded, "DashScope meeting ASR result download")
                result = _json_object(downloaded, "DashScope meeting ASR result download")

        segments = _meeting_segments(result)
        if not segments:
            text = _extract_text(result).strip()
            if not text:
                raise RuntimeError(f"DashScope meeting ASR returned no speaker turns; task_id={_safe_identifier(task_id)}.")
        else:
            text = "\n".join(f"[{segment.speaker or 'speaker'}] {segment.text}" for segment in segments)
        duration = max((segment.end for segment in segments), default=_wav_duration(request.audio_path))
        return TranscriptionResult(
            text=text,
            language=request.language or "",
            duration=duration,
            provider=self.provider_id,
            model=model,
            segments=segments,
        )

    def _api_key(self) -> str:
        return os.environ.get(self.settings.api_key_env, "").strip()

    def _headers(self) -> dict[str, str]:
        key = self._api_key()
        if not key:
            raise RuntimeError(f"Missing API key environment variable: {self.settings.api_key_env or '<not configured>'}")
        return {"authorization": f"Bearer {key}", "content-type": "application/json"}


def _generation_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    return normalized if normalized.endswith(_GENERATION_PATH) else normalized + _GENERATION_PATH


def _is_diarization_model(settings: ApiProviderSettings, model_id: str) -> bool:
    for model in settings.models:
        if model.id.lower() == model_id.lower():
            return "speaker_diarization" in {feature.lower() for feature in model.features}
    return False


async def _poll_task(
    client: httpx.AsyncClient,
    base_url: str,
    task_id: str,
    timeout_seconds: float,
    headers: dict[str, str],
) -> dict[str, object]:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    task_url = base_url.rstrip("/") + f"/api/v1/tasks/{task_id}"
    last_status = "unknown"
    while asyncio.get_running_loop().time() < deadline:
        response = await client.post(task_url, headers=headers)
        _raise_safe_status(response, "DashScope meeting ASR poll")
        payload = _json_object(response, "DashScope meeting ASR poll")
        _raise_provider_error(payload, "DashScope meeting ASR poll")
        output = payload.get("output")
        last_status = str(output.get("task_status") if isinstance(output, dict) else payload.get("task_status") or "").upper()
        if last_status in {"SUCCEEDED", "SUCCESS"}:
            return payload
        if last_status in {"FAILED", "CANCELED", "UNKNOWN"}:
            raise _DashScopeMeetingTaskError(
                task_id=task_id,
                status=last_status,
                code=_task_failure_code(payload),
            )
        await asyncio.sleep(2.0)
    raise RuntimeError(f"DashScope meeting ASR task timed out; task_id={_safe_identifier(task_id)}; status={_safe_identifier(last_status)}.")


def _task_id(payload: dict[str, object]) -> str:
    output = payload.get("output")
    return str(output.get("task_id") if isinstance(output, dict) else payload.get("task_id") or "").strip()


def _task_failure_code(payload: dict[str, object]) -> str:
    output = payload.get("output")
    if not isinstance(output, dict):
        return ""
    results = output.get("results")
    if isinstance(results, list):
        for result in results:
            if not isinstance(result, dict):
                continue
            code = str(result.get("code") or "").strip()
            if code:
                return code
    return str(output.get("code") or "").strip()


def _transcription_result_url(payload: dict[str, object]) -> str:
    output = payload.get("output")
    results = output.get("results") if isinstance(output, dict) else None
    if isinstance(results, list) and results and isinstance(results[0], dict):
        return str(results[0].get("transcription_url") or results[0].get("url") or "").strip()
    return ""


def _meeting_segments(payload: object) -> list[TranscriptSegment]:
    items: list[dict[str, object]] = []

    def collect(value: object) -> None:
        if isinstance(value, list):
            for child in value:
                collect(child)
            return
        if not isinstance(value, dict):
            return
        has_speaker = any(
            key in value and value.get(key) is not None and str(value.get(key)).strip() != ""
            for key in ("speaker_id", "speaker", "channel_id")
        )
        has_time = any(key in value for key in ("begin_time", "start_time", "start")) and any(
            key in value for key in ("end_time", "stop_time", "end")
        )
        if has_speaker and has_time and any(key in value for key in ("text", "sentence")):
            items.append(value)
        for child in value.values():
            collect(child)

    collect(payload)
    segments: list[TranscriptSegment] = []
    seen: set[tuple[float, float, str, str]] = set()
    for item in items:
        text = str(item.get("text") or item.get("sentence") or "").strip()
        start = _seconds(item.get("begin_time", item.get("start_time", item.get("start", 0.0))))
        end = _seconds(item.get("end_time", item.get("stop_time", item.get("end", start))))
        speaker_value = next(
            (item.get(key) for key in ("speaker_id", "speaker", "channel_id") if key in item and item.get(key) is not None),
            "",
        )
        speaker = str(speaker_value).strip()
        key = (start, end, text, speaker)
        if not text or end <= start or key in seen:
            continue
        seen.add(key)
        segments.append(TranscriptSegment(id=len(segments), start=start, end=end, text=text, speaker=speaker or None))
    return sorted(segments, key=lambda item: (item.start, item.end, item.id))


def _seconds(value: object) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number / 1000.0 if number > 100.0 else number


def _validate_remote_base_url(value: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("DashScope API base URL must be an HTTPS URL without embedded credentials.")


def _resolve_model(settings: ApiProviderSettings, requested: str, aliases: set[str]) -> str:
    normalized = requested.strip()
    if normalized.lower() in aliases:
        normalized = settings.default_model
    for model in settings.models:
        if model.id.lower() == normalized.lower():
            return model.id
    allowed = ", ".join(model.id for model in settings.models)
    raise ValueError(f"Unknown or disallowed {settings.id} model {requested!r}. Allowed: {allowed}")


def _raise_safe_status(response: httpx.Response, label: str) -> None:
    if response.is_error:
        request_id = _safe_identifier(response.headers.get("x-request-id") or response.headers.get("request-id"))
        raise RuntimeError(f"{label} HTTP {response.status_code}; request_id={request_id}.")


def _json_object(response: httpx.Response, label: str) -> dict[str, object]:
    try:
        payload = response.json()
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{label} returned a non-JSON response.") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"{label} returned an invalid JSON object response.")
    return payload


def _raise_provider_error(payload: dict[str, object], label: str) -> None:
    code = payload.get("code")
    status = payload.get("status_code", 200)
    try:
        failed_status = int(status) >= 400
    except (TypeError, ValueError):
        failed_status = True
    if code or failed_status:
        request_id = _safe_identifier(payload.get("request_id") or payload.get("requestId"))
        safe_code = _safe_identifier(code)
        raise RuntimeError(f"{label} provider error; code={safe_code}; request_id={request_id}.")


async def _dashscope_audio(client: httpx.AsyncClient, payload: dict[str, object]) -> tuple[bytes, str]:
    output = payload.get("output")
    audio = output.get("audio") if isinstance(output, dict) else None
    if not isinstance(audio, dict):
        raise RuntimeError("DashScope TTS response did not include audio metadata.")
    encoded = audio.get("data")
    if isinstance(encoded, str) and encoded:
        try:
            return base64.b64decode(encoded, validate=True), _audio_media_type(audio)
        except ValueError as exc:
            raise RuntimeError("DashScope TTS returned invalid Base64 audio data.") from exc
    url = audio.get("url")
    if isinstance(url, str) and url:
        parsed = urlparse(url)
        if parsed.scheme == "http" and _is_dashscope_oss_host(parsed.hostname):
            parsed = parsed._replace(scheme="https")
            url = urlunparse(parsed)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise RuntimeError("DashScope TTS returned an unsafe audio URL.")
        response = await client.get(url)
        _raise_safe_status(response, "DashScope TTS audio download")
        return response.content, response.headers.get("content-type", "").split(";", 1)[0] or _audio_media_type(audio)
    raise RuntimeError("DashScope TTS response did not include audio data or URL.")


def _audio_media_type(audio: dict[str, object]) -> str:
    value = str(audio.get("response_format") or audio.get("format") or "wav").lower()
    return {
        "wav": "audio/wav",
        "mp3": "audio/mpeg",
        "flac": "audio/flac",
        "opus": "audio/ogg",
        "aac": "audio/aac",
        "pcm": "application/octet-stream",
    }.get(value, "audio/wav")


def _is_dashscope_oss_host(hostname: str | None) -> bool:
    normalized = str(hostname or "").lower()
    return bool(re.fullmatch(r"[a-z0-9.-]+\.oss-[a-z0-9-]+\.aliyuncs\.com", normalized))


def _suffix_for_media_type(media_type: str) -> str:
    return {
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mpeg": ".mp3",
        "audio/flac": ".flac",
        "audio/ogg": ".opus",
        "audio/aac": ".aac",
    }.get(media_type.lower(), ".audio")


def _audio_data_uri(path: Path) -> str:
    media_type = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".flac": "audio/flac",
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
        ".ogg": "audio/ogg",
        ".opus": "audio/ogg",
        ".webm": "audio/webm",
        ".aac": "audio/aac",
    }.get(path.suffix.lower(), "application/octet-stream")
    return f"data:{media_type};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


def _extract_text(payload: object) -> str:
    if isinstance(payload, str):
        return payload
    if isinstance(payload, list):
        return " ".join(filter(None, (_extract_text(item).strip() for item in payload)))
    if not isinstance(payload, dict):
        return ""
    output = payload.get("output")
    if isinstance(output, dict):
        direct = _content_text(output.get("text"))
        if direct:
            return direct
    for choices in ((output or {}).get("choices") if isinstance(output, dict) else None, payload.get("choices")):
        if not isinstance(choices, list):
            continue
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            text = _content_text(message.get("content") if isinstance(message, dict) else choice.get("content"))
            if text:
                return text
    found: list[str] = []
    for key, value in payload.items():
        if key in {"text", "transcript"} and isinstance(value, str):
            found.append(value)
        elif isinstance(value, (dict, list)):
            nested = _extract_text(value)
            if nested:
                found.append(nested)
    return " ".join(part.strip() for part in found if part.strip())


def _content_text(value: object) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return " ".join(filter(None, (_content_text(item) for item in value)))
    if isinstance(value, dict):
        return " ".join(
            filter(None, (_content_text(value.get(key)) for key in ("text", "transcript", "content")))
        )
    return ""


def _safe_identifier(value: object) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value or "unknown"))[:120]


def _environment_value(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if value or os.name != "nt":
        return value
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            raw, _kind = winreg.QueryValueEx(key, name)
        return str(raw or "").strip()
    except (FileNotFoundError, OSError):
        return ""


def _wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as source:
            sample_rate = max(1, source.getframerate())
            channels = max(1, source.getnchannels())
            sample_width = max(1, source.getsampwidth())
            header_duration = source.getnframes() / sample_rate
            file_duration_ceiling = path.stat().st_size / (sample_rate * channels * sample_width)
            return min(header_duration, file_duration_ceiling)
    except (wave.Error, OSError):
        return 0.0
