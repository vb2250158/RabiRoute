from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import Request

from test_api import fixture


@pytest.mark.parametrize("kind,fail", [("tts", False), ("asr", False), ("asr", True)])
def test_actual_request_state_change_reaches_sse_and_capabilities(tmp_path: Path, kind: str, fail: bool) -> None:
    async def scenario() -> None:
        client, tts, asr = fixture(tmp_path)
        provider = tts if kind == "tts" else asr
        detail = {"kind": kind, "enabled": True, "loaded": False, "config_path": "private-provider-path"}
        provider.capabilities = lambda: detail
        original = provider.synthesize if kind == "tts" else provider.transcribe

        async def operation(request):
            detail["loaded"] = True
            if fail:
                detail["enabled"] = False
                detail["warmup_error"] = "private-provider-error-and-token"
                raise RuntimeError("original-inference-failure")
            return await original(request)

        if kind == "tts":
            provider.synthesize = operation
        else:
            provider.transcribe = operation
        route = next(route for route in client.app.routes if getattr(route, "path", None) == "/v1/events")
        response = await route.endpoint(Request({"type": "http", "client": ("127.0.0.1", 12345)}))
        assert response.media_type == "text/event-stream"
        stream = response.body_iterator
        await anext(stream)
        await anext(stream)
        try:
            if kind == "tts":
                result = await asyncio.to_thread(client.post, "/v1/audio/speech", json={"model": "test", "input": "test"})
            else:
                audio = tts.output.read_bytes()
                result = await asyncio.to_thread(
                    client.post, "/v1/audio/transcriptions", files={"file": ("audio.wav", audio, "audio/wav")}
                )
            assert result.status_code == (502 if fail else 200)
            frame = await asyncio.wait_for(anext(stream), timeout=1)
            assert frame == 'event: capabilities_changed\ndata: {"type":"capabilities_changed"}\n\n'
            assert "private" not in frame and "token" not in frame and provider.provider_id not in frame
            capabilities = (await asyncio.to_thread(client.get, "/v1/capabilities")).json()["providers"][kind]
            assert capabilities[provider.provider_id]["loaded"] is True
            assert capabilities[provider.provider_id]["enabled"] is (not fail)
        finally:
            await stream.aclose()
            client.close()

    asyncio.run(scenario())
