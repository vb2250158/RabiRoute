from __future__ import annotations

import json
import os
import secrets
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
    records_dir: Path
    tts_audio_dir: Path
    tts_audio_retention_minutes: float


@dataclass(frozen=True)
class RemoteAudioSettings:
    enabled: bool
    host: str
    port: int
    token: str
    settings_path: Path
    token_path: Path
    discovery_port: int


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
class SpeakerRecognitionSettings:
    enabled: bool
    validated: bool
    validation_report_path: Path | None
    experimental_auto_assign: bool
    auto_assign: bool
    model_id: str
    model_path: Path
    provider: str
    num_threads: int
    min_embedding_seconds: float
    hard_accept_seconds: float
    hard_threshold: float
    tentative_threshold: float
    cluster_threshold: float
    min_margin: float
    max_samples_per_profile: int
    max_unconfirmed_samples: int
    min_voiced_rms: float


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
class ApiModelSettings:
    id: str
    name: str
    languages: tuple[str, ...]
    features: tuple[str, ...]


@dataclass(frozen=True)
class ApiProviderSettings:
    id: str
    enabled: bool
    protocol: str
    base_url: str
    api_key_env: str
    default_model: str
    default_voice: str
    timeout_seconds: float
    models: tuple[ApiModelSettings, ...]


@dataclass(frozen=True)
class Settings:
    server: ServerSettings
    remote_audio: RemoteAudioSettings
    default_tts_provider: str
    default_asr_provider: str
    local_tts: LocalTtsSettings
    faster_whisper: FasterWhisperSettings
    speaker_recognition: SpeakerRecognitionSettings
    http_asr: tuple[HttpAsrProviderSettings, ...]
    api_tts: tuple[ApiProviderSettings, ...]
    api_asr: tuple[ApiProviderSettings, ...]
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


def _remote_audio_token(base: Path, value: dict[str, Any], *, enabled: bool) -> str:
    token_env = str(value.get("token_env") or "RABISPEECH_AUDIO_STREAM_TOKEN").strip()
    configured = os.environ.get(token_env, "").strip()
    if configured or not enabled:
        return configured
    token_path = _resolve_path(base, value.get("token_path"), "output/audio-stream-token.txt")
    try:
        existing = token_path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except OSError:
        pass
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    temporary = token_path.with_suffix(token_path.suffix + ".tmp")
    temporary.write_text(token + "\n", encoding="utf-8")
    temporary.replace(token_path)
    return token


