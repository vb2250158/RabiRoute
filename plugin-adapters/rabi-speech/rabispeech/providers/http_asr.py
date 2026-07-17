from __future__ import annotations

import asyncio
import base64
import wave
from urllib.parse import urlparse

import httpx

from ..config import HttpAsrModelSettings, HttpAsrProviderSettings
from ..contracts import TranscriptSegment, TranscriptionRequest, TranscriptionResult
from ..worker_supervisor import worker_supervisor


class LocalHttpAsrProvider:
    def __init__(self, settings: HttpAsrProviderSettings) -> None:
        self.settings = settings
        self.provider_id = settings.id
        self._loaded_model = ""
        for model in settings.models:
            parsed = urlparse(model.base_url)
            if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
                raise ValueError(f"Local HTTP ASR worker must use a loopback URL: {model.base_url}")
        self._lock = asyncio.Lock()

    def capabilities(self) -> dict[str, object]:
        return {
            "kind": "asr",
            "enabled": self.settings.enabled,
            "model": self.settings.default_model,
            "transport": "loopback-http",
            "models": [
                {
                    "id": model.id,
                    "name": model.name,
                    "family": model.family,
                    "source": model.source,
                    "installed": model.installed,
                    "loaded": self._loaded_model == model.id,
                    "languages": list(model.languages),
                    "features": list(model.features),
                }
                for model in self.settings.models
            ],
            "formats": ["wav", "mp3", "flac", "m4a", "ogg", "opus", "webm", "mp4"],
        }

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        if not self.settings.enabled:
            raise RuntimeError(f"{self.provider_id} ASR provider is disabled.")
        model = self._resolve_model(request.model)
        if not model.installed:
            raise ValueError(f"Local ASR model is not installed: {model.id}")
        payload = {
            "audio_base64": base64.b64encode(request.audio_path.read_bytes()).decode("ascii"),
            "filename": request.audio_path.name,
            "language": request.language,
            "prompt": request.prompt,
            "word_timestamps": request.word_timestamps,
        }
        timeout = httpx.Timeout(self.settings.timeout_seconds, connect=10.0)
        async with self._lock:
            await worker_supervisor.ensure(f"asr:{self.provider_id}:{model.id}", model.base_url, model.launch)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(f"{model.base_url}/transcribe", json=payload)
            response.raise_for_status()
            data = response.json()
            self._loaded_model = model.id
        segments = [
            TranscriptSegment(
                id=int(item.get("id", index)),
                start=float(item.get("start", 0.0)),
                end=float(item.get("end", 0.0)),
                text=str(item.get("text") or ""),
                words=list(item.get("words") or []),
            )
            for index, item in enumerate(data.get("segments") or [])
            if isinstance(item, dict)
        ]
        return TranscriptionResult(
            text=str(data.get("text") or "").strip(),
            language=str(data.get("language") or request.language or ""),
            duration=float(data.get("duration") or _wav_duration(request.audio_path)),
            provider=self.provider_id,
            model=model.id,
            segments=segments,
        )

    def _resolve_model(self, requested: str) -> HttpAsrModelSettings:
        normalized = requested.strip().lower()
        if normalized in {"", "default", "asr-local"}:
            normalized = self.settings.default_model.lower()
        for model in self.settings.models:
            if model.id.lower() == normalized:
                return model
        allowed = ", ".join(model.id for model in self.settings.models)
        raise ValueError(f"Unknown or disallowed {self.provider_id} model {requested!r}. Allowed: {allowed}")


def _wav_duration(path) -> float:
    try:
        with wave.open(str(path), "rb") as source:
            return source.getnframes() / max(1, source.getframerate())
    except (wave.Error, OSError):
        return 0.0
