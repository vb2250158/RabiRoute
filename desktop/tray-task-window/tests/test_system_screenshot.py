from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

TRAY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, TRAY_ROOT)

from PySide6.QtWidgets import QApplication  # noqa: E402

from rabiroute_tray.system_selection import SelectionDeliveryTarget  # noqa: E402
from rabiroute_tray.system_screenshot import ScreenshotComposer, parse_hotkey  # noqa: E402


class SystemScreenshotTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_hotkey_parser_accepts_common_windows_shortcuts(self) -> None:
        modifiers, key = parse_hotkey("Ctrl + Shift + S") or (0, 0)
        self.assertEqual(modifiers & 0x0002, 0x0002)
        self.assertEqual(modifiers & 0x0004, 0x0004)
        self.assertEqual(key, ord("S"))

    def test_hotkey_parser_accepts_function_key(self) -> None:
        modifiers, key = parse_hotkey("Alt+F8") or (0, 0)
        self.assertEqual(modifiers & 0x0001, 0x0001)
        self.assertEqual(key, 0x77)

    def test_hotkey_parser_rejects_missing_modifier_or_key(self) -> None:
        self.assertIsNone(parse_hotkey("S"))
        self.assertIsNone(parse_hotkey("Ctrl+Shift"))
        self.assertIsNone(parse_hotkey("Ctrl+Shift+S+T"))

    def test_composer_emits_entered_text_and_selected_persona(self) -> None:
        composer = ScreenshotComposer(
            Path("C:/tmp/rabiroute-screenshot.png"),
            [
                SelectionDeliveryTarget("route-a", "人格 A"),
                SelectionDeliveryTarget("route-b", "人格 B"),
            ],
        )
        emitted: list[tuple[str, str]] = []
        composer.send_requested.connect(lambda gateway_id, text: emitted.append((gateway_id, text)))
        composer._target.setCurrentIndex(1)
        composer._text.setPlainText("  请查看截图中的按钮布局。  ")

        composer._send()

        self.assertEqual(emitted, [("route-b", "请查看截图中的按钮布局。")])
        composer.close()


if __name__ == "__main__":
    unittest.main()
