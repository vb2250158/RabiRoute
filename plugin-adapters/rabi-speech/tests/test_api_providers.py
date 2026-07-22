from __future__ import annotations

import asyncio
import json
import wave
from pathlib import Path

import httpx

from rabispeech.config import ApiModelSettings, ApiProviderSettings, load_settings
from rabispeech.contracts import SpeechSynthesisRequest, TranscriptionRequest
from rabispeech.providers import ApiAsrProvider, ApiTtsProvider


def settings(kind: str) -> ApiProviderSettings:
    return ApiProviderSettings(
        id="test-api",
        enabled=True,
        protocol="openai-compatible",
        base_url="https://speech.example.test/v1",
        api_key_env="TEST_SPEECH_API_KEY",
        default_model=f"{kind}-model",
        default_voice="alloy",
        timeout_seconds=10,
        models=(ApiModelSettings(id=f"{kind}-model", name=f"{kind} model", languages=("multilingual",), features=()),),
    )


def wav_file(path: Path) -> Path:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * 160)
    return path


def test_config_loads_disabled_openai_compatible_examples() -> None:
    loaded = load_settings(Path(__file__).parents[1] / "config.example.json")
    assert loaded.api_tts[0].id == "openai-api"
    assert loaded.api_tts[0].enabled is False
    assert loaded.api_tts[1].protocol == "dashscope"
    assert loaded.api_asr[0].default_model == "gpt-4o-mini-transcribe"


def test_api_tts_uses_bearer_env_and_returns_temporary_audio(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("TEST_SPEECH_API_KEY", "test-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://speech.example.test/v1/audio/speech"
        assert request.headers["authorization"] == "Bearer test-secret"
        assert json.loads(request.content)["model"] == "tts-model"
        return httpx.Response(200, content=b"RIFF-test-audio", headers={"content-type": "audio/wav"})

    provider = ApiTtsProvider(settings("tts"), tmp_path, httpx.MockTransport(handler))
    artifact = asyncio.run(provider.synthesize(SpeechSynthesisRequest(text="你好", model="tts-model", voice="alloy")))
    assert artifact.path.read_bytes() == b"RIFF-test-audio"
    assert artifact.cleanup is True
    assert artifact.provider == "test-api"


def test_api_asr_sends_multipart_and_normalizes_verbose_json(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("TEST_SPEECH_API_KEY", "test-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://speech.example.test/v1/audio/transcriptions"
        assert request.headers["authorization"] == "Bearer test-secret"
        assert "multipart/form-data" in request.headers["content-type"]
        assert b'asr-model' in request.content
        return httpx.Response(200, json={
            "text": "识别成功",
            "language": "zh",
            "duration": 1.5,
            "segments": [{"id": 0, "start": 0, "end": 1.5, "text": "识别成功"}],
        })

    provider = ApiAsrProvider(settings("asr"), httpx.MockTransport(handler))
    result = asyncio.run(provider.transcribe(TranscriptionRequest(
        audio_path=wav_file(tmp_path / "sample.wav"),
        model="asr-model",
        language="zh",
    )))
    assert result.text == "识别成功"
    assert result.provider == "test-api"
    assert result.segments[0].end == 1.5


def test_remote_api_requires_https_and_key(tmp_path: Path, monkeypatch) -> None:
    invalid = ApiProviderSettings(
        **{**settings("tts").__dict__, "base_url": "http://speech.example.test/v1"}
    )
    try:
        ApiTtsProvider(invalid, tmp_path)
    except ValueError as error:
        assert "HTTPS" in str(error)
    else:
        raise AssertionError("Expected remote HTTP provider to be rejected")

    monkeypatch.delenv("TEST_SPEECH_API_KEY", raising=False)
    provider = ApiTtsProvider(settings("tts"), tmp_path, httpx.MockTransport(lambda _request: httpx.Response(500)))
    try:
        asyncio.run(provider.synthesize(SpeechSynthesisRequest(text="hello", model="tts-model")))
    except RuntimeError as error:
        assert "TEST_SPEECH_API_KEY" in str(error)
    else:
        raise AssertionError("Expected missing API key to be rejected")
