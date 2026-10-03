from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeVar

from .contracts import AsrProvider, TtsProvider
from .model_discovery import public_capabilities


logger = logging.getLogger(__name__)
Result = TypeVar("Result")


@dataclass(frozen=True)
class ProviderSelection:
    provider_id: str
    model: str


class ProviderRegistry:
    def __init__(self, default_tts: str, default_asr: str) -> None:
        self.default_tts = default_tts
        self.default_asr = default_asr
        self._tts: dict[str, TtsProvider] = {}
        self._asr: dict[str, AsrProvider] = {}
        self._capabilities_event_sink: Callable[[str, object], None] | None = None

    def set_capabilities_event_sink(self, sink: Callable[[str, object], None] | None) -> None:
        self._capabilities_event_sink = sink

    def _publish_capabilities_changed(self) -> None:
        if self._capabilities_event_sink is not None:
            try:
                # A refresh hint only: provider errors, configuration and paths never enter SSE.
                self._capabilities_event_sink("capabilities_changed", {"type": "capabilities_changed"})
            except Exception:
                logger.warning("RabiSpeech capability change notification failed.")

    @staticmethod
    def _public_provider_snapshot(provider: TtsProvider | AsrProvider) -> dict[str, object] | None:
        try:
            return public_capabilities(provider.capabilities())
        except Exception:
            # Observation failure must not replace an inference result or its original error.
            return None

    async def run_with_capability_events(
        self, provider: TtsProvider | AsrProvider, operation: Callable[[], Result | Awaitable[Result]]
    ) -> Result:
        if self._capabilities_event_sink is None:
            result = operation()
            return await result if inspect.isawaitable(result) else result
        before = await asyncio.to_thread(self._public_provider_snapshot, provider)
        try:
            result = operation()
            return await result if inspect.isawaitable(result) else result
        finally:
            after = await asyncio.to_thread(self._public_provider_snapshot, provider)
            if before != after:
                self._publish_capabilities_changed()

    def register_tts(self, provider: TtsProvider) -> None:
        self._register(self._tts, provider.provider_id, provider)
        self._publish_capabilities_changed()

    def register_asr(self, provider: AsrProvider) -> None:
        self._register(self._asr, provider.provider_id, provider)
        self._publish_capabilities_changed()

    def tts(self, requested_provider: str | None, model: str) -> tuple[TtsProvider, ProviderSelection]:
        selection = self._selection(requested_provider, model, self.default_tts, self._tts)
        return self._tts[selection.provider_id], selection

    def asr(self, requested_provider: str | None, model: str) -> tuple[AsrProvider, ProviderSelection]:
        selection = self._selection(requested_provider, model, self.default_asr, self._asr)
        return self._asr[selection.provider_id], selection

    def capabilities(self) -> dict[str, object]:
        return {
            "tts": {key: provider.capabilities() for key, provider in sorted(self._tts.items())},
            "asr": {key: provider.capabilities() for key, provider in sorted(self._asr.items())},
            "defaults": {"tts": self.default_tts, "asr": self.default_asr},
        }

    def local_only(self) -> bool:
        for provider in [*self._tts.values(), *self._asr.values()]:
            detail = provider.capabilities()
            if detail.get("enabled", True) and detail.get("local_only") is False:
                return False
        return True

    async def warmup(self) -> None:
        for provider in [*self._tts.values(), *self._asr.values()]:
            warmup = getattr(provider, "warmup", None)
            if not callable(warmup):
                continue
            await self.run_with_capability_events(provider, warmup)

    @staticmethod
    def _register(target: dict[str, object], provider_id: str, provider: object) -> None:
        key = provider_id.strip().lower()
        if not key or key in target:
            raise ValueError(f"Provider id must be unique and non-empty: {provider_id!r}")
        target[key] = provider

    @staticmethod
    def _selection(
        requested_provider: str | None,
        model: str,
        default_provider: str,
        available: dict[str, object],
    ) -> ProviderSelection:
        normalized_model = (model or "").strip() or "default"
        provider_id = (requested_provider or "").strip().lower()
        if not provider_id:
            for separator in ("/", ":"):
                prefix, found, suffix = normalized_model.partition(separator)
                if found and prefix.lower() in available and suffix:
                    provider_id = prefix.lower()
                    normalized_model = suffix
                    break
        provider_id = provider_id or default_provider.strip().lower()
        if provider_id not in available:
            raise KeyError(f"Unknown provider: {provider_id}")
        return ProviderSelection(provider_id=provider_id, model=normalized_model)
