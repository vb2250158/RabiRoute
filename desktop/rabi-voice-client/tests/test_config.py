from __future__ import annotations

import json

import pytest

from rabi_voice_client.config import load_config, load_config_data, save_config_data, validate_config_data


def test_load_config_reads_token_only_from_named_environment(tmp_path, monkeypatch):
    config = tmp_path / "config.json"
    config.write_text(json.dumps({
        "server_url": "ws://127.0.0.1:8782",
        "token_env": "TEST_AUDIO_TOKEN",
        "client_id": "meeting-room-a",
        "name": "Meeting Room A",
    }), encoding="utf-8")
    monkeypatch.setenv("TEST_AUDIO_TOKEN", "secret-token")

    loaded = load_config(config)

    assert loaded.token == "secret-token"
    assert loaded.client_id == "meeting-room-a"
    assert loaded.sample_rate == 16_000


def test_load_config_accepts_lan_auto_discovery(tmp_path, monkeypatch):
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"server_url": "auto"}), encoding="utf-8")
    monkeypatch.setenv("RABISPEECH_AUDIO_STREAM_TOKEN", "secret-token")

    assert load_config(config).server_url == "auto"


def test_missing_config_returns_gui_ready_defaults(tmp_path):
    loaded = load_config_data(tmp_path / "config.json")

    assert loaded["server_url"] == "auto"
    assert loaded["sample_rate"] == 16_000
    assert loaded["client_id"]


def test_gui_can_save_incomplete_config_before_token_is_available(tmp_path):
    path = tmp_path / "config.json"
    data = load_config_data(path)
    validate_config_data(data, require_token=False)

    save_config_data(path, data)

    assert path.read_text(encoding="utf-8").endswith("\n")
