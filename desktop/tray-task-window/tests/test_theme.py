from __future__ import annotations

import unittest

from PySide6.QtWidgets import QApplication, QMenu

from rabiroute_tray.theme import apply_rabi_application_theme, apply_rabi_menu_theme, rabi_menu_stylesheet, theme_stylesheet
from rabiroute_tray.themes import has_theme, register_custom_theme, theme_definition


class ThemeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_each_tray_theme_has_its_own_palette_definition(self) -> None:
        self.assertIn("application_palette", theme_definition("light"))
        self.assertIn("application_palette", theme_definition("dark"))
        self.assertTrue(theme_definition("dark")["color_replacements"])

    def test_dark_stylesheet_replaces_shared_light_surfaces(self) -> None:
        stylesheet = theme_stylesheet("QWidget { background: #f6f8fb; color: #112033; }", "dark")
        self.assertIn("background: #121a22", stylesheet)
        self.assertIn("color: #e9f2f7", stylesheet)

    def test_menu_and_application_use_explicit_dark_theme(self) -> None:
        menu = QMenu()
        resolved = apply_rabi_application_theme(self.app, "dark")
        apply_rabi_menu_theme(menu, theme=resolved)
        self.assertEqual(resolved, "dark")
        self.assertEqual(menu.styleSheet(), rabi_menu_stylesheet("dark"))

    def test_custom_theme_drives_qt_palette_menu_and_stylesheet(self) -> None:
        theme_id = register_custom_theme({
            "id": "custom:night-rain-green",
            "colors": {
                "canvas": "#101820", "surface": "#17242b", "input": "#1a2b31", "subtle": "#20343b",
                "border": "#31505a", "borderStrong": "#47717d", "text": "#e8f5ee", "heading": "#f4fff8",
                "muted": "#bad0c2", "accent": "#22c55e", "accentStrong": "#16a34a"
            },
            "styles": {"cornerRadius": 12}
        })
        self.assertEqual(theme_id, "custom:night-rain-green")
        self.assertIn("border-radius: 12px", rabi_menu_stylesheet(theme_id))
        self.assertIn("#17242b", theme_stylesheet("QWidget { background: #ffffff; }", theme_id))
        self.assertEqual(apply_rabi_application_theme(self.app, theme_id), theme_id)

    def test_custom_theme_registration_rejects_invalid_hex_and_clears_stale_entries(self) -> None:
        first_id = register_custom_theme({
            "id": "custom:first-theme",
            "colors": {"accent": "#nothex"},
        })
        self.assertEqual(first_id, "custom:first-theme")
        self.assertNotIn("#nothex", str(theme_definition(first_id)))
        self.assertTrue(has_theme(first_id))

        second_id = register_custom_theme({"id": "custom:second-theme", "colors": {}})
        self.assertEqual(second_id, "custom:second-theme")
        self.assertFalse(has_theme(first_id))
        self.assertTrue(has_theme(second_id))

        self.assertIsNone(register_custom_theme(None))
        self.assertFalse(has_theme(second_id))
