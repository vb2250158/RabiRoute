from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .worker_supervisor import WorkerLaunch


SERVICE_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class ServerSettings:
    host: str
    port: int
    max_upload_bytes: int
    temp_dir: Path
    ffmpeg: str
    playback_dir: Path


@dataclass(frozen=True)
class LocalTtsSettings:
    enabled: bool
    default_worker_url: str
    default_voice: str
    timeout_seconds: float
    allowed_output_roots: tuple[Path, ...]
    model: str
    models: tuple["LocalTtsModelSettings", ...]


@dataclass(frozen=True)
class LocalTtsModelSettings:
    id: str
    name: str
    family: str
    worker_url: str
    installed: bool
    languages: tuple[str, ...]
    features: tuple[str, ...]
    launch: WorkerLaunch


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
    models: tuple["FasterWhisperModelSettings", ...]


@dataclass(frozen=True)
class FasterWhisperModelSettings:
    id: str
    name: str
    source: str
    path: Path | None


@dataclass(frozen=True)
class HttpAsrModelSettings:
    id: str
    name: str
    family: str
    base_url: str
    source: str
    installed: bool
    languages: tuple[str, ...]
    features: tuple[str, ...]
    launch: WorkerLaunch


@dataclass(frozen=True)
class HttpAsrProviderSettings:
    id: str
    enabled: bool
    default_model: str
    timeout_seconds: float
    models: tuple[HttpAsrModelSettings, ...]


@dataclass(frozen=True)
class Settings:
    server: ServerSettings
    default_tts_provider: str
    default_asr_provider: str
    local_tts: LocalTtsSettings
    faster_whisper: FasterWhisperSettings
    http_asr: tuple[HttpAsrProviderSettings, ...]
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
    local_tts = _mapping(tts.get("local_tts"))
    whisper = _mapping(asr.get("faster_whisper"))
    extensions = providers.get("extensions") or []
    if not isinstance(extensions, list):
        extensions = [extensions]
    roots = local_tts.get("allowed_output_roots") or ["./output"]
    if not isinstance(roots, list):
        roots = [roots]
    whisper_model_root = _resolve_path(
        base,
        os.environ.get("RABISPEECH_WHISPER_MODEL_ROOT", whisper.get("model_root")),
        "../../../models/rabispeech/asr/faster-whisper-cache",
    )
    whisper_model_id = _env("RABISPEECH_WHISPER_MODEL", whisper.get("model", "small")).strip()
    whisper_models = _whisper_models(base, whisper.get("models"), whisper_model_id)
    local_tts_model_id = _env("RABISPEECH_TTS_MODEL", local_tts.get("model", "onnx-vits")).strip()
    local_tts_models = _local_tts_models(base, local_tts.get("models"), local_tts_model_id, str(local_tts.get("default_worker_url") or ""))
    http_asr = _http_asr_providers(base, asr.get("http_providers"))

    return Settings(
        server=ServerSettings(
            host=_env("RABISPEECH_HOST", server.get("host", "127.0.0.1")).strip(),
            port=int(_env("RABISPEECH_PORT", server.get("port", 8781))),
            max_upload_bytes=int(_env("RABISPEECH_MAX_UPLOAD_BYTES", server.get("max_upload_bytes", 25 * 1024 * 1024))),
            temp_dir=_resolve_path(base, os.environ.get("RABISPEECH_TEMP_DIR", server.get("temp_dir")), "temp"),
            ffmpeg=_env("RABISPEECH_FFMPEG", server.get("ffmpeg", "")).strip(),
            playback_dir=_resolve_path(base, os.environ.get("RABISPEECH_PLAYBACK_DIR", server.get("playback_dir")), "output/playback-queue"),
        ),
        default_tts_provider=str(tts.get("default", "local-tts")).strip().lower(),
        default_asr_provider=str(asr.get("default", "faster-whisper")).strip().lower(),
        local_tts=LocalTtsSettings(
            enabled=_bool(local_tts.get("enabled"), True),
            default_worker_url=_env("RABISPEECH_TTS_WORKER_URL", local_tts.get("default_worker_url", "")).strip().rstrip("/"),
            default_voice=_env("RABISPEECH_DEFAULT_VOICE", local_tts.get("default_voice", "default")).strip() or "default",
            timeout_seconds=float(_env("RABISPEECH_TTS_TIMEOUT_SECONDS", local_tts.get("timeout_seconds", 180))),
            allowed_output_roots=tuple(_resolve_path(base, item, ".") for item in roots),
            model=local_tts_model_id,
            models=local_tts_models,
        ),
        faster_whisper=FasterWhisperSettings(
            enabled=_bool(whisper.get("enabled"), True),
            preload=_bool(whisper.get("preload"), True),
            model=whisper_model_id,
            model_root=whisper_model_root,
            device=_env("RABISPEECH_WHISPER_DEVICE", whisper.get("device", "auto")).strip().lower(),
            compute_type=_env("RABISPEECH_WHISPER_COMPUTE_TYPE", whisper.get("compute_type", "int8_float16")).strip(),
            cpu_compute_type=_env("RABISPEECH_WHISPER_CPU_COMPUTE_TYPE", whisper.get("cpu_compute_type", "int8")).strip(),
            local_files_only=_bool(whisper.get("local_files_only"), True),
            beam_size=int(whisper.get("beam_size", 5)),
            vad_filter=_bool(whisper.get("vad_filter"), True),
            models=whisper_models,
        ),
        http_asr=http_asr,
        provider_extensions=tuple(str(item).strip() for item in extensions if str(item).strip()),
        config_path=configured,
    )


