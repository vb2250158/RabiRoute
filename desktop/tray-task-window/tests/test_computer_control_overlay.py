import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import unittest
from PySide6.QtCore import QPointF
from PySide6.QtWidgets import QApplication
from PySide6.QtGui import QPalette, QColor
from rabiroute_tray.computer_control_overlay import DrawingSurface, Presentation, map_source_point
from rabiroute_tray.themes import theme_definition


class ComputerControlOverlayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_capture_coordinates_keep_negative_desktop_bounds(self):
        source = {"coordinateSpace": "capture", "width": 800, "height": 600,
                  "bounds": {"x": -1600, "y": 100, "width": 1600, "height": 1200}}
        self.assertEqual(map_source_point(source, 400, 300), (-800, 700))
        self.assertEqual(map_source_point({"coordinateSpace": "desktop"}, -120, 30), (-120, 30))

    def test_all_six_shapes_render_without_becoming_input_widgets(self):
        surface = DrawingSurface(self.app.primaryScreen())
        surface.resize(320, 240)
        surface.physical = (0, 0, 320, 240)
        source = {"coordinateSpace": "desktop"}
        surface.state = {"layers": [{"source": source, "objects": [
            {"id": "r", "type": "rect", "bounds": {"x": 10, "y": 10, "width": 30, "height": 20}},
            {"id": "e", "type": "ellipse", "bounds": {"x": 60, "y": 10, "width": 30, "height": 20}},
            {"id": "a", "type": "arrow", "points": [{"x": 10, "y": 50}, {"x": 90, "y": 50}]},
            {"id": "p", "type": "path", "points": [{"x": 10, "y": 80}, {"x": 50, "y": 100}, {"x": 90, "y": 80}]},
            {"id": "t", "type": "text", "bounds": {"x": 10, "y": 130}, "text": "<b>pure text</b>"},
            {"id": "h", "type": "highlight", "bounds": {"x": 100, "y": 10, "width": 20, "height": 20}}
        ]}]}
        surface.show()
        self.app.processEvents()
        image = surface.grab().toImage()
        self.assertGreater(image.pixelColor(10, 10).alpha(), 0)
        self.assertGreater(image.pixelColor(70, 10).alpha(), 0)
        self.assertGreater(image.pixelColor(50, 50).alpha(), 0)
        self.assertGreater(image.pixelColor(50, 100).alpha(), 0)
        self.assertGreater(image.pixelColor(110, 20).alpha(), 0)
        self.assertEqual(len(surface.findChildren(type(surface))), 0)
        surface.close()

    def test_native_source_label_and_configured_shortcut_are_plain_text(self):
        presentation = Presentation(self.app)
        presentation.update({"revision": 1, "controlSessionId": "fixture", "source": {"label": "<b>Agent</b>"},
                             "exitShortcut": "Ctrl+Shift+F12", "countdownSeconds": 5,
                             "remainingMs": 4000, "layers": []})
        self.assertIn("<b>Agent</b>", presentation.bar.label.text())
        self.assertIn("Ctrl+Shift+F12", presentation.bar.label.text())
        presentation.update({"revision": 2, "layers": []})
        self.assertFalse(presentation.bar.isVisible())
        for surface in presentation.surfaces:
            surface.close()
        presentation.bar.close()

    def test_desktop_theme_snapshot_uses_existing_palette_and_custom_registration(self):
        presentation = Presentation(self.app)
        for theme in ("dark", "light"):
            presentation.update({"revision": 1, "layers": [], "presentationTheme": {"theme": theme, "customThemes": []}})
            expected = QColor(theme_definition(theme)["application_palette"][QPalette.ColorRole.Window]).name()
            self.assertEqual(self.app.palette().color(QPalette.ColorRole.Window).name(), expected)
        presentation.update({"revision": 2, "layers": [], "presentationTheme": {
            "theme": "custom:control-fixture", "customThemes": [{"id": "custom:control-fixture", "colors": {"canvas": "#112233"}}]}})
        self.assertEqual(presentation.resolved_theme, "custom:control-fixture")
        self.assertEqual(self.app.palette().color(QPalette.ColorRole.Window).name(), "#112233")
        for surface in presentation.surfaces:
            surface.close()
        presentation.bar.close()


if __name__ == "__main__":
    unittest.main()
