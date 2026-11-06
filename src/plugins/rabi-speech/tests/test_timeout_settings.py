import asyncio
import json
import pytest
import httpx
from rabispeech.timeout_settings import get_timeout_seconds
from rabispeech.config import ApiModelSettings, ApiProviderSettings
from rabispeech.contracts import SpeechSynthesisRequest
from rabispeech.providers import ApiTtsProvider

def test_snapshot_defaults_units_and_removal(monkeypatch):
    monkeypatch.delenv("RABIROUTE_TIMEOUT_OVERRIDES", raising=False)
    assert get_timeout_seconds("speech.apiTts.request", 10) == 10
    monkeypatch.setenv("RABIROUTE_TIMEOUT_OVERRIDES", '{"speech.apiTts.request":250}')
    assert get_timeout_seconds("speech.apiTts.request", 10) == .25
    monkeypatch.setenv("RABIROUTE_TIMEOUT_OVERRIDES", '{}')
    assert get_timeout_seconds("speech.apiTts.request", 10) == 10

@pytest.mark.parametrize("value", [0, -1, 1.5, True, "500", 2147483648])
def test_invalid_entry_is_local_and_diagnostic(monkeypatch, value, caplog):
    monkeypatch.setenv("RABIROUTE_TIMEOUT_OVERRIDES", json.dumps({"value": value, "valid": 1250}))
    assert get_timeout_seconds("value", 1) == 1
    assert get_timeout_seconds("valid", 30) == 1.25
    assert "Ignoring 1 invalid" in caplog.text


@pytest.mark.parametrize("raw", ["{broken", "[]", "null", '{"value":NaN}', '{"value":Infinity}'])
def test_unusable_snapshot_does_not_disable_service(monkeypatch, raw, caplog):
    monkeypatch.setenv("RABIROUTE_TIMEOUT_OVERRIDES", raw)
    assert get_timeout_seconds("value", 5) == 5
    assert caplog.records

def test_real_http_client_consumes_separate_request_and_connect_overrides(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_TIMEOUT_SPEECH_KEY", "test")
    monkeypatch.setenv("RABIROUTE_TIMEOUT_OVERRIDES", json.dumps({"speech.apiTts.request": 3210, "speech.apiTts.connect": 654}))
    def handler(request):
        assert request.extensions["timeout"]["read"] == 3.21
        assert request.extensions["timeout"]["connect"] == .654
        return httpx.Response(200, content=b"RIFF-test", headers={"content-type":"audio/wav"})
    settings = ApiProviderSettings(id="test", enabled=True, protocol="openai-compatible", base_url="https://speech.example.test/v1", api_key_env="TEST_TIMEOUT_SPEECH_KEY", default_model="tts-model", default_voice="alloy", timeout_seconds=180, models=(ApiModelSettings(id="tts-model",name="TTS",languages=(),features=()),))
    provider = ApiTtsProvider(settings,tmp_path,httpx.MockTransport(handler))
    result = asyncio.run(provider.synthesize(SpeechSynthesisRequest(text="test",model="tts-model",voice="alloy")))
    assert result.path.read_bytes() == b"RIFF-test"
