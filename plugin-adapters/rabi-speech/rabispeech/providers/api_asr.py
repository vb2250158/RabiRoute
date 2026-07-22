from __future__ import annotations

import json
import os
import wave
from urllib.parse import urlparse

import httpx

from ..config import ApiProviderSettings
from ..contracts import TranscriptSegment, TranscriptionRequest, TranscriptionResult


class ApiAsrProvider:
    def __init__(self, settings: ApiProviderSettings, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.settings = settings
        self.provider_id = settings.id
        self.transport = transport
        self._local_only = _validate_base_url(settings.base_url)

    def capabilities(self) -> dict[str, object]:
        configured = bool(self._api_key()) or self._local_only
        return {
            "kind": "asr",
            "enabled": self.settings.enabled,
            "transport": "openai-compatible-api",
            "local_only": self._local_only,
            "local_files_only": self._local_only,
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
                }
                for model in self.settings.models
            ],
        }

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        if not self.settings.enabled:
            raise RuntimeError(f"{self.provider_id} ASR provider is disabled.")
        model = self._resolve_model(request.model)
        data: dict[str, object] = {"model": model, "response_format": "verbose_json"}
        if request.language:
            data["language"] = request.language
        if request.prompt:
            data["prompt"] = request.prompt
        if request.word_timestamps:
            data["timestamp_granularities[]"] = ["word", "segment"]

        timeout = httpx.Timeout(self.settings.timeout_seconds, connect=15.0)
        with request.audio_path.open("rb") as source:
            files = {"file": (request.audio_path.name, source, "application/octet-stream")}
            async with httpx.AsyncClient(timeout=timeout, transport=self.transport) as client:
                response = await client.post(
                    f"{self.settings.base_url}/audio/transcriptions",
                    headers=self._headers(),
                    data=data,
                    files=files,
                )
                response.raise_for_status()
        try:
            payload = response.json()
        except json.JSONDecodeError as exc:
            raise RuntimeError("Speech API returned non-JSON transcription data.") from exc
        segments = [
            TranscriptSegment(
                id=int(item.get("id", index)),
                start=float(item.get("start", 0.0)),
                end=float(item.get("end", 0.0)),
                text=str(item.get("text") or ""),
                words=list(item.get("words") or []),
            )
            for index, item in enumerate(payload.get("segments") or [])
            if isinstance(item, dict)
        ]
        return TranscriptionResult(
            text=str(payload.get("text") or "").strip(),
            language=str(payload.get("language") or request.language or ""),
            duration=float(payload.get("duration") or _wav_duration(request.audio_path)),
            provider=self.provider_id,
            model=model,
            segments=segments,
        )

    def _resolve_model(self, requested: str) -> str:
        normalized = requested.strip()
        if normalized.lower() in {"", "default", "asr-api"}:
            normalized = self.settings.default_model
        for model in self.settings.models:
            if model.id.lower() == normalized.lower():
                return model.id
        allowed = ", ".join(model.id for model in self.settings.models)
        raise ValueError(f"Unknown or disallowed {self.provider_id} ASR model {requested!r}. Allowed: {allowed}")

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


def _wav_duration(path) -> float:
    try:
        with wave.open(str(path), "rb") as source:
            return source.getnframes() / max(1, source.getframerate())
    except (wave.Error, OSError):
        return 0.0
