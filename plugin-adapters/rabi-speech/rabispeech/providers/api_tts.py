from __future__ import annotations

import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import httpx

from ..config import ApiProviderSettings
from ..contracts import SpeechAudioArtifact, SpeechSynthesisRequest


class ApiTtsProvider:
    def __init__(self, settings: ApiProviderSettings, temp_dir: Path, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.settings = settings
        self.provider_id = settings.id
        self.temp_dir = temp_dir
        self.transport = transport
        self._local_only = _validate_base_url(settings.base_url)

    def capabilities(self) -> dict[str, object]:
        configured = bool(self._api_key()) or self._local_only
        return {
            "kind": "tts",
            "enabled": self.settings.enabled,
            "transport": "openai-compatible-api",
            "local_only": self._local_only,
            "local_files_only": self._local_only,
            "formats": ["wav", "mp3", "flac", "opus", "aac", "pcm"],
            "voice_binding": "provider voice id",
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
        model = self._resolve_model(request.model)
        headers = self._headers()
        payload: dict[str, object] = {
            "model": model,
            "input": request.text,
            "voice": request.voice.strip() or self.settings.default_voice,
            "response_format": request.response_format,
            "speed": request.speed,
        }
        if request.instructions:
            payload["instructions"] = request.instructions

        timeout = httpx.Timeout(self.settings.timeout_seconds, connect=15.0)
        async with httpx.AsyncClient(timeout=timeout, transport=self.transport) as client:
            response = await client.post(f"{self.settings.base_url}/audio/speech", headers=headers, json=payload)
            response.raise_for_status()
        if not response.content:
            raise RuntimeError("Speech API returned empty audio data.")

        suffix = _audio_suffix(request.response_format, response.headers.get("content-type", ""))
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(prefix="rabispeech-api-tts-", suffix=suffix, dir=self.temp_dir, delete=False)
        handle.write(response.content)
        handle.close()
        return SpeechAudioArtifact(
            path=Path(handle.name),
            media_type=response.headers.get("content-type") or _media_type(suffix),
            provider=self.provider_id,
            model=model,
            cleanup=True,
        )

    def _resolve_model(self, requested: str) -> str:
        normalized = requested.strip()
        if normalized.lower() in {"", "default", "tts-api", "tts-1"}:
            normalized = self.settings.default_model
        for model in self.settings.models:
            if model.id.lower() == normalized.lower():
                return model.id
        allowed = ", ".join(model.id for model in self.settings.models)
        raise ValueError(f"Unknown or disallowed {self.provider_id} TTS model {requested!r}. Allowed: {allowed}")

    def _api_key(self) -> str:
        return os.environ.get(self.settings.api_key_env, "").strip() if self.settings.api_key_env else ""

    def _headers(self) -> dict[str, str]:
        key = self._api_key()
        if not key and not self._local_only:
            raise RuntimeError(f"Missing API key environment variable: {self.settings.api_key_env or '<not configured>'}")
        return {"authorization": f"Bearer {key}"} if key else {}


def _validate_base_url(value: str) -> bool:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f"Invalid speech API base URL: {value}")
    local = parsed.hostname.lower() in {"127.0.0.1", "localhost", "::1"}
    if parsed.scheme != "https" and not local:
        raise ValueError("Remote speech API providers must use HTTPS.")
    return local


def _audio_suffix(response_format: str, content_type: str) -> str:
    normalized = response_format.strip().lower()
    if normalized in {"wav", "mp3", "flac", "opus", "aac", "pcm"}:
        return f".{normalized}"
    return {
        "audio/wav": ".wav",
        "audio/mpeg": ".mp3",
        "audio/flac": ".flac",
        "audio/ogg": ".opus",
        "audio/aac": ".aac",
    }.get(content_type.split(";", 1)[0].lower(), ".audio")


def _media_type(suffix: str) -> str:
    return {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".flac": "audio/flac",
        ".opus": "audio/ogg",
        ".aac": "audio/aac",
        ".pcm": "application/octet-stream",
    }.get(suffix, "application/octet-stream")
