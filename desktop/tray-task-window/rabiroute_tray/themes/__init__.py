from __future__ import annotations

from typing import Any

from .dark.palette import THEME as DARK_THEME
from .light.palette import THEME as LIGHT_THEME

THEMES: dict[str, dict[str, Any]] = {
    "light": LIGHT_THEME,
    "dark": DARK_THEME,
}


def theme_definition(name: str) -> dict[str, Any]:
    return THEMES.get(name, LIGHT_THEME)
