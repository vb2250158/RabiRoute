from __future__ import annotations

import json
import os
import re
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_TOKEN_ENV = "RABISPEECH_AUDIO_STREAM_TOKEN"


@dataclass(frozen=True)
class ClientConfig:
    server_url: str
    token: str
    client_id: str
    name: str
    input_device: int | str | None
    output_device: int | str | None
    sample_rate: int = 16_000
    chunk_ms: int = 100
    reconnect_seconds: float = 3.0


def default_client_id() -> str:
    hostname = socket.gethostname().strip().lower()
    normalized = re.sub(r"[^a-z0-9._-]+", "-", hostname).strip("-._")
    return (normalized or "rabi-voice-client")[:100]


def default_config_data() -> dict[str, Any]:
    client_id = default_client_id()
    return {
        "server_url": "auto",
        "token_env": DEFAULT_TOKEN_ENV,
        "token": "",
        "client_id": client_id,
        "name": socket.gethostname().strip() or client_id,
        "input_device": None,
        "output_device": None,
        "sample_rate": 16_000,
        "chunk_ms": 100,
        "reconnect_seconds": 3,
    }


def load_config_data(path: str | Path) -> dict[str, Any]:
    target = Path(path).expanduser().resolve()
    defaults = default_config_data()
    if not target.exists():
        return defaults
    data = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Client config must be a JSON object.")
    defaults.update(data)
    return defaults


def save_config_data(path: str | Path, data: dict[str, Any]) -> None:
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_config(path: str | Path) -> ClientConfig:
    return validate_config_data(load_config_data(path))


def validate_config_data(data: dict[str, Any], *, require_token: bool = True) -> ClientConfig:
    token_env = str(data.get("token_env") or DEFAULT_TOKEN_ENV).strip()
    token = os.environ.get(token_env, "").strip() or str(data.get("token") or "").strip()
    server_url = str(data.get("server_url") or "").strip().rstrip("/")
    if server_url.lower() != "auto" and not server_url.startswith(("ws://", "wss://")):
        raise ValueError("server_url must be auto, ws://, or wss://.")
    if require_token and not token:
        raise ValueError(f"Missing audio stream token in environment variable {token_env}.")
    client_id = _safe_id(data.get("client_id") or default_client_id())
    name = str(data.get("name") or socket.gethostname() or client_id).strip()[:100] or client_id
    sample_rate = int(data.get("sample_rate") or 16_000)
    chunk_ms = int(data.get("chunk_ms") or 100)
    if sample_rate != 16_000:
        raise ValueError("Rabi voice clients currently stream at 16000 Hz.")
    if not 20 <= chunk_ms <= 1_000:
        raise ValueError("chunk_ms must be between 20 and 1000.")
    return ClientConfig(
        server_url=server_url,
        token=token or "not-configured",
        client_id=client_id,
        name=name,
        input_device=_device(data.get("input_device")),
        output_device=_device(data.get("output_device")),
        sample_rate=sample_rate,
        chunk_ms=chunk_ms,
        reconnect_seconds=max(1.0, min(60.0, float(data.get("reconnect_seconds") or 3.0))),
    )


def _safe_id(value: object) -> str:
    text = str(value or "").strip()
    if not text or len(text) > 100 or re.search(r"[^A-Za-z0-9._-]", text):
        raise ValueError("client_id may contain only letters, numbers, dot, underscore, and dash.")
    return text


def _device(value: object) -> int | str | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    text = str(value).strip()
    return int(text) if text.isdigit() else text or None
