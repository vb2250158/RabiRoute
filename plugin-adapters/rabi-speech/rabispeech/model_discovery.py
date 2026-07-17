from __future__ import annotations

from copy import deepcopy
from typing import Any


PRIVATE_CAPABILITY_KEYS = {
    "base_url",
    "config",
    "config_path",
    "model_root",
    "output_root",
    "path",
    "worker_url",
}


def public_capabilities(capabilities: dict[str, object]) -> dict[str, object]:
    return _redact(deepcopy(capabilities))


def model_rows(capabilities: dict[str, object]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    defaults = dict(capabilities.get("defaults") or {})
    for kind in ("tts", "asr"):
        providers = dict(capabilities.get(kind) or {})
        for provider_id, raw_detail in sorted(providers.items()):
            detail = dict(raw_detail or {})
            configured_models = detail.get("models")
            models = configured_models if isinstance(configured_models, list) else []
            if not models:
                fallback_model = str(detail.get("model") or f"{kind}-local")
                models = [{"id": fallback_model, "name": fallback_model}]
            for raw_model in models:
                model = dict(raw_model or {})
                model_id = str(model.get("id") or detail.get("model") or f"{kind}-local").strip()
                if not model_id:
                    continue
                installed = bool(model.get("installed", detail.get("installed", True)))
                enabled = bool(model.get("enabled", detail.get("enabled", True)))
                loaded = bool(model.get("loaded", detail.get("loaded", False)))
                row = {
                    "id": f"{provider_id}/{model_id}",
                    "object": "model",
                    "owned_by": "local",
                    "capability": kind,
                    "provider": provider_id,
                    "model": model_id,
                    "name": str(model.get("name") or model_id),
                    "family": str(model.get("family") or provider_id),
                    "installed": installed,
                    "enabled": enabled,
                    "loaded": loaded,
                    "available": installed and enabled,
                    "default": provider_id == str(defaults.get(kind) or ""),
                    "languages": list(model.get("languages") or detail.get("languages") or []),
                    "features": list(model.get("features") or detail.get("features") or []),
                    "request": request_contract(kind, provider_id, model_id, model),
                }
                optional_status = str(model.get("status") or "").strip()
                if optional_status:
                    row["status"] = optional_status
                optional_note = str(model.get("note") or "").strip()
                if optional_note:
                    row["note"] = optional_note
                rows.append(row)
    return rows


def request_contract(
    kind: str,
    provider_id: str,
    model_id: str,
    model: dict[str, Any] | None = None,
) -> dict[str, object]:
    overrides = dict((model or {}).get("parameters") or {})
    selected = f"{provider_id}/{model_id}"
    if kind == "tts":
        properties: dict[str, object] = {
            "model": {"type": "string", "const": selected, "description": "Model id returned by /v1/models."},
            "input": {"type": "string", "minLength": 1, "maxLength": 10000},
            "voice": {"type": "string", "default": "default", "description": "Character id, fixed voice, or speaker:<id> when supported."},
            "response_format": {"type": "string", "enum": ["wav", "mp3", "flac", "opus", "aac", "pcm"], "default": "wav"},
            "speed": {"type": "number", "minimum": 0.25, "maximum": 4.0, "default": 1.0},
            "language": {"type": ["string", "null"], "default": None},
            "instructions": {"type": ["string", "null"], "maxLength": 2000, "default": None},
            "sample_rate": {"type": ["integer", "null"], "minimum": 8000, "maximum": 48000, "default": None},
            "play": {"type": "boolean", "default": False, "description": "Enqueue the completed WAV in the one host-wide FIFO playback queue."},
            "session_id": {"type": ["string", "null"], "default": None},
            "route_id": {"type": ["string", "null"], "default": None},
        }
        properties.update(overrides)
        return {
            "method": "POST",
            "endpoint": "/v1/audio/speech",
            "content_type": "application/json",
            "required": ["model", "input"],
            "properties": properties,
            "example": {"model": selected, "input": "你好，这是本机语音服务。", "voice": "default", "response_format": "wav"},
            "dashscope_endpoint": "/api/v1/services/audio/tts/SpeechSynthesizer",
        }

    properties = {
        "file": {"type": "binary", "description": "Audio file in multipart/form-data."},
        "model": {"type": "string", "const": selected, "description": "Model id returned by /v1/models."},
        "language": {"type": ["string", "null"], "default": None},
        "prompt": {"type": ["string", "null"], "default": None},
        "response_format": {"type": "string", "enum": ["json", "text", "verbose_json", "srt", "vtt"], "default": "json"},
        "timestamp_granularities": {"type": "array", "items": {"type": "string", "enum": ["segment", "word"]}, "default": ["segment"]},
    }
    properties.update(overrides)
    return {
        "method": "POST",
        "endpoint": "/v1/audio/transcriptions",
        "content_type": "multipart/form-data",
        "required": ["file", "model"],
        "properties": properties,
        "example": {"file": "@sample.wav", "model": selected, "language": "zh", "response_format": "verbose_json"},
        "dashscope_endpoint": "/api/v1/services/audio/asr/transcription",
    }


def api_index() -> dict[str, object]:
    return {
        "models": {"method": "GET", "endpoint": "/v1/models"},
        "model_detail": {"method": "GET", "endpoint": "/v1/models/{provider}/{model}"},
        "capabilities": {"method": "GET", "endpoint": "/v1/capabilities"},
        "openapi": {"method": "GET", "endpoint": "/openapi.json"},
        "tts": {"method": "POST", "endpoint": "/v1/audio/speech", "content_type": "application/json"},
        "asr": {"method": "POST", "endpoint": "/v1/audio/transcriptions", "content_type": "multipart/form-data"},
        "playback_status": {"method": "GET", "endpoint": "/v1/playback/status"},
        "playback_stop": {"method": "POST", "endpoint": "/v1/playback/stop"},
        "microphone_status": {"method": "GET", "endpoint": "/v1/microphone/status", "scope": "loopback-only"},
        "microphone_devices": {"method": "GET", "endpoint": "/v1/microphone/devices", "scope": "loopback-only"},
        "microphone_start": {"method": "POST", "endpoint": "/v1/microphone/start", "scope": "loopback-only"},
        "microphone_stop": {"method": "POST", "endpoint": "/v1/microphone/stop", "scope": "loopback-only"},
    }


def _redact(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: _redact(item)
            for key, item in value.items()
            if key.lower() not in PRIVATE_CAPABILITY_KEYS
            and not key.lower().endswith("_path")
            and not key.lower().endswith("_root")
            and not key.lower().endswith("_url")
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value
