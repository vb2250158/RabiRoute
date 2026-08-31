from __future__ import annotations

import importlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


_PROFILE_SCHEMA_VERSION = 1
_PET_RENDERER_FEATURE = "io.rabiroute.desktop.pet-renderer@1"
_BUILTIN_FEATURE_MODULES = {
    _PET_RENDERER_FEATURE: "rabiroute_tray.desktop_pet_feature",
}


@dataclass(frozen=True)
class DesktopFeatureContext:
    manager_url: str
    application: object
    desktop_pet_action: object
    desktop_pet_click_through_action: object
    open_desktop_pet_persona: Callable[[], None]


def enabled_builtin_feature_ids(profile_path: Path | None = None) -> tuple[str, ...]:
    """Read the Qt-host profile without accepting arbitrary Python imports."""
    try:
        profile = profile_path or Path(__file__).with_name("desktop-host.profile.json")
        payload = json.loads(profile.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ()
    if not isinstance(payload, dict) or payload.get("schemaVersion") != _PROFILE_SCHEMA_VERSION:
        return ()
    if payload.get("host") != "io.rabiroute.desktop.qt-host":
        return ()
    features = payload.get("features")
    if not isinstance(features, list):
        return ()
    selected: list[str] = []
    for feature in features:
        if not isinstance(feature, dict) or feature.get("enabled") is not True:
            continue
        feature_id = feature.get("id")
        if isinstance(feature_id, str) and feature_id in _BUILTIN_FEATURE_MODULES and feature_id not in selected:
            selected.append(feature_id)
    return tuple(selected)


def activate_builtin_features(
    feature_ids: tuple[str, ...],
    context: DesktopFeatureContext,
) -> tuple[Callable[[], None], ...]:
    """Activate profile-selected presentation features and return their disposers."""
    disposers: list[Callable[[], None]] = []
    for feature_id in feature_ids:
        module_name = _BUILTIN_FEATURE_MODULES[feature_id]
        activate = getattr(importlib.import_module(module_name), "activate", None)
        if not callable(activate):
            raise TypeError(f"Desktop feature has no activate(context): {feature_id}")
        dispose = activate(context)
        if not callable(dispose):
            raise TypeError(f"Desktop feature did not return a disposer: {feature_id}")
        disposers.append(dispose)
    return tuple(disposers)