def load_settings(path: str | Path | None = None) -> Settings:
    configured = Path(path or os.environ.get("RABISPEECH_CONFIG") or SERVICE_ROOT / "config.json")
    if not configured.exists():
        configured = SERVICE_ROOT / "config.example.json"
    configured = configured.resolve()
    data = json.loads(configured.read_text(encoding="utf-8"))
    base = configured.parent
    server = _mapping(data.get("server"))
    remote_audio = _mapping(data.get("remote_audio"))
    providers = _mapping(data.get("providers"))
    tts = _mapping(providers.get("tts"))
    asr = _mapping(providers.get("asr"))
    local_tts = _mapping(tts.get("local_tts"))
    whisper = _mapping(asr.get("faster_whisper"))
    speaker_recognition = _mapping(data.get("speaker_recognition"))
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
    api_tts = _api_providers(tts.get("api_providers"), "tts")
    api_asr = _api_providers(asr.get("api_providers"), "asr")

    return Settings(
        server=ServerSettings(
            host=_env("RABISPEECH_HOST", server.get("host", "127.0.0.1")).strip(),
            port=int(_env("RABISPEECH_PORT", server.get("port", 8781))),
            max_upload_bytes=int(_env("RABISPEECH_MAX_UPLOAD_BYTES", server.get("max_upload_bytes", 25 * 1024 * 1024))),
            temp_dir=_resolve_path(base, os.environ.get("RABISPEECH_TEMP_DIR", server.get("temp_dir")), "temp"),
            ffmpeg=_env("RABISPEECH_FFMPEG", server.get("ffmpeg", "")).strip(),
            playback_dir=_resolve_path(base, os.environ.get("RABISPEECH_PLAYBACK_DIR", server.get("playback_dir")), "output/playback-queue"),
            records_dir=_resolve_path(base, os.environ.get("RABISPEECH_RECORDS_DIR", server.get("records_dir")), "output/records"),
            tts_audio_dir=_resolve_path(base, os.environ.get("RABISPEECH_TTS_AUDIO_DIR", server.get("tts_audio_dir")), "output/tts-audio"),
            tts_audio_retention_minutes=max(
                1.0,
                min(1440.0, float(_env("RABISPEECH_TTS_AUDIO_RETENTION_MINUTES", server.get("tts_audio_retention_minutes", 1440)))),
            ),
        ),
        remote_audio=RemoteAudioSettings(
            enabled=_bool(os.environ.get("RABISPEECH_REMOTE_AUDIO_ENABLED", remote_audio.get("enabled")), False),
            host=_env("RABISPEECH_REMOTE_AUDIO_HOST", remote_audio.get("host", "0.0.0.0")).strip(),
            port=int(_env("RABISPEECH_REMOTE_AUDIO_PORT", remote_audio.get("port", 8782))),
            token=_remote_audio_token(
                base,
                remote_audio,
                enabled=_bool(os.environ.get("RABISPEECH_REMOTE_AUDIO_ENABLED", remote_audio.get("enabled")), False),
            ),
            settings_path=_resolve_path(
                base,
                os.environ.get("RABISPEECH_REMOTE_AUDIO_SETTINGS", remote_audio.get("settings_path")),
                "output/audio-stream-settings.json",
            ),
            token_path=_resolve_path(base, remote_audio.get("token_path"), "output/audio-stream-token.txt"),
            discovery_port=int(_env("RABISPEECH_REMOTE_AUDIO_DISCOVERY_PORT", remote_audio.get("discovery_port", 8783))),
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
        speaker_recognition=SpeakerRecognitionSettings(
            enabled=_bool(
                os.environ.get("RABISPEECH_SPEAKER_RECOGNITION_ENABLED", speaker_recognition.get("enabled")),
                True,
            ),
            validated=_bool(speaker_recognition.get("validated"), False),
            validation_report_path=(
                _resolve_path(
                    base,
                    os.environ.get(
                        "RABISPEECH_SPEAKER_VALIDATION_REPORT_PATH",
                        speaker_recognition.get("validation_report_path"),
                    ),
                    "output/benchmarks/speaker-validation.json",
                )
                if str(
                    os.environ.get(
                        "RABISPEECH_SPEAKER_VALIDATION_REPORT_PATH",
                        speaker_recognition.get("validation_report_path") or "",
                    )
                ).strip()
                else None
            ),
            experimental_auto_assign=_bool(speaker_recognition.get("experimental_auto_assign"), False),
            auto_assign=_bool(speaker_recognition.get("auto_assign"), True),
            model_id=_env(
                "RABISPEECH_SPEAKER_MODEL_ID",
                speaker_recognition.get("model_id", "3dspeaker-eres2netv2-zh-16k"),
            ).strip(),
            model_path=_resolve_path(
                base,
                os.environ.get("RABISPEECH_SPEAKER_MODEL_PATH", speaker_recognition.get("model_path")),
                "../../../models/rabispeech/speaker/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
            ),
            provider=_env("RABISPEECH_SPEAKER_PROVIDER", speaker_recognition.get("provider", "cpu")).strip().lower(),
            num_threads=max(1, min(8, int(speaker_recognition.get("num_threads", 2)))),
            min_embedding_seconds=max(0.5, float(speaker_recognition.get("min_embedding_seconds", 0.8))),
            hard_accept_seconds=max(1.0, float(speaker_recognition.get("hard_accept_seconds", 1.5))),
            hard_threshold=min(1.0, max(-1.0, float(speaker_recognition.get("hard_threshold", 0.72)))),
            tentative_threshold=min(1.0, max(-1.0, float(speaker_recognition.get("tentative_threshold", 0.64)))),
            cluster_threshold=min(1.0, max(-1.0, float(speaker_recognition.get("cluster_threshold", 0.68)))),
            min_margin=min(1.0, max(0.0, float(speaker_recognition.get("min_margin", 0.06)))),
            max_samples_per_profile=max(1, min(50, int(speaker_recognition.get("max_samples_per_profile", 12)))),
            max_unconfirmed_samples=max(
                10,
                min(5000, int(speaker_recognition.get("max_unconfirmed_samples", 500))),
            ),
            min_voiced_rms=min(1.0, max(0.0, float(speaker_recognition.get("min_voiced_rms", 0.006)))),
        ),
        http_asr=http_asr,
        api_tts=api_tts,
        api_asr=api_asr,
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


def _api_providers(value: object, kind: str) -> tuple[ApiProviderSettings, ...]:
    rows = value if isinstance(value, list) else []
    providers: list[ApiProviderSettings] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        provider_id = str(row.get("id") or "").strip().lower()
        base_url = str(row.get("base_url") or "").strip().rstrip("/")
        raw_models = row.get("models") if isinstance(row.get("models"), list) else []
        models: list[ApiModelSettings] = []
        for raw_model in raw_models:
            if isinstance(raw_model, str):
                model_id = raw_model.strip()
                detail: dict[str, Any] = {}
            elif isinstance(raw_model, dict):
                detail = raw_model
                model_id = str(detail.get("id") or "").strip()
            else:
                continue
            if not model_id or any(item.id.lower() == model_id.lower() for item in models):
                continue
            languages = detail.get("languages") if isinstance(detail.get("languages"), list) else []
            features = detail.get("features") if isinstance(detail.get("features"), list) else []
            models.append(
                ApiModelSettings(
                    id=model_id,
                    name=str(detail.get("name") or model_id),
                    languages=tuple(str(item) for item in languages),
                    features=tuple(str(item) for item in features),
                )
            )
        default_model = str(row.get("default_model") or (models[0].id if models else "")).strip()
        if not provider_id or not base_url or not models or not any(item.id == default_model for item in models):
            continue
        providers.append(
            ApiProviderSettings(
                id=provider_id,
                enabled=_bool(row.get("enabled"), False),
                protocol=str(row.get("protocol") or "openai-compatible").strip().lower(),
                base_url=base_url,
                api_key_env=str(row.get("api_key_env") or "").strip(),
                default_model=default_model,
                default_voice=str(row.get("default_voice") or ("alloy" if kind == "tts" else "")).strip(),
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