def _whisper_models(base: Path, value: object, default_model: str) -> tuple[FasterWhisperModelSettings, ...]:
    rows = value if isinstance(value, list) else []
    models: list[FasterWhisperModelSettings] = []
    for row in rows:
        if isinstance(row, str):
            model_id = row.strip()
            detail: dict[str, Any] = {}
        elif isinstance(row, dict):
            detail = row
            model_id = str(detail.get("id") or "").strip()
        else:
            continue
        if not model_id or any(item.id.lower() == model_id.lower() for item in models):
            continue
        raw_path = str(detail.get("path") or "").strip()
        models.append(
            FasterWhisperModelSettings(
                id=model_id,
                name=str(detail.get("name") or f"faster-whisper {model_id}"),
                source=str(detail.get("source") or f"Systran/faster-whisper-{model_id}"),
                path=_resolve_path(base, raw_path, ".") if raw_path else None,
            )
        )
    if not any(item.id.lower() == default_model.lower() for item in models):
        models.insert(
            0,
            FasterWhisperModelSettings(
                id=default_model,
                name=f"faster-whisper {default_model}",
                source=f"Systran/faster-whisper-{default_model}",
                path=None,
            ),
        )
    return tuple(models)


def _local_tts_models(base: Path, value: object, default_model: str, default_worker_url: str) -> tuple[LocalTtsModelSettings, ...]:
    rows = value if isinstance(value, list) else []
    models: list[LocalTtsModelSettings] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        model_id = str(row.get("id") or "").strip()
        if not model_id or any(item.id.lower() == model_id.lower() for item in models):
            continue
        languages = row.get("languages") if isinstance(row.get("languages"), list) else []
        features = row.get("features") if isinstance(row.get("features"), list) else []
        models.append(
            LocalTtsModelSettings(
                id=model_id,
                name=str(row.get("name") or model_id),
                family=str(row.get("family") or model_id),
                worker_url=str(row.get("worker_url") or "").strip().rstrip("/"),
                installed=_bool(row.get("installed"), False),
                languages=tuple(str(item) for item in languages),
                features=tuple(str(item) for item in features),
                launch=_worker_launch(base, row),
            )
        )
    if not any(item.id.lower() == default_model.lower() for item in models):
        models.insert(
            0,
            LocalTtsModelSettings(
                id=default_model,
                name=default_model,
                family=default_model,
                worker_url=default_worker_url.strip().rstrip("/"),
                installed=True,
                languages=("zh",),
                features=("speech_synthesis",),
                launch=WorkerLaunch(),
            ),
        )
    return tuple(models)


def _http_asr_providers(base: Path, value: object) -> tuple[HttpAsrProviderSettings, ...]:
    rows = value if isinstance(value, list) else []
    providers: list[HttpAsrProviderSettings] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        provider_id = str(row.get("id") or "").strip().lower()
        raw_models = row.get("models") if isinstance(row.get("models"), list) else []
        models: list[HttpAsrModelSettings] = []
        for raw_model in raw_models:
            if not isinstance(raw_model, dict):
                continue
            model_id = str(raw_model.get("id") or "").strip()
            base_url = str(raw_model.get("base_url") or "").strip().rstrip("/")
            if not model_id or not base_url:
                continue
            languages = raw_model.get("languages") if isinstance(raw_model.get("languages"), list) else []
            features = raw_model.get("features") if isinstance(raw_model.get("features"), list) else []
            models.append(
                HttpAsrModelSettings(
                    id=model_id,
                    name=str(raw_model.get("name") or model_id),
                    family=str(raw_model.get("family") or provider_id),
                    base_url=base_url,
                    source=str(raw_model.get("source") or ""),
                    installed=_bool(raw_model.get("installed"), False),
                    languages=tuple(str(item) for item in languages),
                    features=tuple(str(item) for item in features),
                    launch=_worker_launch(base, raw_model),
                )
            )
        default_model = str(row.get("default_model") or (models[0].id if models else "")).strip()
        if provider_id and models and any(item.id == default_model for item in models):
            providers.append(
                HttpAsrProviderSettings(
                    id=provider_id,
                    enabled=_bool(row.get("enabled"), True),
                    default_model=default_model,
                    timeout_seconds=float(row.get("timeout_seconds", 180)),
                    models=tuple(models),
                )
            )
    return tuple(providers)


def _worker_launch(base: Path, row: dict[str, Any]) -> WorkerLaunch:
    raw_command = row.get("command") if isinstance(row.get("command"), list) else []
    command = tuple(str(item) for item in raw_command if str(item).strip())
    raw_workdir = str(row.get("working_directory") or "").strip()
    raw_environment = row.get("environment") if isinstance(row.get("environment"), dict) else {}
    return WorkerLaunch(
        command=command,
        working_directory=_resolve_path(base, raw_workdir, ".") if raw_workdir else None,
        exclusive_group=str(row.get("exclusive_group") or "").strip(),
        startup_timeout_seconds=float(row.get("startup_timeout_seconds", 240)),
        environment=tuple(
            (str(key), str(value))
            for key, value in raw_environment.items()
            if str(key).strip() and value is not None
        ),
    )
