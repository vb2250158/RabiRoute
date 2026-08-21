from __future__ import annotations

import ctypes
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QByteArray, QMimeData, QPoint
from PySide6.QtWidgets import QApplication

from rabiroute_tray.manager_client import SelectionSpeechSettings
from rabiroute_tray.system_selection import (
    KeyboardSelectionTracker,
    SELECTION_COPY_INPUT_TAG,
    ScreenRect,
    SelectedText,
    SelectionActionBar,
    SelectionDeliveryTarget,
    SelectionTrigger,
    SystemSelectionController,
    WindowsClipboardSelectionReader,
    WindowsGlobalSelectionHook,
    WindowsSelectionReader,
    caret_screen_rect,
    active_selection_delivery_targets,
    begin_rabiroute_copy_input,
    end_rabiroute_copy_input,
    calculate_overlay_position,
    is_clipboard_selection_fallback_process,
    is_rabiroute_copy_input,
    normalize_selected_text,
    resolve_selection_speech_model,
    selection_action_palette,
    selection_action_stylesheet,
    selection_delivery_menu_stylesheet,
    selection_rect_from_keyboard,
    selection_trigger_from_drag,
    point_anchor_rect,
)


class _Context:
    def __enter__(self):
        return self

    def __exit__(self, _type, _value, _traceback):
        return None


class _Rect:
    def __init__(self, left: int = 10, top: int = 20, right: int = 110, bottom: int = 40) -> None:
        self.left = left
        self.top = top
        self.right = right
        self.bottom = bottom


class _TextRange:
    def __init__(self, text: str = "  第一行\n\n第二行  ", rects: list[_Rect] | None = None) -> None:
        self.text = text
        self.rects = rects or [_Rect()]

    def GetText(self, _max_length: int) -> str:
        return self.text

    def GetBoundingRectangles(self):
        return self.rects


class _Pattern:
    def __init__(self, ranges: list[_TextRange] | None = None) -> None:
        self.ranges = ranges or [_TextRange()]

    def GetSelection(self):
        return self.ranges


class _Control:
    def __init__(self, password: bool = False, pattern: _Pattern | None = None) -> None:
        self.IsPassword = password
        self.pattern = pattern or _Pattern()

    def GetPattern(self, _pattern_id: int):
        return self.pattern

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


class _SelectionReader:
    def read(self) -> SelectedText:
        return SelectedText("测试选区", ScreenRect(10, 20, 110, 40))


class _SelectionReaderWithoutRect:
    def read(self) -> SelectedText:
        return SelectedText("Unity 选区")


class _ClipboardReader:
    def __init__(self) -> None:
        self.cancel_count = 0

    def can_capture_foreground(self) -> bool:
        return False

    def capture(self, _callback) -> None:
        raise AssertionError("clipboard fallback should not run")

    def cancel(self) -> None:
        self.cancel_count += 1


class _Clipboard:
    def __init__(self, text: str = "") -> None:
        self._mime = QMimeData()
        self._mime.setText(text)

    def mimeData(self) -> QMimeData:
        return self._mime

    def text(self) -> str:
        return self._mime.text()

    def setMimeData(self, mime: QMimeData) -> None:
        self._mime = mime

    def setText(self, text: str) -> None:
        mime = QMimeData()
        mime.setText(text)
        self._mime = mime


class _ClipboardSignal:
    def __init__(self) -> None:
        self._callbacks = []

    def connect(self, callback) -> None:
        self._callbacks.append(callback)

    def disconnect(self, callback) -> None:
        self._callbacks.remove(callback)

    def emit(self) -> None:
        for callback in tuple(self._callbacks):
            callback()


class _EventClipboard(_Clipboard):
    def __init__(self, text: str = "") -> None:
        super().__init__(text)
        self.dataChanged = _ClipboardSignal()

    def setText(self, text: str) -> None:
        super().setText(text)
        self.dataChanged.emit()


class SystemSelectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_reader_uses_uia_text_selection_without_clipboard(self) -> None:
        selected = WindowsSelectionReader(_Automation(_Control())).read()

        self.assertIsNotNone(selected)
        self.assertEqual(selected and selected.text, "第一行 第二行")
        self.assertEqual(selected and selected.rect and selected.rect.right, 110)

    def test_reader_merges_all_selection_rectangles(self) -> None:
        pattern = _Pattern(
            [
                _TextRange("第一段", [_Rect(10, 20, 50, 40), _Rect(8, 45, 90, 65)]),
                _TextRange("第二段", [_Rect(100, 45, 160, 65)]),
            ]
        )

        selected = WindowsSelectionReader(_Automation(_Control(pattern=pattern))).read()

        self.assertEqual(selected and selected.text, "第一段 第二段")
        self.assertEqual(selected and selected.rect, ScreenRect(8, 20, 160, 65))

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

    def test_overlay_stays_outside_the_selected_text(self) -> None:
        selection_rect = ScreenRect(300, 200, 500, 260)

        below = calculate_overlay_position(400, 260, 220, 50, 0, 0, 1920, 1080, selection_rect, False)
        above = calculate_overlay_position(400, 200, 220, 50, 0, 0, 1920, 1080, selection_rect, True)

        self.assertGreaterEqual(below[1], selection_rect.bottom + 8)
        self.assertLessEqual(above[1] + 50, selection_rect.top - 8)

    def test_overlay_centers_on_selection_rect_instead_of_trigger_anchor(self) -> None:
        selection_rect = ScreenRect(300, 200, 500, 260)

        x, _y = calculate_overlay_position(
            900,
            260,
            220,
            50,
            0,
            0,
            1920,
            1080,
            selection_rect,
            False,
        )

        self.assertEqual(x, 290)

    def test_vertical_drag_direction_selects_the_opposite_menu_side(self) -> None:
        self.assertFalse(selection_trigger_from_drag(10, 10, 100, 10).prefer_above)
        self.assertFalse(selection_trigger_from_drag(100, 10, 10, 10).prefer_above)
        self.assertFalse(selection_trigger_from_drag(10, 10, 10, 100).prefer_above)
        self.assertTrue(selection_trigger_from_drag(10, 100, 10, 10).prefer_above)

    def test_drag_trigger_preserves_a_text_area_rect_hint(self) -> None:
        trigger = selection_trigger_from_drag(100, 200, 300, 200)

        self.assertEqual(trigger.rect_hint, ScreenRect(100, 190, 300, 210))

    def test_caret_rect_rejects_missing_caret_and_normalizes_zero_width(self) -> None:
        self.assertIsNone(caret_screen_rect(0, 0, 0, 0))
        self.assertEqual(
            caret_screen_rect(100, 200, 100, 220),
            ScreenRect(100, 200, 102, 220),
        )

    def test_keyboard_selection_uses_caret_range_then_recent_click_fallback(self) -> None:
        start = ScreenRect(100, 200, 102, 220)
        current = ScreenRect(300, 200, 302, 220)
        fallback = point_anchor_rect(500, 600)

        self.assertEqual(
            selection_rect_from_keyboard(start, current, fallback),
            ScreenRect(100, 200, 302, 220),
        )
        self.assertEqual(selection_rect_from_keyboard(None, None, fallback), fallback)

    def test_shift_navigation_triggers_after_shift_is_released(self) -> None:
        forward = KeyboardSelectionTracker()
        self.assertIsNone(forward.handle(0xA0, True))
        self.assertIsNone(forward.handle(0x27, True))
        self.assertFalse(forward.handle(0xA0, False))

        backward = KeyboardSelectionTracker()
        backward.handle(0xA1, True)
        backward.handle(0x25, True)
        self.assertTrue(backward.handle(0xA1, False))

    def test_keyboard_hook_ignores_only_rabiroute_copy_input(self) -> None:
        self.assertTrue(is_rabiroute_copy_input(0x10, SELECTION_COPY_INPUT_TAG))
        self.assertFalse(is_rabiroute_copy_input(0x10, 0x1234))
        self.assertFalse(is_rabiroute_copy_input(0, SELECTION_COPY_INPUT_TAG))

    def test_copy_guard_ignores_only_expected_injected_sequence(self) -> None:
        events = ((0x11, 0), (0x43, 0), (0x43, 0x0002), (0x11, 0x0002))
        begin_rabiroute_copy_input(events)
        try:
            self.assertTrue(is_rabiroute_copy_input(0x10, 0, 0x11, False))
            self.assertFalse(is_rabiroute_copy_input(0x10, 0, 0x41, False))
            self.assertTrue(is_rabiroute_copy_input(0x10, 0, 0x43, False))
            self.assertTrue(is_rabiroute_copy_input(0x10, 0, 0x43, True))
            self.assertTrue(is_rabiroute_copy_input(0x10, 0, 0x11, True))
            self.assertFalse(is_rabiroute_copy_input(0x10, 0, 0x43, False))
        finally:
            end_rabiroute_copy_input()

        self.assertFalse(is_rabiroute_copy_input(0x10, 0, 0x11, False))

    def test_copy_guard_survives_sendinput_return_until_hook_consumes_events(self) -> None:
        with patch.object(ctypes.windll.user32, "SendInput", return_value=4):
            self.assertTrue(WindowsClipboardSelectionReader._send_copy_shortcut())

        self.assertTrue(is_rabiroute_copy_input(0x10, 0, 0x11, False))
        self.assertTrue(is_rabiroute_copy_input(0x10, 0, 0x43, False))
        self.assertTrue(is_rabiroute_copy_input(0x10, 0, 0x43, True))
        self.assertTrue(is_rabiroute_copy_input(0x10, 0, 0x11, True))

    def test_copy_guard_is_cleared_when_sendinput_is_incomplete(self) -> None:
        with patch.object(ctypes.windll.user32, "SendInput", return_value=3):
            self.assertFalse(WindowsClipboardSelectionReader._send_copy_shortcut())

        self.assertFalse(is_rabiroute_copy_input(0x10, 0, 0x11, False))


    def test_unity_clipboard_fallback_allows_a_busy_editor_frame(self) -> None:
        reader = WindowsClipboardSelectionReader()

        self.assertGreaterEqual(reader._timeout_ms, 800)

    def test_regular_typing_cancels_a_pending_keyboard_selection(self) -> None:
        tracker = KeyboardSelectionTracker()
        tracker.handle(0xA0, True)
        tracker.handle(0x27, True)
        tracker.handle(0x41, True)

        self.assertIsNone(tracker.handle(0xA0, False))

    def test_clipboard_fallback_is_limited_to_unity(self) -> None:
        self.assertTrue(is_clipboard_selection_fallback_process("Unity.exe"))
        self.assertFalse(is_clipboard_selection_fallback_process("notepad.exe"))

    def test_unity_clipboard_capture_reads_the_clipboard_change_event(self) -> None:
        clipboard = _EventClipboard("原剪贴板")
        sequence = [1]
        results: list[SelectedText | None] = []

        def send_copy() -> bool:
            sequence[0] = 2
            clipboard.setText("Unity 选区")
            return True

        reader = WindowsClipboardSelectionReader(
            process_name_provider=lambda: "Unity.exe",
            copy_sender=send_copy,
            clipboard_provider=lambda: clipboard,
            sequence_provider=lambda: sequence[0],
        )
        with patch("rabiroute_tray.system_selection.sys.platform", "win32"):
            reader.capture(results.append)

        self.assertEqual(results, [SelectedText("Unity 选区")])
        self.assertEqual(clipboard.text(), "原剪贴板")
        self.assertEqual(clipboard.dataChanged._callbacks, [])

    def test_unity_clipboard_capture_restores_all_original_mime_data(self) -> None:
        clipboard = _Clipboard("原剪贴板")
        clipboard.mimeData().setData(
            "application/x-rabiroute-test",
            QByteArray("保留".encode("utf-8")),
        )
        sequence = [1]
        results: list[SelectedText | None] = []

        def send_copy() -> bool:
            clipboard.setText("Unity 选区")
            sequence[0] = 2
            return True

        reader = WindowsClipboardSelectionReader(
            process_name_provider=lambda: "Unity.exe",
            copy_sender=send_copy,
            clipboard_provider=lambda: clipboard,
            sequence_provider=lambda: sequence[0],
        )
        with patch("rabiroute_tray.system_selection.sys.platform", "win32"):
            reader.capture(results.append)
            reader._poll()

        self.assertEqual(results, [SelectedText("Unity 选区")])
        self.assertEqual(clipboard.text(), "原剪贴板")
        self.assertEqual(
            bytes(clipboard.mimeData().data("application/x-rabiroute-test")),
            "保留".encode("utf-8"),
        )

    def test_cancel_restores_clipboard_after_copy_has_changed_it(self) -> None:
        clipboard = _Clipboard("原剪贴板")
        sequence = [1]
        results: list[SelectedText | None] = []
        reader = WindowsClipboardSelectionReader(
            process_name_provider=lambda: "Unity.exe",
            copy_sender=lambda: True,
            clipboard_provider=lambda: clipboard,
            sequence_provider=lambda: sequence[0],
        )
        with patch("rabiroute_tray.system_selection.sys.platform", "win32"):
            reader.capture(results.append)
            clipboard.setText("临时选区")
            sequence[0] = 2
            reader.cancel()

        self.assertEqual(results, [])
        self.assertEqual(clipboard.text(), "原剪贴板")

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

    def test_action_bar_has_accessible_labels_and_distinct_interaction_states(self) -> None:
        bar = SelectionActionBar(lambda: [SelectionDeliveryTarget("default-main", "默认人格")])
        bar.ensurePolished()
        bar.adjustSize()

        self.assertEqual(bar.read_button.accessibleName(), "朗读选中的文字")
        self.assertEqual(bar.deliver_button.accessibleName(), "投递选中文字至人格")
        self.assertEqual(bar.deliver_button.text(), "投递至 ▾")
        self.assertGreaterEqual(bar.read_button.sizeHint().height(), 32)
        self.assertLess(bar.read_button.sizeHint().height(), 38)
        self.assertGreaterEqual(bar.deliver_button.sizeHint().height(), 32)
        self.assertLess(bar.deliver_button.sizeHint().height(), 38)

        light_style = selection_action_stylesheet(selection_action_palette(False))
        dark_style = selection_action_stylesheet(selection_action_palette(True))
        self.assertIn("min-height: 32px", light_style)
        self.assertIn("#selectionReadButton:pressed", light_style)
        self.assertIn("#selectionDeliverButton:pressed", light_style)
        self.assertNotEqual(light_style, dark_style)
        self.assertIn("QMenu::item:selected", selection_delivery_menu_stylesheet(selection_action_palette(True)))

    def test_action_bar_explains_when_no_persona_can_receive_selection(self) -> None:
        bar = SelectionActionBar(lambda: [])
        bar.show_for(QPoint(100, 100), can_deliver=False, can_read=True)

        self.assertFalse(bar.deliver_button.isEnabled())
        self.assertEqual(bar.deliver_button.toolTip(), "暂无激活人格")
        bar.hide()

    def test_controller_passes_selection_geometry_and_direction_to_toolbar(self) -> None:
        targets = [SelectionDeliveryTarget("default-main", "默认人格")]
        clipboard_reader = _ClipboardReader()
        controller = SystemSelectionController(
            manager=object(),
            delivery_targets_provider=lambda: targets,
            notify=lambda _title, _message, _is_error: None,
            reader=_SelectionReader(),
            hook=WindowsGlobalSelectionHook(),
            clipboard_reader=clipboard_reader,
        )
        controller._settings = SelectionSpeechSettings(enabled=True)

        def run_immediately(operation, completed, **_kwargs):
            task = object()
            completed(task, operation())
            return task

        with patch("rabiroute_tray.system_selection.start_qt_task", side_effect=run_immediately):
            with patch.object(controller._toolbar, "show_for") as show_for:
                controller._selection_finished(
                    SelectionTrigger(
                        source="keyboard",
                        anchor_x=50,
                        anchor_y=60,
                        prefer_above=True,
                    )
                )

        show_for.assert_called_once_with(
            QPoint(50, 60),
            True,
            True,
            selection_rect=ScreenRect(10, 20, 110, 40),
            prefer_above=True,
        )

    def test_controller_uses_trigger_rect_when_unity_has_no_selection_rect(self) -> None:
        targets = [SelectionDeliveryTarget("default-main", "默认人格")]
        controller = SystemSelectionController(
            manager=object(),
            delivery_targets_provider=lambda: targets,
            notify=lambda _title, _message, _is_error: None,
            reader=_SelectionReaderWithoutRect(),
            hook=WindowsGlobalSelectionHook(),
            clipboard_reader=_ClipboardReader(),
        )
        controller._settings = SelectionSpeechSettings(enabled=True)
        rect_hint = ScreenRect(200, 300, 420, 320)

        def run_immediately(operation, completed, **_kwargs):
            task = object()
            completed(task, operation())
            return task

        with patch("rabiroute_tray.system_selection.start_qt_task", side_effect=run_immediately):
            with patch.object(controller._toolbar, "show_for") as show_for:
                controller._selection_finished(
                    SelectionTrigger(
                        source="keyboard",
                        prefer_above=False,
                        rect_hint=rect_hint,
                    )
                )

        show_for.assert_called_once_with(
            QPoint(310, 310),
            True,
            True,
            selection_rect=rect_hint,
            prefer_above=False,
        )


if __name__ == "__main__":
    unittest.main()
