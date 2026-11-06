from __future__ import annotations

from importlib import import_module

from .config import Settings
from .registry import ProviderRegistry


def load_provider_extensions(registry: ProviderRegistry, settings: Settings) -> None:
    """Load provider registration hooks explicitly named in the local config.

    Each hook uses ``python.module:register`` and receives the shared registry
    plus the immutable RabiSpeech settings. Remote API input cannot affect this
    list, so adding executable providers remains a local administrator action.
    """

    for spec in settings.provider_extensions:
        module_name, separator, attribute = spec.partition(":")
        if not separator or not module_name.strip() or not attribute.strip():
            raise ValueError(f"Invalid RabiSpeech provider extension {spec!r}; expected python.module:callable.")
        module = import_module(module_name.strip())
        register = getattr(module, attribute.strip(), None)
        if not callable(register):
            raise ValueError(f"RabiSpeech provider extension is not callable: {spec!r}")
        register(registry, settings)
