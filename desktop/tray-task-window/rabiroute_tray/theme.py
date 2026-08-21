from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication, QMenu

from .themes import theme_definition


_THEME_OPTIONS = {"system", "light", "dark"}


def normalize_theme(value: object) -> str:
    return value if isinstance(value, str) and value in _THEME_OPTIONS else "system"


def system_theme_is_dark(app: QApplication) -> bool:
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as key:
            return int(winreg.QueryValueEx(key, "AppsUseLightTheme")[0]) == 0
    except (OSError, ImportError, ValueError, TypeError):
        try:
            return app.styleHints().colorScheme() == Qt.ColorScheme.Dark
        except (AttributeError, TypeError):
            return app.palette().color(QPalette.ColorRole.Window).lightness() < 128


def resolve_theme(theme: object, app: QApplication) -> str:
    normalized = normalize_theme(theme)
    if normalized != "system":
        return normalized
    return "dark" if system_theme_is_dark(app) else "light"


def theme_stylesheet(stylesheet: str, theme: object) -> str:
    result = stylesheet
    colors = theme_definition(normalize_theme(theme)).get("color_replacements", {})
    for light, dark in colors.items():
        result = result.replace(light, dark)
    return result


def rabi_menu_stylesheet(theme: object = "light") -> str:
    return str(theme_definition(normalize_theme(theme))["menu_stylesheet"])


RABI_MENU_STYLESHEET = rabi_menu_stylesheet()


def apply_rabi_menu_theme(*menus: QMenu, theme: object = "light") -> None:
    stylesheet = rabi_menu_stylesheet(theme)
    for menu in menus:
        menu.setStyleSheet(stylesheet)


def apply_rabi_application_theme(app: QApplication, theme: object) -> str:
    resolved = resolve_theme(theme, app)
    palette = QPalette(app.palette())
    for role, color in theme_definition(resolved)["application_palette"].items():
        palette.setColor(role, QColor(color))
    app.setPalette(palette)
    return resolved
