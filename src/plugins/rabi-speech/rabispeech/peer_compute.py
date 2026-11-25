"""Microphone compute follows the Manager's selected service; device capture stays local."""
from __future__ import annotations

from .timeout_settings import get_timeout_seconds


from dataclasses import fields
from pathlib import Path
from typing import Any

import httpx

from .contracts import TranscriptSegment, TranscriptionResult


async def selected_remote_transcription(manager_url: str, audio_path: Path, *, model: str, language: str | None, prompt: str | None, device_id: str | None = None) -> TranscriptionResult | None:
    if device_id == "":
        return None
    async with httpx.AsyncClient(timeout=get_timeout_seconds("speech.peer.request", 190), follow_redirects=False) as client:
        if device_id is None:
            selection = await client.get(f"{manager_url}/api/rabilink/peer/selection", timeout=get_timeout_seconds("speech.peer.selection", 5))
            if selection.status_code == 404:
                return None
            selection.raise_for_status()
            if not selection.json().get("selectedDeviceId"):
                return None
        payload = {"model": model, "response_format": "verbose_json", "word_timestamps": "true"}
        if language:
            payload["language"] = language
        if prompt:
            payload["prompt"] = prompt
        options = {"params": {"computeDeviceId": device_id}} if device_id is not None else {}
        with audio_path.open("rb") as source:
            response = await client.post(
                f"{manager_url}/api/speech/asr",
                data=payload, files={"file": (audio_path.name, source, "audio/wav")},
                **options,
            )
        response.raise_for_status()
        return transcription_result(response.json(), model)


def transcription_result(value: dict[str, Any], model: str) -> TranscriptionResult:
    allowed = {field.name for field in fields(TranscriptSegment)}
    segments = [TranscriptSegment(**{key: item for key, item in segment.items() if key in allowed}) for segment in value.get("segments", [])]
    return TranscriptionResult(text=str(value.get("text", "")), language=str(value.get("language", "")), duration=float(value.get("duration", 0)),
                               provider=str(value.get("provider", "peer")), model=str(value.get("model", model)), segments=segments, record_id=value.get("record_id"))
