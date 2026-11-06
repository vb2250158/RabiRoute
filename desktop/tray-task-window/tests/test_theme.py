from __future__ import annotations

import unittest

from PySide6.QtCore import Qt
from PySide6.QtGui import QImage, QPainter, QPalette
from PySide6.QtWidgets import QApplication, QMenu, QScrollBar, QStyle, QStyleOptionSlider

from rabiroute_tray.theme import apply_rabi_application_theme, apply_rabi_menu_theme, rabi_menu_stylesheet, rabi_scrollbar_stylesheet, theme_stylesheet
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

    def test_menu_stylesheet_is_only_reapplied_when_it_changes(self) -> None:
        class CountingMenu(QMenu):
            updates = 0

            def setStyleSheet(self, stylesheet: str) -> None:
                self.updates += 1
                super().setStyleSheet(stylesheet)

        menu = CountingMenu()
        apply_rabi_menu_theme(menu, theme="light")
        apply_rabi_menu_theme(menu, theme="light")
        self.assertEqual(menu.updates, 1)
        apply_rabi_menu_theme(menu, theme="dark")
        self.assertEqual(menu.updates, 2)
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


    def test_native_scrollbars_share_six_pixel_geometry_transparent_tracks_and_no_buttons(self) -> None:
        original_palette, original_stylesheet = self.app.palette(), self.app.styleSheet()
        self.addCleanup(self.app.setPalette, original_palette)
        self.addCleanup(self.app.setStyleSheet, original_stylesheet)
        apply_rabi_application_theme(self.app, "light")
        for orientation in (Qt.Orientation.Vertical, Qt.Orientation.Horizontal):
            bar = QScrollBar(orientation)
            self.addCleanup(bar.deleteLater)
            bar.setRange(0, 100)
            bar.setPageStep(20)
            bar.setValue(50)
            bar.resize(6, 180) if orientation == Qt.Orientation.Vertical else bar.resize(180, 6)
            bar.ensurePolished()
            option = QStyleOptionSlider()
            option.initFrom(bar)
            option.orientation = orientation
            option.minimum, option.maximum, option.pageStep = 0, 100, 20
            option.sliderPosition = option.sliderValue = 50
            option.singleStep = 1
            option.subControls = QStyle.SubControl.SC_All
            style = bar.style()
            extent = bar.sizeHint().width() if orientation == Qt.Orientation.Vertical else bar.sizeHint().height()
            self.assertEqual(extent, 6)
            slider = style.subControlRect(QStyle.ComplexControl.CC_ScrollBar, option, QStyle.SubControl.SC_ScrollBarSlider, bar)
            self.assertEqual(slider.width() if orientation == Qt.Orientation.Vertical else slider.height(), 6)
            self.assertGreaterEqual(slider.height() if orientation == Qt.Orientation.Vertical else slider.width(), 28)
            for control in (QStyle.SubControl.SC_ScrollBarAddLine, QStyle.SubControl.SC_ScrollBarSubLine):
                button = style.subControlRect(QStyle.ComplexControl.CC_ScrollBar, option, control, bar)
                self.assertEqual(button.width() * button.height(), 0)
            image = QImage(bar.size(), QImage.Format.Format_ARGB32_Premultiplied)
            image.fill(Qt.GlobalColor.transparent)
            painter = QPainter(image)
            style.drawComplexControl(QStyle.ComplexControl.CC_ScrollBar, option, painter, bar)
            painter.end()
            track = image.pixelColor(3, 5) if orientation == Qt.Orientation.Vertical else image.pixelColor(5, 3)
            self.assertEqual(track.alpha(), 0)
            self.assertGreater(image.pixelColor(slider.center()).alpha(), 0)

    def test_native_scrollbar_palette_updates_for_light_dark_and_registered_custom_theme(self) -> None:
        original_palette, original_stylesheet = self.app.palette(), self.app.styleSheet()
        self.addCleanup(self.app.setPalette, original_palette)
        self.addCleanup(self.app.setStyleSheet, original_stylesheet)
        light = rabi_scrollbar_stylesheet("light")
        dark = rabi_scrollbar_stylesheet("dark")
        self.assertIn("rgba(17, 32, 51, 122)", light)
        self.assertIn("rgba(233, 242, 247, 122)", dark)
        custom = register_custom_theme({"id": "custom:scrollbar-test", "colors": {"text": "#345678"}})
        for theme, expected in (("light", light), ("dark", dark), (custom, rabi_scrollbar_stylesheet(custom))):
            apply_rabi_application_theme(self.app, theme)
            self.assertEqual(self.app.styleSheet(), expected)
        self.assertIn("rgba(52, 86, 120, 122)", self.app.styleSheet())
        self.assertIn("rgba(52, 86, 120, 163)", self.app.styleSheet())
