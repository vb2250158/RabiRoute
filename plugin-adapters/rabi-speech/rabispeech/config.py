from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SERVICE_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class ServerSettings:
    host: str
    port: int
    max_upload_bytes: int
    temp_dir: Path
    ffmpeg: str


@dataclass(frozen=True)
class OumuqSettings:
    enabled: bool
    base_url: str
    default_worker_url: str
    default_voice: str
    timeout_seconds: float
    allowed_output_roots: tuple[Path, ...]


@dataclass(frozen=True)
class FasterWhisperSettings:
    enabled: bool
    preload: bool
    model: str
    model_root: Path
    device: str
    compute_type: str
    cpu_compute_type: str
    local_files_only: bool
    beam_size: int
    vad_filter: bool


@dataclass(frozen=True)
class Settings:
    server: ServerSettings
    default_tts_provider: str
    default_asr_provider: str
    oumuq: OumuqSettings
    faster_whisper: FasterWhisperSettings
    provider_extensions: tuple[str, ...]
    config_path: Path


def _mapping(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _resolve_path(base: Path, value: object, fallback: str) -> Path:
    raw = str(value or fallback).strip() or fallback
    path = Path(raw).expanduser()
    return (base / path).resolve() if not path.is_absolute() else path.resolve()


def _env(name: str, fallback: object) -> str:
    return os.environ.get(name, str(fallback))


def _bool(value: object, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if not text:
        return fallback
    return text in {"1", "true", "yes", "on", "enable", "enabled"}


def load_settings(path: str | Path | None = None) -> Settings:
    configured = Path(path or os.environ.get("RABISPEECH_CONFIG") or SERVICE_ROOT / "config.json")
    if not configured.exists():
        configured = SERVICE_ROOT / "config.example.json"
    configured = configured.resolve()
    data = json.loads(configured.read_text(encoding="utf-8"))
    base = configured.parent
    server = _mapping(data.get("server"))
    providers = _mapping(data.get("providers"))
    tts = _mapping(providers.get("tts"))
    asr = _mapping(providers.get("asr"))
    oumuq = _mapping(tts.get("oumuq"))
    whisper = _mapping(asr.get("faster_whisper"))
    extensions = providers.get("extensions") or []
    if not isinstance(extensions, list):
        extensions = [extensions]
    roots = oumuq.get("allowed_output_roots") or ["../../../OumuQ"]
    if not isinstance(roots, list):
        roots = [roots]

    return Settings(
        server=ServerSettings(
            host=_env("RABISPEECH_HOST", server.get("host", "127.0.0.1")).strip(),
            port=int(_env("RABISPEECH_PORT", server.get("port", 8781))),
            max_upload_bytes=int(_env("RABISPEECH_MAX_UPLOAD_BYTES", server.get("max_upload_bytes", 25 * 1024 * 1024))),
            temp_dir=_resolve_path(base, os.environ.get("RABISPEECH_TEMP_DIR", server.get("temp_dir")), "temp"),
            ffmpeg=_env("RABISPEECH_FFMPEG", server.get("ffmpeg", "")).strip(),
        ),
        default_tts_provider=str(tts.get("default", "oumuq")).strip().lower(),
        default_asr_provider=str(asr.get("default", "faster-whisper")).strip().lower(),
        oumuq=OumuqSettings(
            enabled=_bool(oumuq.get("enabled"), True),
            base_url=_env("RABISPEECH_OUMUQ_URL", oumuq.get("base_url", "http://127.0.0.1:8780")).strip().rstrip("/"),
            default_worker_url=_env("RABISPEECH_OUMUQ_WORKER_URL", oumuq.get("default_worker_url", "")).strip().rstrip("/"),
            default_voice=_env("RABISPEECH_DEFAULT_VOICE", oumuq.get("default_voice", "default")).strip() or "default",
            timeout_seconds=float(_env("RABISPEECH_TTS_TIMEOUT_SECONDS", oumuq.get("timeout_seconds", 180))),
            allowed_output_roots=tuple(_resolve_path(base, item, ".") for item in roots),
        ),
        faster_whisper=FasterWhisperSettings(
            enabled=_bool(whisper.get("enabled"), True),
            preload=_bool(whisper.get("preload"), True),
            model=_env("RABISPEECH_WHISPER_MODEL", whisper.get("model", "small")).strip(),
            model_root=_resolve_path(
                base,
                os.environ.get("RABISPEECH_WHISPER_MODEL_ROOT", whisper.get("model_root")),
                "../../../FenneNote/cache/models",
            ),
            device=_env("RABISPEECH_WHISPER_DEVICE", whisper.get("device", "auto")).strip().lower(),
            compute_type=_env("RABISPEECH_WHISPER_COMPUTE_TYPE", whisper.get("compute_type", "int8_float16")).strip(),
            cpu_compute_type=_env("RABISPEECH_WHISPER_CPU_COMPUTE_TYPE", whisper.get("cpu_compute_type", "int8")).strip(),
            local_files_only=_bool(whisper.get("local_files_only"), True),
            beam_size=int(whisper.get("beam_size", 5)),
            vad_filter=_bool(whisper.get("vad_filter"), True),
        ),
        provider_extensions=tuple(str(item).strip() for item in extensions if str(item).strip()),
        config_path=configured,
    )
