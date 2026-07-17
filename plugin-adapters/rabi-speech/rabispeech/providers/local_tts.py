from __future__ import annotations

import asyncio
from pathlib import Path

import httpx

from ..config import LocalTtsSettings
from ..contracts import SpeechAudioArtifact, SpeechSynthesisRequest
from ..worker_supervisor import worker_supervisor


class LocalTtsProvider:
    """Call Rabi-owned local TTS workers directly, without an OumuQ service hop."""

    provider_id = "local-tts"

    def __init__(self, settings: LocalTtsSettings) -> None:
        self.settings = settings

    def capabilities(self) -> dict[str, object]:
        return {
            "kind": "tts",
            "enabled": self.settings.enabled,
            "transport": "local-worker-http",
            "formats": ["wav", "mp3", "flac", "opus", "aac", "pcm"],
            "voice_binding": "Rabi persona id or fixed worker speaker",
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
            raise RuntimeError("Local TTS provider is disabled.")
        model = self._resolve_model(request.model)
        if not model.installed:
            raise ValueError(f"Local TTS model is not installed: {model.id}")
        worker_url = model.worker_url or self.settings.default_worker_url
        if not worker_url:
            raise RuntimeError(f"Local TTS model has no worker URL: {model.id}")
        await worker_supervisor.ensure(f"tts:{model.id}", worker_url, model.launch)

        payload: dict[str, object] = {
            "text": request.text,
            "play": False,
            "speed": request.speed,
            "model": model.id,
        }
        voice = request.voice.strip() or self.settings.default_voice
        if voice and voice.lower() not in {"default", "auto"}:
            if voice.lower().startswith("speaker:"):
                fixed_speaker = voice.split(":", 1)[1].strip()
                if fixed_speaker.isdecimal():
                    payload["speaker_id"] = int(fixed_speaker)
                else:
                    payload["speaker"] = fixed_speaker
            else:
                payload["character_id"] = voice
        if request.language:
            payload["language"] = request.language
        if request.instructions:
            payload["instructions"] = request.instructions

        timeout = httpx.Timeout(self.settings.timeout_seconds, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(f"{worker_url}/speak", json=payload)
            response.raise_for_status()
            status = response.json()
            job_id = str(status.get("id") or "").strip() if isinstance(status, dict) else ""
            if not job_id:
                raise RuntimeError("Local TTS worker returned no job id.")
            deadline = asyncio.get_running_loop().time() + self.settings.timeout_seconds
            while str(status.get("status") or "").lower() not in {"done", "error", "failed", "missing"}:
                if asyncio.get_running_loop().time() >= deadline:
                    raise TimeoutError(f"Timed out waiting for local TTS worker job {job_id}.")
                await asyncio.sleep(0.1)
                polled = await client.get(f"{worker_url}/status/{job_id}")
                polled.raise_for_status()
                status = polled.json()

        state = str(status.get("status") or "").lower()
        if state != "done":
            raise RuntimeError(f"Local TTS worker failed for model {model.id} (state={state}).")
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
            return {"voice": {"type": "string", "description": "Use speaker:<numeric-id> for a fixed speaker."}}
        return {
            "voice": {"type": "string", "description": "Rabi persona id backed by data/roles/<RoleId>/voice/."},
            "instructions": {"type": ["string", "null"], "description": "Optional local style/emotion instruction when supported."},
        }

    def _safe_output_path(self, value: object) -> Path:
        output = Path(str(value or "")).expanduser().resolve()
        if not output.is_file():
            raise RuntimeError("Local TTS worker completed without a readable audio file.")
        if output.suffix.lower() not in {".wav", ".mp3", ".flac", ".ogg", ".opus", ".aac"}:
            raise RuntimeError("Local TTS worker returned an unsupported output file type.")
        if not any(output.is_relative_to(root) for root in self.settings.allowed_output_roots):
            raise RuntimeError("Local TTS worker output is outside the configured local output roots.")
        return output
