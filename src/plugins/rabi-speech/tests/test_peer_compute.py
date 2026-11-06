import asyncio
from pathlib import Path

import httpx
import pytest

from rabispeech import peer_compute


def test_microphone_uses_manager_selection_without_remote_to_local_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "audio.wav"
    source.write_bytes(b"sample")
    paths = []
    def respond(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path.endswith("/selection"):
            return httpx.Response(200, json={"selectedDeviceId": "peer-b"})
        return httpx.Response(200, json={"text": "remote", "provider": "worker", "model": "asr", "language": "zh", "duration": 1, "segments": []})
    original = httpx.AsyncClient
    monkeypatch.setattr(peer_compute.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs))
    result = asyncio.run(peer_compute.selected_remote_transcription("http://127.0.0.1:12345", source, model="asr", language=None, prompt=None))
    assert result.text == "remote"
    assert paths == ["/api/rabilink/peer/selection", "/api/speech/asr"]


def test_local_selection_preserves_original_inference(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    original = httpx.AsyncClient
    monkeypatch.setattr(peer_compute.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"selectedDeviceId": ""})), **kwargs))
    assert asyncio.run(peer_compute.selected_remote_transcription("http://127.0.0.1:12345", tmp_path / "unused.wav", model="asr", language=None, prompt=None)) is None
