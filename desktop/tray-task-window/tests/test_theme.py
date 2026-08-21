from __future__ import annotations

import unittest

from PySide6.QtWidgets import QApplication, QMenu

from rabiroute_tray.theme import apply_rabi_application_theme, apply_rabi_menu_theme, rabi_menu_stylesheet, theme_stylesheet
from rabiroute_tray.themes import theme_definition


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
