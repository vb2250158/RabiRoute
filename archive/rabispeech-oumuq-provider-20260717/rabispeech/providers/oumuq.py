"""Archived OumuQ HTTP hop retained for migration history only."""

from __future__ import annotations

import asyncio
from pathlib import Path
from urllib.parse import urlencode

import httpx

from ..config import OumuqSettings
from ..contracts import SpeechAudioArtifact, SpeechSynthesisRequest
from ..worker_supervisor import worker_supervisor


class OumuqTtsProvider:
    provider_id = "oumuq"

    def __init__(self, settings: OumuqSettings) -> None:
        self.settings = settings

    def capabilities(self) -> dict[str, object]:
        return {
            "kind": "tts",
            "enabled": self.settings.enabled,
            "transport": "http",
            "base_url": self.settings.base_url,
            "formats": ["wav", "mp3", "flac", "opus", "aac", "pcm"],
            "voice_binding": "OumuQ character_id or fixed worker speaker",
            "model": self.settings.model,
            "models": [
                {
                    "id": model.id,
                    "name": model.name,
                    "family": model.family,
                    "installed": model.installed,
                    "loaded": False,
                    "languages": list(model.languages),
                    "features": list(model.features),
                    "parameters": self._model_parameters(model.id),
                }
                for model in self.settings.models
            ],
        }

    async def synthesize(self, request: SpeechSynthesisRequest) -> SpeechAudioArtifact:
        if not self.settings.enabled:
            raise RuntimeError("OumuQ TTS provider is disabled.")
        model = self._resolve_model(request.model)
        if not model.installed:
            raise ValueError(f"Local TTS model is not installed: {model.id}")
        payload: dict[str, object] = {
            "text": request.text,
            "play": False,
            "speed": request.speed,
        }
        voice = request.voice.strip() or self.settings.default_voice
        if voice and voice.lower() not in {"default", "auto"}:
            if voice.lower().startswith("speaker:"):
                payload["speaker"] = voice.split(":", 1)[1].strip()
            else:
                payload["character_id"] = voice
        worker_url = model.worker_url or self.settings.default_worker_url
        if worker_url:
            await worker_supervisor.ensure(f"tts:{model.id}", worker_url, model.launch)
            payload["worker_url"] = worker_url
        if request.language:
            payload["language"] = request.language
        if request.instructions:
            payload["instructions"] = request.instructions
        payload["model"] = model.id

        timeout = httpx.Timeout(self.settings.timeout_seconds, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(f"{self.settings.base_url}/api/speak", json=payload)
            response.raise_for_status()
            submitted = response.json()
            worker_response = submitted.get("worker_response") if isinstance(submitted, dict) else None
            resolved_request = submitted.get("request") if isinstance(submitted, dict) else None
            if not isinstance(worker_response, dict):
                raise RuntimeError("OumuQ response has no worker_response object.")
            job_id = str(worker_response.get("id") or "").strip()
            worker_url = str((resolved_request or {}).get("worker_url") or self.settings.default_worker_url).strip()
            if not job_id or not worker_url:
                raise RuntimeError("OumuQ response has no job id or resolved worker URL.")
            status = worker_response
            deadline = asyncio.get_running_loop().time() + self.settings.timeout_seconds
            while str(status.get("status") or "").lower() not in {"done", "error", "failed", "missing"}:
                if asyncio.get_running_loop().time() >= deadline:
                    raise TimeoutError(f"Timed out waiting for OumuQ worker job {job_id}.")
                await asyncio.sleep(0.1)
                query = urlencode({"worker_url": worker_url})
                polled = await client.get(f"{self.settings.base_url}/api/worker/status/{job_id}?{query}")
                polled.raise_for_status()
                status = polled.json()

        state = str(status.get("status") or "").lower()
        if state != "done":
            raise RuntimeError(str(status.get("error") or f"OumuQ worker ended with status {state}."))
        output = self._safe_output_path(status.get("output"))
        return SpeechAudioArtifact(
            path=output,
            media_type="audio/wav" if output.suffix.lower() == ".wav" else "application/octet-stream",
            provider=self.provider_id,
            model=model.id,
        )

    def _resolve_model(self, requested: str):
        normalized = requested.strip().lower()
        if normalized in {"", "default", "tts-local", "tts-1"}:
            normalized = self.settings.model.lower()
        for model in self.settings.models:
            if model.id.lower() == normalized:
                return model
        allowed = ", ".join(model.id for model in self.settings.models)
        raise ValueError(f"Unknown or disallowed local TTS model {requested!r}. Allowed: {allowed}")

    @staticmethod
    def _model_parameters(model_id: str) -> dict[str, object]:
        if model_id == "onnx-vits":
            return {"voice": {"type": "string", "description": "Use speaker:<numeric-id> or an OumuQ character id."}}
        return {
            "voice": {"type": "string", "description": "OumuQ character id backed by local reference audio."},
            "instructions": {"type": ["string", "null"], "description": "Optional style/emotion instruction when supported."},
        }

    def _safe_output_path(self, value: object) -> Path:
        output = Path(str(value or "")).expanduser().resolve()
        if not output.is_file():
            raise RuntimeError("OumuQ worker completed without a readable audio file.")
        if output.suffix.lower() not in {".wav", ".mp3", ".flac", ".ogg", ".opus", ".aac"}:
            raise RuntimeError("OumuQ worker returned an unsupported output file type.")
        if not any(output.is_relative_to(root) for root in self.settings.allowed_output_roots):
            raise RuntimeError("OumuQ worker output is outside the configured local output roots.")
        return output
