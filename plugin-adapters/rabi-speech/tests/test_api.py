from __future__ import annotations

import base64
import json
import wave
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from rabispeech.app import create_app
from rabispeech.config import load_settings
from rabispeech.contracts import (
    SpeechAudioArtifact,
    SpeechSynthesisRequest,
    TranscriptSegment,
    TranscriptionRequest,
    TranscriptionResult,
)
from rabispeech.registry import ProviderRegistry


class FakeTts:
    provider_id = "fake-tts"

    def __init__(self, output: Path) -> None:
        self.output = output
        self.requests: list[SpeechSynthesisRequest] = []

    async def synthesize(self, request: SpeechSynthesisRequest) -> SpeechAudioArtifact:
        self.requests.append(request)
        return SpeechAudioArtifact(self.output, "audio/wav", self.provider_id, request.model)

    def capabilities(self) -> dict[str, object]:
        return {"kind": "tts", "enabled": True}


class FakeAsr:
    provider_id = "fake-asr"

    def __init__(self) -> None:
        self.requests: list[TranscriptionRequest] = []

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        self.requests.append(request)
        assert request.audio_path.read_bytes()
        return TranscriptionResult(
            text="本地识别成功",
            language="zh",
            duration=1.25,
            provider=self.provider_id,
            model=request.model,
            segments=[TranscriptSegment(id=0, start=0.0, end=1.25, text="本地识别成功")],
        )

    def capabilities(self) -> dict[str, object]:
        return {"kind": "asr", "enabled": True, "model": "test"}


def wav_file(path: Path) -> Path:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * 160)
    return path


def fixture(tmp_path: Path) -> tuple[TestClient, FakeTts, FakeAsr]:
    settings = load_settings(Path(__file__).parents[1] / "config.example.json")
    settings = replace(
        settings,
        server=replace(settings.server, temp_dir=tmp_path / "temp", ffmpeg=""),
    )
    tts = FakeTts(wav_file(tmp_path / "speech.wav"))
    asr = FakeAsr()
    registry = ProviderRegistry(tts.provider_id, asr.provider_id)
    registry.register_tts(tts)
    registry.register_asr(asr)
    return TestClient(create_app(settings, registry)), tts, asr


def auth() -> dict[str, str]:
    return {}


def test_loopback_microphone_status_and_contract_are_discoverable(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)
    status = client.get("/v1/microphone/status")
    assert status.status_code == 200
    assert status.json()["mode"] == "host_resident"
    assert status.json()["running"] is False
    models = client.get("/v1/models").json()
    assert models["api"]["microphone_start"]["scope"] == "loopback-only"
    invalid = client.post("/v1/microphone/start", json={"auto_submit": True, "route_id": ""})
    assert invalid.status_code == 422


def test_openai_style_tts(tmp_path: Path) -> None:
    client, tts, _asr = fixture(tmp_path)
    response = client.post(
        "/v1/audio/speech",
        headers=auth(),
        json={"model": "fake-tts/voice-model", "input": "你好", "voice": "character-a", "response_format": "wav"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.headers["x-rabispeech-provider"] == "fake-tts"
    assert tts.requests[0].model == "voice-model"
    assert tts.requests[0].voice == "character-a"


def test_openai_style_asr_and_verbose_response(tmp_path: Path) -> None:
    client, _tts, asr = fixture(tmp_path)
    response = client.post(
        "/v1/audio/transcriptions",
        headers=auth(),
        files={"file": ("sample.wav", wav_file(tmp_path / "sample.wav").read_bytes(), "audio/wav")},
        data={"model": "fake-asr/test", "response_format": "verbose_json", "language": "zh"},
    )
    assert response.status_code == 200
    assert response.json()["text"] == "本地识别成功"
    assert response.json()["provider"] == "fake-asr"
    assert response.json()["segments"][0]["end"] == 1.25
    assert asr.requests[0].language == "zh"


def test_dashscope_style_tts_and_asr_data_uri(tmp_path: Path) -> None:
    client, tts, _asr = fixture(tmp_path)
    speech = client.post(
        "/api/v1/services/audio/tts/SpeechSynthesizer",
        headers=auth(),
        json={"model": "fake-tts/local", "input": {"text": "兼容请求", "voice": "default", "format": "wav"}},
    )
    assert speech.status_code == 200
    assert tts.requests[-1].text == "兼容请求"

    audio = wav_file(tmp_path / "dash.wav").read_bytes()
    encoded = "data:audio/wav;base64," + base64.b64encode(audio).decode("ascii")
    transcription = client.post(
        "/api/v1/services/audio/asr/transcription",
        headers=auth(),
        json={"model": "fake-asr/local", "input": {"file_url": encoded}, "parameters": {"language_hints": ["zh"]}},
    )
    assert transcription.status_code == 200
    assert transcription.json()["output"]["task_status"] == "SUCCEEDED"
    assert transcription.json()["output"]["text"] == "本地识别成功"


def test_models_are_generated_from_provider_registry(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)
    response = client.get("/v1/models", headers=auth())
    assert response.status_code == 200
    rows = json.loads(response.text)["data"]
    assert {(row["capability"], row["provider"]) for row in rows} == {
        ("tts", "fake-tts"),
        ("asr", "fake-asr"),
    }
    tts = next(row for row in rows if row["capability"] == "tts")
    assert tts["request"]["required"] == ["model", "input"]
    assert tts["request"]["content_type"] == "application/json"
    detail = client.get(f"/v1/models/{tts['id']}")
    assert detail.status_code == 200
    assert detail.json()["request"]["endpoint"] == "/v1/audio/speech"


def test_public_discovery_redacts_private_paths_and_urls(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)
    health = client.get("/health").json()
    assert "config" not in health
    capabilities = client.get("/v1/capabilities").json()
    encoded = json.dumps(capabilities)
    assert "model_root" not in encoded
    assert "base_url" not in encoded
    assert capabilities["api"]["models"]["endpoint"] == "/v1/models"
