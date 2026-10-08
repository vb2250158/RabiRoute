from __future__ import annotations

import asyncio
import wave
from pathlib import Path

import httpx
import pytest

from rabispeech.config import HttpAsrModelSettings, HttpAsrProviderSettings
from rabispeech.contracts import TranscriptionRequest
from rabispeech.providers.http_asr import LocalHttpAsrProvider
from rabispeech.worker_supervisor import WorkerLaunch, worker_supervisor


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
        return 0.0

    monkeypatch.setattr(worker_supervisor, "ensure", ensure)
    model = HttpAsrModelSettings("fixture", "Fixture", "Fixture", "http://127.0.0.1:9999", "", True, (), (), WorkerLaunch())
    provider = LocalHttpAsrProvider(HttpAsrProviderSettings("fixture", True, "fixture", 10, (model,)))
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
