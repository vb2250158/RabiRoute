from __future__ import annotations

import unittest

from rabiroute_tray.manager_client import SelectionSpeechSettings
from rabiroute_tray.system_selection import (
    WindowsSelectionReader,
    active_selection_delivery_targets,
    calculate_overlay_position,
    normalize_selected_text,
    resolve_selection_speech_model,
)


class _Context:
    def __enter__(self):
        return self

    def __exit__(self, _type, _value, _traceback):
        return None


class _Rect:
    left = 10
    top = 20
    right = 110
    bottom = 40


class _TextRange:
    def GetText(self, _max_length: int) -> str:
        return "  第一行\n\n第二行  "

    def GetBoundingRectangles(self):
        return [_Rect()]


class _Pattern:
    def GetSelection(self):
        return [_TextRange()]


class _Control:
    def __init__(self, password: bool = False) -> None:
        self.IsPassword = password

    def GetPattern(self, _pattern_id: int):
        return _Pattern()

    def GetParentControl(self):
        return None


class _Automation:
    class PatternId:
        TextPattern = 10014

    UIAutomationInitializerInThread = _Context

    def __init__(self, control: _Control) -> None:
        self.control = control

    def GetFocusedControl(self):
        return self.control


class SystemSelectionTest(unittest.TestCase):
    def test_reader_uses_uia_text_selection_without_clipboard(self) -> None:
        selected = WindowsSelectionReader(_Automation(_Control())).read()

        self.assertIsNotNone(selected)
        self.assertEqual(selected and selected.text, "第一行 第二行")
        self.assertEqual(selected and selected.rect and selected.rect.right, 110)

    def test_reader_excludes_password_controls(self) -> None:
        self.assertIsNone(WindowsSelectionReader(_Automation(_Control(password=True))).read())

    def test_default_model_is_used_until_advanced_selection_is_enabled(self) -> None:
        models = [
            {"id": "tts/first", "capability": "tts", "available": True, "isDefault": False},
            {"id": "tts/default", "capability": "tts", "available": True, "isDefault": True},
        ]

        self.assertEqual(
            resolve_selection_speech_model(SelectionSpeechSettings(True, False, "tts/first"), models),
            "tts/default",
        )
        self.assertEqual(
            resolve_selection_speech_model(SelectionSpeechSettings(True, True, "tts/first"), models),
            "tts/first",
        )

    def test_overlay_stays_inside_the_active_screen(self) -> None:
        self.assertEqual(calculate_overlay_position(5, 5, 220, 40, 0, 0, 1920, 1080), (8, 17))
        self.assertEqual(calculate_overlay_position(1915, 1075, 220, 40, 0, 0, 1920, 1080), (1692, 1023))

    def test_selection_text_is_bounded(self) -> None:
        self.assertEqual(normalize_selected_text(" a\n b ", 3), "a b")

    def test_delivery_targets_include_only_running_enabled_personas(self) -> None:
        targets = active_selection_delivery_targets(
            [
                {"id": "disabled", "configName": "Disabled", "enabled": False, "running": True},
                {"id": "stopped", "configName": "Stopped", "enabled": True, "running": False},
                {"id": "other", "configName": "Other", "enabled": True, "running": True},
                {"id": "preferred", "configName": "Preferred", "enabled": True, "running": True},
            ],
            preferred_gateway_id="preferred",
        )

        self.assertEqual(
            [(target.gateway_id, target.label) for target in targets],
            [("preferred", "Preferred"), ("other", "Other")],
        )


if __name__ == "__main__":
    unittest.main()
