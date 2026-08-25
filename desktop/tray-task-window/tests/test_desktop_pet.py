from __future__ import annotations

import os
import io
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from rabiroute_tray.desktop_pet_client import DesktopPetClient, parse_desktop_pet_catalog
from rabiroute_tray.desktop_pet_events import iter_sse_events
from rabiroute_tray.desktop_pet_fullscreen import covers_monitor
from rabiroute_tray.desktop_pet_window import DesktopPetWindow


class DesktopPetCatalogTest(unittest.TestCase):
    def test_manager_sse_parser_keeps_generic_work_ended_payload(self) -> None:
        stream = io.BytesIO(
            b"event: ready\ndata: {}\n\n"
            b"event: work_ended\ndata: {\"id\":\"codex:1\",\"personaId\":\"YeYu\",\"status\":\"completed\"}\n\n"
        )

        events = list(iter_sse_events(stream))

        self.assertEqual(events[1][0], "work_ended")
        self.assertEqual(events[1][1]["personaId"], "YeYu")

    def test_binding_parser_keeps_persona_scoped_presentation_settings(self) -> None:
        client = DesktopPetClient("http://127.0.0.1:8790", "YeYu")
        client._get = lambda _path: (  # type: ignore[method-assign]
            b'{"data":{"personaId":"YeYu","binding":{"enabled":true,"packId":"night",'
            b'"scale":0.75,"opacity":0.8,"placement":{"screen":"DISPLAY-2","xRatio":0.2,"yRatio":0.9},'
            b'"alwaysOnTop":false,"clickThrough":true,"locked":true,"hideOnFullscreen":true,'
            b'"bubbleEnabled":false,"fpsCap":24}}}'
        )

        binding = client.binding()

        self.assertTrue(binding.enabled)
        self.assertEqual(binding.pack_id, "night")
        self.assertEqual(binding.placement["screen"], "DISPLAY-2")
        self.assertEqual(binding.fps_cap, 24)

    def test_fullscreen_detection_requires_covering_the_monitor(self) -> None:
        self.assertTrue(covers_monitor((0, 0, 1920, 1080), (0, 0, 1920, 1080)))
        self.assertFalse(covers_monitor((0, 0, 1000, 800), (0, 0, 1920, 1080)))

    def test_catalog_keeps_persona_binding_and_animation_metadata(self) -> None:
        packs = parse_desktop_pet_catalog(
            {
                "data": {
                    "personaId": "YeYu",
                    "packs": [
                        {
                            "id": "yeyu-library-default",
                            "name": "夜雨 · 图书馆日常",
                            "personaId": "YeYu",
                            "canvas": {"width": 512, "height": 512},
                            "scale": 0.5,
                            "states": {
                                "idle": {
                                    "type": "gif",
                                    "assets": ["/api/roles/YeYu/desktop-pet/packs/default/assets/idle.gif"],
                                    "fps": 12,
                                    "loop": True,
                                },
                                "thinking": {
                                    "type": "png-sequence",
                                    "assets": [
                                        "/api/roles/YeYu/desktop-pet/packs/default/assets/thinking_1.png",
                                        "/api/roles/YeYu/desktop-pet/packs/default/assets/thinking_2.png",
                                    ],
                                    "fps": 15,
                                    "loop": False,
                                    "next": "idle",
                                },
                            },
                        }
                    ],
                }
            },
            "YeYu",
        )

        self.assertEqual(len(packs), 1)
        self.assertEqual(packs[0].persona_id, "YeYu")
        self.assertEqual(packs[0].states["thinking"].fps, 15)
        self.assertEqual(packs[0].states["thinking"].next_state, "idle")

    def test_catalog_rejects_cross_persona_response(self) -> None:
        with self.assertRaisesRegex(ValueError, "different persona"):
            parse_desktop_pet_catalog({"data": {"personaId": "Other", "packs": []}}, "YeYu")


class DesktopPetWindowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_window_is_translucent_frameless_and_non_activating(self) -> None:
        window = DesktopPetWindow()
        try:
            self.assertTrue(window.testAttribute(Qt.WidgetAttribute.WA_TranslucentBackground))
            self.assertTrue(window.windowFlags() & Qt.WindowType.FramelessWindowHint)
            self.assertTrue(window.windowFlags() & Qt.WindowType.WindowDoesNotAcceptFocus)
            self.assertEqual(window.windowTitle(), "夜雨桌宠")
        finally:
            window.close()

    def test_click_through_can_be_enabled_and_recovered(self) -> None:
        window = DesktopPetWindow()
        try:
            window.set_click_through(True)
            self.assertTrue(window.windowFlags() & Qt.WindowType.WindowTransparentForInput)
            window.set_click_through(False)
            self.assertFalse(window.windowFlags() & Qt.WindowType.WindowTransparentForInput)
        finally:
            window.close()


if __name__ == "__main__":
    unittest.main()
