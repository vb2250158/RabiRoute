import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import unittest
from PySide6.QtCore import QPoint, QPointF, QRect, Qt
from PySide6.QtWidgets import QApplication, QWidget
from PySide6.QtGui import QPalette, QColor
from rabiroute_tray.computer_control_overlay import ControlBar, DrawingSurface, Presentation, map_source_point, centered_bar_position
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
        self.assertIn("<b>Agent</b>", presentation.bar.subtitle_label.text())
        self.assertIn("Ctrl+Shift+F12", presentation.bar.subtitle_label.text())
        presentation.update({"revision": 2, "layers": []})
        self.assertFalse(presentation.bar.isVisible())
        for surface in presentation.surfaces:
            surface.close()
        presentation.bar.close()

    def test_centered_bar_respects_negative_screen_and_bottom_work_area(self):
        area = QRect(-1600, 100, 1600, 900)
        top = centered_bar_position(area, 480, 64, "top-center")
        bottom = centered_bar_position(area, 480, 64, "bottom-center")
        self.assertEqual((top.x(), top.y()), (-1040, 116))
        self.assertEqual((bottom.x(), bottom.y()), (-1040, 920))

    def test_image_view_coordinates_preserve_original_frame_dimensions(self):
        source = {"coordinateSpace": "capture", "width": 3840, "height": 2160,
                  "frameId": "original", "imageItemId": "original-image",
                  "bounds": {"x": -3840, "y": 0, "width": 3840, "height": 2160},
                  "imageView": {"width": 512, "height": 288}}
        self.assertEqual(map_source_point(source, 256, 144), (-1920, 1080))
        self.assertEqual(source["width"], 3840)
        self.assertEqual(source["imageItemId"], "original-image")

    @unittest.skipUnless(os.name == "nt", "Windows native message coordinates")
    def test_native_hit_test_uses_message_coordinates_on_negative_screen(self):
        import ctypes
        from ctypes import wintypes
        from unittest.mock import patch
        presentation = Presentation(self.app)
        bar = presentation.bar
        bar.move(-1200, 200)
        bar.resize(520, 70)
        bar.show()
        self.app.processEvents()
        def client_rect(_handle, pointer):
            rectangle = ctypes.cast(pointer, ctypes.POINTER(wintypes.RECT)).contents
            rectangle.left, rectangle.top = 0, 0
            rectangle.right, rectangle.bottom = bar.width() * 2, bar.height() * 2
            return True

        def screen_to_client(_handle, pointer):
            point = ctypes.cast(pointer, ctypes.POINTER(wintypes.POINT)).contents
            point.x += 2400
            point.y -= 400
            return True

        with (
            patch.object(ctypes.windll.user32, "GetClientRect", client_rect),
            patch.object(ctypes.windll.user32, "ScreenToClient", screen_to_client),
            patch.object(QWidget, "nativeEvent", return_value=(False, 0)) as default_hit
        ):
            for local, transparent in [(QPoint(100, 30), True), (bar.button.geometry().center(), False)]:
                x, y = -2400 + local.x() * 2, 400 + local.y() * 2
                message = wintypes.MSG()
                message.message = 0x84
                message.lParam = (x & 0xffff) | ((y & 0xffff) << 16)
                result = bar.nativeEvent(b"windows_generic_MSG", ctypes.addressof(message))
                self.assertEqual(result == (True, -1), transparent)
            default_hit.assert_called_once()
        for surface in presentation.surfaces:
            surface.close()
        bar.close()

    def test_observation_phase_is_visible_without_claiming_model_delivery(self):
        presentation = Presentation(self.app)
        presentation.update({"revision": 1, "phase": "prepared", "source": {"label": "<b>Agent</b>"},
                             "sourceDisplay": {"displayId": self.app.primaryScreen().name(), "name": "屏幕 2"},
                             "presentationSettings": {"barPlacement": "bottom-center", "textSize": "large"},
                             "layers": []})
        self.assertIn("画面已准备", presentation.bar.title_label.text())
        self.assertIn("屏幕 2", presentation.bar.title_label.text())
        self.assertIn("<b>Agent</b>", presentation.bar.subtitle_label.text())
        self.assertTrue(presentation.bar.isVisible())
        area = self.app.primaryScreen().availableGeometry()
        self.assertEqual(presentation.bar.pos(), centered_bar_position(area, presentation.bar.width(), presentation.bar.height(), "bottom-center"))
        presentation.update({"revision": 2, "phase": "returned", "layers": []})
        presentation.update({"revision": 3, "phase": "operating", "layers": []})
        presentation.hide_completed_notice()
        self.assertTrue(presentation.bar.isVisible(), "old completed notice must not hide current operation")
        for surface in presentation.surfaces:
            surface.close()
        presentation.bar.close()

    def test_bar_uses_target_native_screen_instead_of_primary_screen(self):
        from types import SimpleNamespace
        presentation = Presentation(self.app)
        original_app, original_surfaces = presentation.app, presentation.surfaces
        left = SimpleNamespace(name=lambda: "left", availableGeometry=lambda: QRect(-1280, 0, 1280, 720))
        right = SimpleNamespace(name=lambda: "right", availableGeometry=lambda: QRect(0, 0, 1920, 1040))
        presentation.app = SimpleNamespace(screens=lambda: [left, right], primaryScreen=lambda: right)
        presentation.surfaces = [SimpleNamespace(screen_name="left", physical=(-2560, 0, 2560, 1440)),
                                 SimpleNamespace(screen_name="right", physical=(0, 0, 1920, 1080))]
        presentation.state = {"sourceDisplay": {"displayId": "left"}}
        self.assertIs(presentation.active_screen(), left)
        presentation.state = {"pointer": {"x": -2200, "y": 400}}
        self.assertIs(presentation.active_screen(), left)
        presentation.app, presentation.surfaces = original_app, original_surfaces
        for surface in presentation.surfaces:
            surface.close()
        presentation.bar.close()

    def test_returned_title_matches_actual_return_result(self):
        presentation = Presentation(self.app)
        cases = [
            ({"state": "restored", "cursor": "restored", "foreground": "restored"}, "已归还你的鼠标和前台"),
            ({"state": "partial", "cursor": "partial", "foreground": "restored"}, "归还需要检查"),
            ({"state": "yielded", "cursor": "yielded", "foreground": "yielded"}, "已让出操作"),
            ({"state": "unavailable"}, "归还需要检查"),
            ({"state": "restored", "cursor": "disabled", "foreground": "restored"}, "按设置保留"),
            ({}, "归还状态待确认")
        ]
        for returned, expected in cases:
            presentation.update({"phase": "returned", "returnState": returned, "layers": []})
            self.assertIn(expected, presentation.bar.title_label.text())
        for surface in presentation.surfaces:
            surface.close()
        presentation.bar.close()

    def test_desktop_theme_snapshot_uses_existing_palette_and_custom_registration(self):
        presentation = Presentation(self.app)
        for theme in ("dark", "light"):
            presentation.update({"revision": 1, "layers": [], "presentationTheme": {"theme": theme, "customThemes": []}})
            expected = QColor(theme_definition(theme)["application_palette"][QPalette.ColorRole.Window]).name()
            self.assertEqual(self.app.palette().color(QPalette.ColorRole.Window).name(), expected)
            presentation.update({"phase": "operating", "layers": []})
            self.assertEqual(presentation.bar.background_color.name(), expected)
        presentation.update({"revision": 2, "layers": [], "presentationTheme": {
            "theme": "custom:control-fixture", "customThemes": [{"id": "custom:control-fixture", "colors": {"canvas": "#112233"}}]}})
        self.assertEqual(presentation.resolved_theme, "custom:control-fixture")
        self.assertEqual(self.app.palette().color(QPalette.ColorRole.Window).name(), "#112233")
        for surface in presentation.surfaces:
            surface.close()
        presentation.bar.close()

    def test_compact_pill_has_transparent_corners_and_bounded_width(self):
        bar = ControlBar(lambda: None)
        bar.set_content("Rabi 正在操作 · 屏幕 2", "星海 · Ctrl+Alt+Esc 退出", "退出控制")
        bar.resize(bar.preferred_width(), bar.height())
        bar.show()
        self.app.processEvents()
        self.assertEqual(bar.height(), 46)
        self.assertLessEqual(bar.width(), 360)
        self.assertTrue(bar.testAttribute(Qt.WidgetAttribute.WA_TranslucentBackground))
        image = bar.grab().toImage()
        self.assertEqual(image.pixelColor(0, 0).alpha(), 0)
        self.assertGreater(image.pixelColor(image.width() // 2, image.height() // 2).alpha(), 240)
        bar.set_content("操作状态" * 100, "来源" * 100, "停止本次操作")
        self.assertLessEqual(bar.preferred_width(), 360)
        self.assertEqual(bar.title_label.text(), "操作状态" * 100)
        self.assertEqual(bar.button.accessibleName(), "停止本次操作")
        self.assertIn("来源" * 100, bar.button.toolTip())
        bar.apply_appearance(True)
        self.assertEqual(bar.height(), 58)
        self.assertLessEqual(bar.preferred_width(), 440)
        bar.close()


if __name__ == "__main__":
    unittest.main()
