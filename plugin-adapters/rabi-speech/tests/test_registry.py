from __future__ import annotations

import asyncio
import json

import pytest

from rabispeech.events import SpeechEventHub
from rabispeech.registry import ProviderRegistry


class ChangingProvider:
    provider_id = "test-provider"

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.detail = {"enabled": True, "loaded": False, "warmup_error": "", "config_path": "private-config"}

    def capabilities(self) -> dict[str, object]:
        return self.detail

    async def warmup(self) -> None:
        if self.fail:
            self.detail["warmup_error"] = "private-error-and-credential"
            raise RuntimeError("original-warmup-failure")
        self.detail["loaded"] = True


@pytest.mark.parametrize("fail", [False, True])
def test_warmup_state_change_emits_real_sse_without_provider_contents(fail: bool) -> None:
    async def scenario() -> None:
        registry = ProviderRegistry("", "test-provider")
        provider = ChangingProvider(fail=fail)
        registry.register_asr(provider)
        hub = SpeechEventHub()
        registry.set_capabilities_event_sink(hub.publish)
        stream = hub.stream()
        await anext(stream)
        await anext(stream)
        try:
            if fail:
                with pytest.raises(RuntimeError, match="original-warmup-failure"):
                    await registry.warmup()
            else:
                await registry.warmup()
            frame = await asyncio.wait_for(anext(stream), timeout=1)
            assert frame == 'event: capabilities_changed\ndata: {"type":"capabilities_changed"}\n\n'
            assert "private" not in frame and "test-provider" not in frame
            assert registry.capabilities()["asr"][provider.provider_id]["loaded"] is (not fail)
        finally:
            await stream.aclose()

    asyncio.run(scenario())


def test_unchanged_public_state_and_private_only_changes_do_not_emit() -> None:
    async def scenario() -> None:
        registry = ProviderRegistry("", "test-provider")
        provider = ChangingProvider()
        registry.register_asr(provider)
        events: list[tuple[str, object]] = []
        registry.set_capabilities_event_sink(lambda kind, data: events.append((kind, data)))
        await registry.warmup()
        assert len(events) == 1
        await registry.warmup()
        await registry.run_with_capability_events(provider, lambda: provider.detail.update(config_path="another-private-path"))
        await asyncio.sleep(0.05)
        assert events == [("capabilities_changed", {"type": "capabilities_changed"})]

    asyncio.run(scenario())


def test_live_provider_registration_emits_but_rejected_registration_does_not() -> None:
    registry = ProviderRegistry("", "test-provider")
    events: list[tuple[str, object]] = []
    registry.set_capabilities_event_sink(lambda kind, data: events.append((kind, data)))
    registry.register_asr(ChangingProvider())
    with pytest.raises(ValueError):
        registry.register_asr(ChangingProvider())
    assert events == [("capabilities_changed", {"type": "capabilities_changed"})]
    assert "private" not in json.dumps(events)


def test_observation_or_sink_failure_does_not_replace_provider_result() -> None:
    async def scenario() -> None:
        registry = ProviderRegistry("", "test-provider")
        provider = ChangingProvider()

        def broken_sink(_kind: str, _data: object) -> None:
            raise RuntimeError("notification-only-failure")

        registry.set_capabilities_event_sink(broken_sink)
        assert await registry.run_with_capability_events(provider, lambda: provider.detail.update(loaded=True)) is None

        def unreadable() -> dict[str, object]:
            raise RuntimeError("private-capability-error")

        provider.capabilities = unreadable
        assert await registry.run_with_capability_events(provider, lambda: "original-result") == "original-result"
        failing_provider = ChangingProvider(fail=True)
        with pytest.raises(RuntimeError, match="original-warmup-failure"):
            await registry.run_with_capability_events(failing_provider, failing_provider.warmup)

    asyncio.run(scenario())
