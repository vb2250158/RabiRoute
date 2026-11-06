from __future__ import annotations

import asyncio

from rabispeech.events import SpeechEventHub


def test_speech_event_hub_delivers_events_without_status_polling() -> None:
    async def scenario() -> None:
        hub = SpeechEventHub(queue_size=4)
        stream = hub.stream()
        assert "retry:" in await anext(stream)
        assert "event: ready" in await anext(stream)
        hub.publish("microphone_level", {"level": 0.25})
        frame = await asyncio.wait_for(anext(stream), timeout=1)
        assert "event: microphone_level" in frame
        assert '"level":0.25' in frame
        await stream.aclose()

    asyncio.run(scenario())
