from __future__ import annotations

import asyncio
import json
import sys
import wave
from pathlib import Path

import httpx
import pytest

from rabispeech.config import HttpAsrModelSettings, HttpAsrProviderSettings
from rabispeech.contracts import TranscriptionRequest
from rabispeech.providers.http_asr import LocalHttpAsrProvider
from rabispeech.worker_supervisor import WorkerLaunch, WorkerSupervisor


def transcribe_response(tmp_path: Path, monkeypatch, response: dict):
    audio = tmp_path / "sample.wav"
    with wave.open(str(audio), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * 16000)
    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=response, request=request))
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original_client(transport=transport, **kwargs))

    async def ensure(*_args):
        return "http://127.0.0.1:9999"

    worker_supervisor = WorkerSupervisor()
    monkeypatch.setattr(worker_supervisor, "ensure", ensure)
    model = HttpAsrModelSettings("fixture", "Fixture", "Fixture", "http://127.0.0.1:9999", "", True, (), (), WorkerLaunch())
    provider = LocalHttpAsrProvider(HttpAsrProviderSettings("fixture", True, "fixture", 10, (model,)), worker_supervisor)
    return asyncio.run(provider.transcribe(TranscriptionRequest(audio, "fixture", word_timestamps=True)))


def test_http_asr_keeps_observations_separate_from_text(tmp_path, monkeypatch):
    result = transcribe_response(tmp_path, monkeypatch, {
        "text": "你好", "duration": 1, "emotion": "NEUTRAL", "emotion_labels": ["NEUTRAL"],
        "audio_events": ["Speech"], "raw_tags": ["<|zh|>", "<|NEUTRAL|>", "<|zh|>"], "confidence": 0.97,
    })
    assert result.text == "你好"
    assert result.recognition_metadata() == {
        "emotion": "NEUTRAL", "emotion_labels": ["NEUTRAL"], "audio_events": ["Speech"],
        "raw_tags": ["<|zh|>", "<|NEUTRAL|>", "<|zh|>"], "confidence": 0.97,
    }


def test_http_asr_maps_word_timestamps_without_inventing_word_probabilities(tmp_path, monkeypatch):
    result = transcribe_response(tmp_path, monkeypatch, {
        "text": "你好", "duration": 1, "confidence": 0.97,
        "word_timestamps": [{"text": "你", "start": 0.1, "end": 0.4}, {"text": "好", "start": 0.4, "end": 0.8}],
    })
    assert result.segments[0].text == "你好"
    assert result.segments[0].words == [{"word": "你", "start": 0.1, "end": 0.4}, {"word": "好", "start": 0.4, "end": 0.8}]
    assert result.confidence == 0.97
    assert "probability" not in result.segments[0].words[0]


@pytest.mark.parametrize("confidence", [-1, 2, "0.9", True])
def test_http_asr_unknown_and_invalid_observations_are_optional(tmp_path, monkeypatch, confidence):
    result = transcribe_response(tmp_path, monkeypatch, {"text": "你好", "confidence": confidence})
    assert result.recognition_metadata() == {}


def fire_red_fixture(tmp_path, monkeypatch, arguments=()):
    service = tmp_path / "service"
    script = service / "scripts" / "local_asr_worker.py"
    script.parent.mkdir(parents=True)
    script.write_text("# fixture, not executed", encoding="utf-8")
    model_root = tmp_path / "models"
    monkeypatch.setattr("rabispeech.providers.http_asr.SERVICE_ROOT", service)
    command = (sys.executable, str(script), "--engine", "fireredasr2-aed", *arguments)
    launch = WorkerLaunch(command=command, working_directory=tmp_path)
    model = HttpAsrModelSettings("fireredasr2-aed", "FireRed", "FireRedASR2", "http://127.0.0.1:9999",
                                 "", False, (), (), launch)
    provider = LocalHttpAsrProvider(HttpAsrProviderSettings(
        "fireredasr2", True, model.id, 10, (model,), managed_model_root=model_root,
    ))
    return provider, model_root, command


def write_firered_fixture_weights(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for filename in ("model.pth.tar", "cmvn.ark", "dict.txt", "train_bpe1000.model"):
        (directory / filename).write_bytes(b"fixture")


def test_running_firered_provider_discovers_managed_install_and_uses_same_verified_launch(tmp_path, monkeypatch):
    provider, model_root, command = fire_red_fixture(tmp_path, monkeypatch)
    def status():
        return provider.capabilities()["models"][0]["installed"]
    weights = model_root / "asr" / "fireredasr2-aed"
    write_firered_fixture_weights(weights)
    manifest = model_root / "install-manifest.json"
    row = {"alias": "asr-fireredasr2-aed", "repository": "FireRedTeam/FireRedASR2-AED",
           "status": "installed", "command": ["ignored"]}
    outside = tmp_path / "outside"
    write_firered_fixture_weights(outside)
    assert status() is False
    manifest.write_text(json.dumps({"schema_version": 1, "models": [{**row, "target": str(outside)}]}), encoding="utf-8")
    assert status() is False
    manifest.write_text(json.dumps({"schema_version": 1, "models": [{**row, "target": str(weights)}]}), encoding="utf-8")
    assert status() is True

    calls = []
    async def ensure(_key, _url, launch):
        calls.append(launch)
        return "http://127.0.0.1:9999"

    base = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"text": "通过", "duration": 1}, request=request))
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: base(transport=transport, **kwargs))
    monkeypatch.setattr(provider.worker_supervisor, "ensure", ensure)
    audio = tmp_path / "input.wav"
    audio.write_bytes(b"fixture")
    result = asyncio.run(provider.transcribe(TranscriptionRequest(audio, "fireredasr2-aed")))
    assert result.text == "通过"
    assert [launch.command for launch in calls] == [(*command, "--model", str(weights))]
    assert provider.settings.models[0].launch.command == command
    (weights / "model.pth.tar").unlink()
    assert status() is False
    with pytest.raises(ValueError, match="not installed"):
        asyncio.run(provider.transcribe(TranscriptionRequest(audio, "fireredasr2-aed")))
    assert len(calls) == 1


def test_firered_recognizes_existing_configured_path_without_replacing_it(tmp_path, monkeypatch):
    source = tmp_path / "FireRedASR2S" / "fireredasr2s" / "fireredasr2"
    source.mkdir(parents=True)
    (source / "__init__.py").write_text("# package fixture", encoding="utf-8")
    provider, model_root, command = fire_red_fixture(
        tmp_path, monkeypatch, ("--model", "existing", "--repository-root", "FireRedASR2S"),
    )
    configured = tmp_path / "existing"
    alternate = model_root / "asr" / "fireredasr2-aed"
    write_firered_fixture_weights(alternate)
    (model_root / "install-manifest.json").write_text(json.dumps({"schema_version": 1, "models": [{
        "alias": "asr-fireredasr2-aed", "repository": "FireRedTeam/FireRedASR2-AED",
        "status": "installed", "target": str(alternate),
    }]}), encoding="utf-8")
    assert provider.capabilities()["models"][0]["installed"] is False
    write_firered_fixture_weights(configured)
    assert provider.capabilities()["models"][0]["installed"] is True
    assert provider._launch_for_model(provider.settings.models[0]).command == command
    # A same-name script is insufficient when it does not belong to this package.
    monkeypatch.setattr("rabispeech.providers.http_asr.SERVICE_ROOT", tmp_path / "other")
    assert provider.capabilities()["models"][0]["installed"] is False
