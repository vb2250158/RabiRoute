from __future__ import annotations

import re
from typing import Any

from .dark.palette import THEME as DARK_THEME
from .light.palette import THEME as LIGHT_THEME

THEMES: dict[str, dict[str, Any]] = {
    "light": LIGHT_THEME,
    "dark": DARK_THEME,
}
_CUSTOM_THEME_IDS: set[str] = set()
_HEX_COLOR = re.compile(r"#[0-9a-f]{6}", re.IGNORECASE)
_CUSTOM_THEME_ID = re.compile(r"custom:[a-z0-9][a-z0-9-]{5,63}")


def theme_definition(name: str) -> dict[str, Any]:
    return THEMES.get(name, LIGHT_THEME)


def has_theme(name: object) -> bool:
    return isinstance(name, str) and name in THEMES


def register_custom_theme(value: object) -> str | None:
    for registered_id in _CUSTOM_THEME_IDS:
        THEMES.pop(registered_id, None)
    _CUSTOM_THEME_IDS.clear()
    if not isinstance(value, dict):
        return None
    theme_id = str(value.get("id") or "")
    colors = value.get("colors")
    styles = value.get("styles")
    if not _CUSTOM_THEME_ID.fullmatch(theme_id) or not isinstance(colors, dict):
        return None
    styles = styles if isinstance(styles, dict) else {}

    def color(name: str, fallback: str) -> str:
        candidate = str(colors.get(name) or "").strip().lower()
        return candidate if _HEX_COLOR.fullmatch(candidate) else fallback

    palette = {
        "pageCanvas": color("pageCanvas", "#eef6f8"), "canvas": color("canvas", "#f6f8fb"),
        "surface": color("surface", "#ffffff"), "subtle": color("subtle", "#f5f8fa"),
        "input": color("input", "#fbfdff"), "border": color("border", "#dbe5ea"),
        "borderStrong": color("borderStrong", "#cad8e0"), "text": color("text", "#112033"),
        "heading": color("heading", "#0c2a4a"), "muted": color("muted", "#52677a"),
        "accent": color("accent", "#19bfc1"), "accentStrong": color("accentStrong", "#0f8b8d"),
        "success": color("success", "#16a34a"), "warning": color("warning", "#f59e0b"),
        "error": color("error", "#dc2626"), "info": color("info", "#087f91"),
    }
    dark_semantics = {
        "#10161d": palette["pageCanvas"], "#121a22": palette["canvas"],
        "#19242e": palette["surface"], "#202c37": palette["subtle"], "#1d2934": palette["input"],
        "#31414f": palette["border"], "#526779": palette["borderStrong"],
        "#e9f2f7": palette["text"], "#f0f8fc": palette["heading"],
        "#c4d3dd": palette["muted"], "#b1c3cf": palette["muted"], "#9db1bf": palette["muted"],
        "#43d4d7": palette["accent"], "#88edef": palette["accentStrong"],
        "#3d7453": palette["success"], "#80612a": palette["warning"],
        "#834451": palette["error"], "#3f7193": palette["info"],
    }
    replacements = {light: dark_semantics.get(dark, dark) for light, dark in DARK_THEME["color_replacements"].items()}
    try:
        radius = max(0, min(24, int(styles.get("cornerRadius") or 8)))
    except (TypeError, ValueError):
        radius = 8
    menu_stylesheet = f"""
QMenu {{ background: {palette['surface']}; border: 1px solid {palette['border']}; border-radius: {radius}px;
 color: {palette['text']}; font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif; font-size: 13px; padding: 6px; }}
QMenu::item {{ border-radius: {max(0, radius - 2)}px; padding: 8px 28px 8px 12px; }}
QMenu::item:selected {{ background: {palette['subtle']}; color: {palette['heading']}; }}
QMenu::item:disabled {{ color: {palette['muted']}; }}
QMenu::separator {{ background: {palette['border']}; height: 1px; margin: 5px 8px; }}
"""
    from PySide6.QtGui import QPalette
    THEMES[theme_id] = {
        "menu_stylesheet": menu_stylesheet,
        "color_replacements": replacements,
        "application_palette": {
            QPalette.ColorRole.Window: palette["canvas"], QPalette.ColorRole.WindowText: palette["text"],
            QPalette.ColorRole.Base: palette["input"], QPalette.ColorRole.AlternateBase: palette["subtle"],
            QPalette.ColorRole.ToolTipBase: palette["surface"], QPalette.ColorRole.ToolTipText: palette["text"],
            QPalette.ColorRole.Text: palette["text"], QPalette.ColorRole.Button: palette["surface"],
            QPalette.ColorRole.ButtonText: palette["text"], QPalette.ColorRole.BrightText: palette["surface"],
            QPalette.ColorRole.Highlight: palette["accent"], QPalette.ColorRole.HighlightedText: palette["heading"],
            QPalette.ColorRole.Link: palette["accentStrong"],
        },
    }
    _CUSTOM_THEME_IDS.add(theme_id)
    return theme_id
