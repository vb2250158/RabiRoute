from __future__ import annotations

import ctypes
import re
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PySide6.QtCore import QEvent, QFileSystemWatcher, QMimeData, QObject, QPoint, QTimer, Qt, Signal, Slot
from PySide6.QtGui import QColor, QCursor, QPalette
from PySide6.QtWidgets import (
    QApplication,
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QMenu,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .display_helpers import route_menu_label
from .manager_client import (
    ManagerClient,
    RolePanelSendResult,
    SelectionSpeechSettings,
    SpeechActionResult,
)
from .qt_async import QtAsyncTask, start_qt_task


SELECTION_TEXT_MAX_LENGTH = 10_000


@dataclass(frozen=True)
class ScreenRect:
    left: int
    top: int
    right: int
    bottom: int


@dataclass(frozen=True)
class SelectedText:
    text: str
    rect: ScreenRect | None = None


@dataclass(frozen=True)
class SelectionDeliveryTarget:
    gateway_id: str
    label: str


@dataclass(frozen=True)
class SelectionTrigger:
    source: str
    anchor_x: int | None = None
    anchor_y: int | None = None
    prefer_above: bool | None = None
    rect_hint: ScreenRect | None = None

    def anchor(self) -> QPoint:
        if self.rect_hint is not None:
            return QPoint((self.rect_hint.left + self.rect_hint.right) // 2, (self.rect_hint.top + self.rect_hint.bottom) // 2)
        if self.anchor_x is None or self.anchor_y is None:
            return QCursor.pos()
        return QPoint(self.anchor_x, self.anchor_y)


KEYBOARD_SELECTION_KEYS = frozenset({0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28})
KEYBOARD_BACKWARD_SELECTION_KEYS = frozenset({0x21, 0x24, 0x25, 0x26})
SHIFT_KEYS = frozenset({0x10, 0xA0, 0xA1})
MODIFIER_KEYS = frozenset({0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5})
UNITY_SELECTION_FALLBACK_PROCESSES = frozenset({"unity.exe"})
WINDOWS_LL_KEYBOARD_INJECTED = 0x10
SELECTION_COPY_INPUT_TAG = 0x52414249
SELECTION_COPY_INPUT_GUARD_SECONDS = 1.5
_SELECTION_COPY_INPUT_LOCK = threading.Lock()
_SELECTION_COPY_INPUT_EXPECTED: list[tuple[int, bool]] = []
_SELECTION_COPY_INPUT_EXPIRES_AT = [0.0]


def begin_rabiroute_copy_input(events: tuple[tuple[int, int], ...]) -> None:
    with _SELECTION_COPY_INPUT_LOCK:
        _SELECTION_COPY_INPUT_EXPECTED[:] = [
            (virtual_key, bool(event_flags & 0x0002))
            for virtual_key, event_flags in events
        ]
        _SELECTION_COPY_INPUT_EXPIRES_AT[0] = time.monotonic() + SELECTION_COPY_INPUT_GUARD_SECONDS


def end_rabiroute_copy_input() -> None:
    with _SELECTION_COPY_INPUT_LOCK:
        _SELECTION_COPY_INPUT_EXPECTED.clear()
        _SELECTION_COPY_INPUT_EXPIRES_AT[0] = 0.0


def is_rabiroute_copy_input(
    flags: int,
    extra_info: int,
    virtual_key: int | None = None,
    is_key_up: bool | None = None,
) -> bool:
    if not flags & WINDOWS_LL_KEYBOARD_INJECTED:
        return False
    if extra_info == SELECTION_COPY_INPUT_TAG:
        if virtual_key is not None and is_key_up is not None:
            _consume_expected_copy_input(virtual_key, is_key_up)
        return True
    if virtual_key is None or is_key_up is None:
        return False
    return _consume_expected_copy_input(virtual_key, is_key_up)


def _consume_expected_copy_input(virtual_key: int, is_key_up: bool) -> bool:
    with _SELECTION_COPY_INPUT_LOCK:
        if time.monotonic() >= _SELECTION_COPY_INPUT_EXPIRES_AT[0]:
            _SELECTION_COPY_INPUT_EXPECTED.clear()
            _SELECTION_COPY_INPUT_EXPIRES_AT[0] = 0.0
            return False
        if not _SELECTION_COPY_INPUT_EXPECTED:
            return False
        if _SELECTION_COPY_INPUT_EXPECTED[0] != (virtual_key, is_key_up):
            return False
        _SELECTION_COPY_INPUT_EXPECTED.pop(0)
        if not _SELECTION_COPY_INPUT_EXPECTED:
            _SELECTION_COPY_INPUT_EXPIRES_AT[0] = 0.0
        return True


class KeyboardSelectionTracker:
    def __init__(self) -> None:
        self._shift_keys: set[int] = set()
        self._selection_changed = False
        self._last_navigation_key = 0

    @property
    def shift_active(self) -> bool:
        return bool(self._shift_keys)

    def reset(self) -> None:
        self._shift_keys.clear()
        self._selection_changed = False
        self._last_navigation_key = 0

    def handle(self, vk_code: int, is_key_down: bool) -> bool | None:
        if vk_code in SHIFT_KEYS:
            if is_key_down:
                self._shift_keys.add(vk_code)
                return None
            self._shift_keys.discard(vk_code)
            if self._shift_keys or not self._selection_changed:
                return None
            prefer_above = self._last_navigation_key in KEYBOARD_BACKWARD_SELECTION_KEYS
            self._selection_changed = False
            self._last_navigation_key = 0
            return prefer_above

        if not is_key_down:
            return None
        if self._shift_keys and vk_code in KEYBOARD_SELECTION_KEYS:
            self._selection_changed = True
            self._last_navigation_key = vk_code
        elif self._selection_changed and vk_code not in MODIFIER_KEYS:
            self._selection_changed = False
            self._last_navigation_key = 0
        return None


@dataclass(frozen=True)
class SelectionActionPalette:
    surface: str
    border: str
    text: str
    primary: str
    primary_hover: str
    primary_pressed: str
    primary_disabled: str
    on_primary: str
    secondary: str
    secondary_hover: str
    secondary_pressed: str
    secondary_disabled: str
    muted_text: str
    selected: str
    focus_ring: str
    shadow: tuple[int, int, int, int]


SELECTION_ACTION_LIGHT = SelectionActionPalette(
    surface="#F8FCFB",
    border="#C8D8D4",
    text="#17312E",
    primary="#0F766E",
    primary_hover="#115E59",
    primary_pressed="#134E4A",
    primary_disabled="#B8D8D3",
    on_primary="#FFFFFF",
    secondary="#EDF5F3",
    secondary_hover="#DCEDE9",
    secondary_pressed="#CCE3DE",
    secondary_disabled="#F3F6F5",
    muted_text="#71827E",
    selected="#D9F2ED",
    focus_ring="#5EEAD4",
    shadow=(15, 23, 42, 76),
)

SELECTION_ACTION_DARK = SelectionActionPalette(
    surface="#18221F",
    border="#34443F",
    text="#F3FAF8",
    primary="#2DD4BF",
    primary_hover="#5EEAD4",
    primary_pressed="#14B8A6",
    primary_disabled="#2A4D47",
    on_primary="#073B35",
    secondary="#26332F",
    secondary_hover="#31443E",
    secondary_pressed="#3A4E47",
    secondary_disabled="#202925",
    muted_text="#8DA099",
    selected="#284B44",
    focus_ring="#99F6E4",
    shadow=(0, 0, 0, 142),
)


def selection_action_palette(dark: bool) -> SelectionActionPalette:
    return SELECTION_ACTION_DARK if dark else SELECTION_ACTION_LIGHT


def selection_action_stylesheet(palette: SelectionActionPalette) -> str:
    return f"""
        #selectionActionFrame {{
            background: {palette.surface};
            border: 1px solid {palette.border};
            border-radius: 10px;
        }}
        QPushButton {{
            min-height: 32px;
            min-width: 56px;
            padding: 0 11px;
            border: 1px solid transparent;
            border-radius: 7px;
            font-size: 12px;
            font-weight: 600;
        }}
        #selectionReadButton {{
            color: {palette.on_primary};
            background: {palette.primary};
        }}
        #selectionReadButton:hover {{ background: {palette.primary_hover}; }}
        #selectionReadButton:pressed {{ background: {palette.primary_pressed}; }}
        #selectionReadButton:focus {{ border: 1px solid {palette.focus_ring}; }}
        #selectionReadButton:disabled {{
            color: {palette.muted_text};
            background: {palette.primary_disabled};
        }}
        #selectionDeliverButton {{
            color: {palette.text};
            background: {palette.secondary};
        }}
        #selectionDeliverButton:hover {{ background: {palette.secondary_hover}; }}
        #selectionDeliverButton:pressed {{ background: {palette.secondary_pressed}; }}
        #selectionDeliverButton:focus {{ border: 1px solid {palette.focus_ring}; }}
        #selectionDeliverButton:disabled {{
            color: {palette.muted_text};
            background: {palette.secondary_disabled};
        }}
    """


def selection_delivery_menu_stylesheet(palette: SelectionActionPalette) -> str:
    return f"""
        QMenu {{
            background: {palette.surface};
            color: {palette.text};
            border: 1px solid {palette.border};
            border-radius: 10px;
            padding: 5px;
        }}
        QMenu::item {{
            min-height: 28px;
            padding: 4px 12px;
            margin: 1px 0;
            border-radius: 6px;
        }}
        QMenu::item:selected {{
            background: {palette.selected};
            color: {palette.text};
        }}
        QMenu::item:disabled {{ color: {palette.muted_text}; }}
    """


def active_selection_delivery_targets(
    gateways: list[dict[str, Any]],
    preferred_gateway_id: str = "",
) -> list[SelectionDeliveryTarget]:
    targets = [
        SelectionDeliveryTarget(
            gateway_id=str(gateway.get("id") or "").strip(),
            label=route_menu_label(gateway),
        )
        for gateway in gateways
        if isinstance(gateway, dict)
        and gateway.get("enabled") is True
        and gateway.get("running") is True
        and str(gateway.get("id") or "").strip()
    ]
    targets.sort(key=lambda target: 0 if target.gateway_id == preferred_gateway_id else 1)
    return targets


def normalize_selected_text(value: str, max_length: int = SELECTION_TEXT_MAX_LENGTH) -> str:
    return re.sub(r"\s+", " ", value).strip()[:max_length]


def resolve_selection_speech_model(settings: SelectionSpeechSettings, models: list[dict[str, Any]]) -> str:
    available = [
        row for row in models
        if row.get("capability") == "tts" and row.get("available") is True and str(row.get("id") or "").strip()
    ]
    if settings.advanced and settings.model:
        for row in available:
            if str(row.get("id") or "").strip() == settings.model:
                return settings.model
    for row in available:
        if row.get("isDefault") is True:
            return str(row.get("id") or "").strip()
    return str(available[0].get("id") or "").strip() if available else ""

def selection_rect_from_drag(
    start_x: int,
    start_y: int,
    end_x: int,
    end_y: int,
) -> ScreenRect:
    left = min(start_x, end_x)
    right = max(start_x, end_x)
    top = min(start_y, end_y)
    bottom = max(start_y, end_y)
    if right <= left:
        left -= 1
        right += 1
    if abs(end_y - start_y) <= 4:
        center_y = (start_y + end_y) // 2
        top = center_y - 10
        bottom = center_y + 10
    else:
        top -= 4
        bottom += 4
    return ScreenRect(left=left, top=top, right=right, bottom=bottom)


def caret_screen_rect(
    left: int,
    top: int,
    right: int,
    bottom: int,
) -> ScreenRect | None:
    if bottom <= top:
        return None
    return ScreenRect(
        left=left,
        top=top,
        right=max(right, left + 2),
        bottom=bottom,
    )


def point_anchor_rect(x: int, y: int) -> ScreenRect:
    return ScreenRect(left=x - 1, top=y - 10, right=x + 1, bottom=y + 10)





def selection_trigger_from_drag(
    start_x: int,
    start_y: int,
    end_x: int,
    end_y: int,
) -> SelectionTrigger:
    delta_y = end_y - start_y
    prefer_above = delta_y < -4
    return SelectionTrigger(
        source="mouse",
        anchor_x=end_x,
        anchor_y=end_y,
        prefer_above=prefer_above,
        rect_hint=selection_rect_from_drag(start_x, start_y, end_x, end_y),
    )


def union_screen_rect(current: ScreenRect | None, candidate: ScreenRect) -> ScreenRect:
    if current is None:
        return candidate
    return ScreenRect(
        left=min(current.left, candidate.left),
        top=min(current.top, candidate.top),
        right=max(current.right, candidate.right),
        bottom=max(current.bottom, candidate.bottom),
    )


def selection_rect_from_keyboard(
    start: ScreenRect | None,
    current: ScreenRect | None,
    fallback: ScreenRect | None,
) -> ScreenRect | None:
    result = start
    if current is not None:
        result = union_screen_rect(result, current)
    return result or fallback


def windows_foreground_process_name() -> str:
    if sys.platform != "win32":
        return ""
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    process_id = wintypes.DWORD()
    window = user32.GetForegroundWindow()
    if not window:
        return ""
    user32.GetWindowThreadProcessId(window, ctypes.byref(process_id))
    if not process_id.value:
        return ""
    process = kernel32.OpenProcess(0x1000, False, process_id.value)
    if not process:
        return ""
    try:
        size = wintypes.DWORD(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(process, 0, buffer, ctypes.byref(size)):
            return ""
        return Path(buffer.value).name.casefold()
    finally:
        kernel32.CloseHandle(process)


def windows_caret_rect() -> ScreenRect | None:
    if sys.platform != "win32":
        return None
    from ctypes import wintypes

    class GuiThreadInfo(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("flags", wintypes.DWORD),
            ("hwndActive", wintypes.HWND),
            ("hwndFocus", wintypes.HWND),
            ("hwndCapture", wintypes.HWND),
            ("hwndMenuOwner", wintypes.HWND),
            ("hwndMoveSize", wintypes.HWND),
            ("hwndCaret", wintypes.HWND),
            ("rcCaret", wintypes.RECT),
        ]

    user32 = ctypes.windll.user32
    foreground = user32.GetForegroundWindow()
    thread_id = user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
    info = GuiThreadInfo()
    info.cbSize = ctypes.sizeof(GuiThreadInfo)
    if thread_id and user32.GetGUIThreadInfo(thread_id, ctypes.byref(info)):
        if info.hwndCaret:
            points = (wintypes.POINT * 2)(
                wintypes.POINT(info.rcCaret.left, info.rcCaret.top),
                wintypes.POINT(info.rcCaret.right, info.rcCaret.bottom),
            )
            user32.MapWindowPoints(info.hwndCaret, None, points, 2)
            return caret_screen_rect(
                int(points[0].x),
                int(points[0].y),
                int(points[1].x),
                int(points[1].y),
            )
    return None


def calculate_overlay_position(
    anchor_x: int,
    anchor_y: int,
    width: int,
    height: int,
    available_left: int,
    available_top: int,
    available_right: int,
    available_bottom: int,
    selection_rect: ScreenRect | None = None,
    prefer_above: bool | None = None,
) -> tuple[int, int]:
    padding = 8
    gap = 8
    if selection_rect is not None:
        x = (selection_rect.left + selection_rect.right - width) // 2
    else:
        x = anchor_x - width // 2
    x = max(available_left + padding, min(x, available_right - width - padding))

    reference_top = selection_rect.top if selection_rect is not None else anchor_y - 4
    reference_bottom = selection_rect.bottom if selection_rect is not None else anchor_y + 4
    above = reference_top - height - gap
    below = reference_bottom + gap
    candidates = (above, below) if prefer_above else (below, above)
    y = next(
        (
            candidate
            for candidate in candidates
            if candidate >= available_top + padding
            and candidate + height <= available_bottom - padding
        ),
        None,
    )
    if y is None:
        space_above = reference_top - available_top
        space_below = available_bottom - reference_bottom
        y = above if space_above >= space_below else below
    y = max(available_top + padding, min(y, available_bottom - height - padding))
    return x, y


class WindowsSelectionReader:
    def __init__(self, automation_module: Any | None = None) -> None:
        self._automation_module = automation_module

    def _automation(self):
        if self._automation_module is not None:
            return self._automation_module
        import uiautomation as automation
        return automation

    def read(self) -> SelectedText | None:
        if sys.platform != "win32" and self._automation_module is None:
            return None
        automation = self._automation()
        initializer = getattr(automation, "UIAutomationInitializerInThread", None)
        context = initializer() if callable(initializer) else _NullContext()
        with context:
            control = automation.GetFocusedControl()
            for _ in range(8):
                if control is None:
                    return None
                try:
                    if bool(control.IsPassword):
                        return None
                except Exception:
                    return None
                try:
                    pattern = control.GetPattern(automation.PatternId.TextPattern)
                except Exception:
                    pattern = None
                if pattern is not None:
                    selected = self._read_pattern(pattern)
                    if selected is not None:
                        return selected
                try:
                    control = control.GetParentControl()
                except Exception:
                    return None
        return None

    @staticmethod
    def _read_pattern(pattern: Any) -> SelectedText | None:
        try:
            ranges = pattern.GetSelection()
        except Exception:
            return None
        if not ranges:
            return None
        texts: list[str] = []
        selection_rect: ScreenRect | None = None
        remaining = SELECTION_TEXT_MAX_LENGTH + 1
        for text_range in ranges:
            if remaining <= 0:
                break
            try:
                text = str(text_range.GetText(remaining))
            except Exception:
                continue
            texts.append(text)
            remaining -= len(text)
            try:
                rects = text_range.GetBoundingRectangles()
            except Exception:
                rects = []
            for rect in rects or []:
                candidate = ScreenRect(
                    left=int(rect.left),
                    top=int(rect.top),
                    right=int(rect.right),
                    bottom=int(rect.bottom),
                )
                if candidate.right > candidate.left and candidate.bottom > candidate.top:
                    selection_rect = union_screen_rect(selection_rect, candidate)
        text = normalize_selected_text(" ".join(texts))
        return SelectedText(text=text, rect=selection_rect) if text else None


class _NullContext:
    def __enter__(self):
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        return None


def clone_clipboard_mime_data(source: QMimeData | None) -> QMimeData:
    clone = QMimeData()
    if source is None:
        return clone
    for mime_type in source.formats():
        clone.setData(mime_type, source.data(mime_type))
    if source.hasText():
        clone.setText(source.text())
    if source.hasHtml():
        clone.setHtml(source.html())
    if source.hasUrls():
        clone.setUrls(source.urls())
    if source.hasImage():
        clone.setImageData(source.imageData())
    if source.hasColor():
        clone.setColorData(source.colorData())
    return clone


def is_clipboard_selection_fallback_process(process_name: str) -> bool:
    return process_name.casefold() in UNITY_SELECTION_FALLBACK_PROCESSES


class WindowsClipboardSelectionReader(QObject):
    def __init__(
        self,
        parent: QObject | None = None,
        process_name_provider: Callable[[], str] = windows_foreground_process_name,
        copy_sender: Callable[[], bool] | None = None,
        clipboard_provider: Callable[[], Any] | None = None,
        sequence_provider: Callable[[], int] | None = None,
        timeout_ms: int = 900,
    ) -> None:
        super().__init__(parent)
        self._process_name_provider = process_name_provider
        self._copy_sender = copy_sender or self._send_copy_shortcut
        self._clipboard_provider = clipboard_provider or QApplication.clipboard
        self._sequence_provider = sequence_provider or self._clipboard_sequence_number
        self._timeout_ms = max(120, timeout_ms)
        self._callback: Callable[[SelectedText | None], None] | None = None
        self._original_mime: QMimeData | None = None
        self._original_sequence = 0
        self._clipboard_changed = False
        self._watched_clipboard: Any | None = None
        self._capture_generation = 0

    def can_capture_foreground(self) -> bool:
        return sys.platform == "win32" and is_clipboard_selection_fallback_process(
            self._process_name_provider()
        )

    def capture(self, callback: Callable[[SelectedText | None], None]) -> None:
        self.cancel()
        if not self.can_capture_foreground():
            callback(None)
            return
        clipboard = self._clipboard_provider()
        self._original_mime = clone_clipboard_mime_data(clipboard.mimeData())
        self._original_sequence = self._sequence_provider()
        self._clipboard_changed = False
        self._callback = callback
        self._capture_generation += 1
        generation = self._capture_generation
        self._watch_clipboard_changes(clipboard)
        if not self._copy_sender():
            self._finish(None, notify=True)
            return
        QTimer.singleShot(self._timeout_ms, lambda: self._finish_on_timeout(generation))

    def cancel(self) -> None:
        if self._callback is None and self._original_mime is None:
            return
        if self._sequence_provider() != self._original_sequence:
            self._clipboard_changed = True
        self._finish(None, notify=False)

    def _watch_clipboard_changes(self, clipboard: Any) -> None:
        signal = getattr(clipboard, "dataChanged", None)
        if signal is None or not hasattr(signal, "connect"):
            return
        signal.connect(self._poll)
        self._watched_clipboard = clipboard

    def _stop_watching_clipboard(self) -> None:
        clipboard = self._watched_clipboard
        self._watched_clipboard = None
        signal = getattr(clipboard, "dataChanged", None) if clipboard is not None else None
        if signal is None or not hasattr(signal, "disconnect"):
            return
        try:
            signal.disconnect(self._poll)
        except (RuntimeError, TypeError):
            return

    @Slot()
    def _poll(self) -> None:
        if self._callback is None:
            return
        clipboard = self._clipboard_provider()
        if self._sequence_provider() == self._original_sequence:
            return
        self._clipboard_changed = True
        text = normalize_selected_text(clipboard.text())
        if text:
            self._finish(SelectedText(text=text), notify=True)

    def _finish_on_timeout(self, generation: int) -> None:
        if generation != self._capture_generation or self._callback is None:
            return
        self._poll()
        if self._callback is not None:
            self._finish(None, notify=True)

    def _finish(self, selected: SelectedText | None, notify: bool) -> None:
        callback = self._callback
        original_mime = self._original_mime
        clipboard_changed = self._clipboard_changed
        self._callback = None
        self._original_mime = None
        self._clipboard_changed = False
        self._stop_watching_clipboard()
        if clipboard_changed and original_mime is not None:
            self._clipboard_provider().setMimeData(original_mime)
        if notify and callback is not None:
            callback(selected)

    @staticmethod
    def _clipboard_sequence_number() -> int:
        if sys.platform != "win32":
            return 0
        return int(ctypes.windll.user32.GetClipboardSequenceNumber())

    @staticmethod
    def _send_copy_shortcut() -> bool:
        if sys.platform != "win32":
            return False
        from ctypes import wintypes

        class KeyboardInput(ctypes.Structure):
            _fields_ = [
                ("wVk", wintypes.WORD),
                ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_size_t),
            ]

        class InputUnion(ctypes.Union):
            _fields_ = [("keyboard", KeyboardInput)]

        class Input(ctypes.Structure):
            _anonymous_ = ("data",)
            _fields_ = [("type", wintypes.DWORD), ("data", InputUnion)]

        events = ((0x11, 0), (0x43, 0), (0x43, 0x0002), (0x11, 0x0002))
        inputs = (Input * len(events))()
        for index, (virtual_key, flags) in enumerate(events):
            inputs[index].type = 1
            inputs[index].keyboard.wVk = virtual_key
            inputs[index].keyboard.dwFlags = flags
            inputs[index].keyboard.dwExtraInfo = SELECTION_COPY_INPUT_TAG
        begin_rabiroute_copy_input(events)
        try:
            sent = ctypes.windll.user32.SendInput(len(inputs), inputs, ctypes.sizeof(Input))
        except Exception:
            end_rabiroute_copy_input()
            raise
        succeeded = int(sent) == len(inputs)
        if not succeeded:
            end_rabiroute_copy_input()
        return succeeded


class SelectionActionBar(QWidget):
    read_requested = Signal()
    deliver_requested = Signal(str)

    def __init__(self, delivery_targets_provider: Callable[[], list[SelectionDeliveryTarget]]) -> None:
        flags = Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus
        super().__init__(None, flags)
        self.setAttribute(Qt.WA_ShowWithoutActivating, True)
        self.setAttribute(Qt.WA_TranslucentBackground, True)

        frame = QFrame(self)
        frame.setObjectName("selectionActionFrame")
        frame.setAttribute(Qt.WA_StyledBackground, True)
        layout = QHBoxLayout(frame)
        layout.setContentsMargins(3, 3, 3, 3)
        layout.setSpacing(3)

        self.read_button = QPushButton("朗读")
        self.read_button.setObjectName("selectionReadButton")
        self.read_button.setAccessibleName("朗读选中的文字")
        self.read_button.setToolTip("朗读选中的文字")
        self.read_button.setCursor(Qt.PointingHandCursor)
        self.deliver_button = QPushButton("投递至 ▾")
        self.deliver_button.setObjectName("selectionDeliverButton")
        self.deliver_button.setAccessibleName("投递选中文字至人格")
        self.deliver_button.setToolTip("移动到这里查看所有激活人格")
        self.deliver_button.setCursor(Qt.PointingHandCursor)
        layout.addWidget(self.read_button)
        layout.addWidget(self.deliver_button)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(6, 6, 6, 6)
        outer.addWidget(frame)
        self._frame = frame
        self._shadow = QGraphicsDropShadowEffect(self)
        self._shadow.setBlurRadius(14)
        self._shadow.setOffset(0, 3)
        frame.setGraphicsEffect(self._shadow)
        self._dark_theme: bool | None = None
        self.read_button.clicked.connect(self.read_requested.emit)
        self.deliver_button.clicked.connect(self._show_delivery_menu)
        self.deliver_button.installEventFilter(self)
        self._delivery_targets_provider = delivery_targets_provider
        self._delivery_targets: dict[str, SelectionDeliveryTarget] = {}
        self._delivery_menu = QMenu(self)
        self._delivery_menu.setObjectName("selectionDeliveryMenu")
        self._apply_theme()
        self._hide_timer = QTimer(self)
        self._hide_timer.setSingleShot(True)
        self._hide_timer.timeout.connect(self.hide)

    def set_read_visible(self, can_read: bool) -> None:
        self.read_button.setVisible(can_read)
        self.read_button.setEnabled(can_read)
        if self.isVisible():
            self.adjustSize()

    def show_for(
        self,
        anchor: QPoint,
        can_deliver: bool,
        can_read: bool = True,
        selection_rect: ScreenRect | None = None,
        prefer_above: bool | None = None,
    ) -> None:
        self._apply_theme()
        self.set_read_visible(can_read)
        self.deliver_button.setEnabled(can_deliver)
        self.deliver_button.setToolTip(
            "移动到这里查看所有激活人格" if can_deliver else "暂无激活人格"
        )
        self.adjustSize()
        screen = QApplication.screenAt(anchor) or QApplication.primaryScreen()
        if screen is None:
            return
        available = screen.availableGeometry()
        x, y = calculate_overlay_position(
            anchor.x(),
            anchor.y(),
            self.width(),
            self.height(),
            available.left(),
            available.top(),
            available.right() + 1,
            available.bottom() + 1,
            selection_rect=selection_rect,
            prefer_above=prefer_above,
        )
        self.move(x, y)
        self.show()
        self.raise_()
        self._hide_timer.start(10_000)

    def _apply_theme(self) -> None:
        app = QApplication.instance()
        dark = bool(
            app is not None
            and app.palette().color(QPalette.ColorRole.Window).lightness() < 128
        )
        if self._dark_theme == dark:
            return
        self._dark_theme = dark
        palette = selection_action_palette(dark)
        self.setStyleSheet(selection_action_stylesheet(palette))
        self._delivery_menu.setStyleSheet(selection_delivery_menu_stylesheet(palette))
        self._shadow.setColor(QColor(*palette.shadow))

    def contains_cursor(self) -> bool:
        if not self.isVisible():
            return False
        cursor = QCursor.pos()
        return self.geometry().contains(cursor) or (
            self._delivery_menu.isVisible() and self._delivery_menu.frameGeometry().contains(cursor)
        )

    def delivery_target_label(self, gateway_id: str) -> str:
        target = self._delivery_targets.get(gateway_id)
        return target.label if target is not None else ""

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        if watched is self.deliver_button and event.type() == QEvent.Type.Enter:
            self._show_delivery_menu()
        return super().eventFilter(watched, event)

    @Slot()
    def _show_delivery_menu(self) -> None:
        if not self.isVisible() or not self.deliver_button.isEnabled():
            return
        targets = self._delivery_targets_provider()
        self._delivery_targets = {target.gateway_id: target for target in targets}
        self._delivery_menu.clear()
        if not targets:
            empty_action = self._delivery_menu.addAction("暂无激活人格")
            empty_action.setEnabled(False)
        else:
            for target in targets:
                action = self._delivery_menu.addAction(target.label)
                action.triggered.connect(
                    lambda _checked=False, gateway_id=target.gateway_id: self.deliver_requested.emit(gateway_id)
                )
        self._delivery_menu.adjustSize()
        screen = QApplication.screenAt(self.deliver_button.mapToGlobal(QPoint(0, 0))) or QApplication.primaryScreen()
        if screen is None:
            return
        available = screen.availableGeometry()
        button_origin = self.deliver_button.mapToGlobal(QPoint(0, self.deliver_button.height()))
        x = max(available.left() + 8, min(button_origin.x(), available.right() - self._delivery_menu.width() - 8))
        y = max(available.top() + 8, min(button_origin.y(), available.bottom() - self._delivery_menu.height() - 8))
        self._delivery_menu.popup(QPoint(x, y))

    def hide(self) -> None:
        self._hide_timer.stop()
        self._delivery_menu.hide()
        self._delivery_targets = {}
        super().hide()


class WindowsGlobalSelectionHook(QObject):
    pointer_pressed = Signal()
    selection_finished = Signal(object)
    dismiss_requested = Signal()

    def __init__(self) -> None:
        super().__init__()
        self._thread: threading.Thread | None = None
        self._thread_id = 0
        self._stop_requested = threading.Event()

    def start(self) -> None:
        if sys.platform != "win32" or self._thread is not None:
            return
        self._stop_requested.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="RabiRouteSelectionInputHook",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        thread = self._thread
        if thread is None:
            return
        self._stop_requested.set()
        if self._thread_id:
            ctypes.windll.user32.PostThreadMessageW(self._thread_id, 0x0012, 0, 0)
        thread.join(timeout=1.5)
        self._thread = None
        self._thread_id = 0

    def _run(self) -> None:
        from ctypes import wintypes

        wh_keyboard_ll = 13
        wh_mouse_ll = 14
        wm_keydown = 0x0100
        wm_keyup = 0x0101
        wm_syskeydown = 0x0104
        wm_syskeyup = 0x0105
        wm_mousemove = 0x0200
        wm_lbuttondown = 0x0201
        wm_lbuttonup = 0x0202
        dismiss_messages = {0x0204, 0x0207, 0x020A, 0x020E}

        class MouseHookStruct(ctypes.Structure):
            _fields_ = [
                ("pt", wintypes.POINT),
                ("mouseData", wintypes.DWORD),
                ("flags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_size_t),
            ]

        class KeyboardHookStruct(ctypes.Structure):
            _fields_ = [
                ("vkCode", wintypes.DWORD),
                ("scanCode", wintypes.DWORD),
                ("flags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_size_t),
            ]

        result_type = ctypes.c_ssize_t
        callback_type = ctypes.WINFUNCTYPE(result_type, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        user32.SetWindowsHookExW.argtypes = [ctypes.c_int, callback_type, wintypes.HINSTANCE, wintypes.DWORD]
        user32.SetWindowsHookExW.restype = wintypes.HHOOK
        user32.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
        user32.CallNextHookEx.restype = result_type
        user32.GetForegroundWindow.restype = wintypes.HWND
        user32.WindowFromPoint.argtypes = [wintypes.POINT]
        user32.WindowFromPoint.restype = wintypes.HWND
        user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        user32.GetAncestor.restype = wintypes.HWND
        kernel32.GetModuleHandleW.restype = wintypes.HMODULE
        self._thread_id = int(kernel32.GetCurrentThreadId())
        drag_start: tuple[int, int] | None = None
        dragged = False
        keyboard_tracker = KeyboardSelectionTracker()
        last_pointer_window = 0
        last_pointer_rect: ScreenRect | None = None
        keyboard_selection_start: ScreenRect | None = None

        def root_window(window: int) -> int:
            if not window:
                return 0
            root = user32.GetAncestor(window, 2)
            return int(root or window)

        @callback_type
        def mouse_callback(code, message, data):
            nonlocal drag_start, dragged, keyboard_selection_start, last_pointer_rect, last_pointer_window
            if code >= 0:
                info = ctypes.cast(data, ctypes.POINTER(MouseHookStruct)).contents
                point = (int(info.pt.x), int(info.pt.y))
                if message == wm_lbuttondown:
                    drag_start = point
                    dragged = False
                    keyboard_tracker.reset()
                    keyboard_selection_start = None
                    last_pointer_window = root_window(user32.WindowFromPoint(info.pt))
                    last_pointer_rect = point_anchor_rect(point[0], point[1])
                    self.pointer_pressed.emit()
                elif message == wm_mousemove and drag_start is not None:
                    dragged = dragged or (point[0] - drag_start[0]) ** 2 + (point[1] - drag_start[1]) ** 2 >= 16
                elif message == wm_lbuttonup:
                    start = drag_start
                    shift_click = bool(user32.GetAsyncKeyState(0x10) & 0x8000)
                    should_inspect = start is not None and (dragged or shift_click)
                    drag_start = None
                    dragged = False
                    if should_inspect and start is not None:
                        self.selection_finished.emit(
                            selection_trigger_from_drag(start[0], start[1], point[0], point[1])
                        )
                elif message in dismiss_messages:
                    self.dismiss_requested.emit()
            return user32.CallNextHookEx(None, code, message, data)

        @callback_type
        def keyboard_callback(code, message, data):
            nonlocal keyboard_selection_start
            if code >= 0:
                info = ctypes.cast(data, ctypes.POINTER(KeyboardHookStruct)).contents
                virtual_key = int(info.vkCode)
                is_key_down = message in {wm_keydown, wm_syskeydown}
                is_key_up = message in {wm_keyup, wm_syskeyup}
                if is_rabiroute_copy_input(
                    int(info.flags),
                    int(info.dwExtraInfo),
                    virtual_key,
                    is_key_up,
                ):
                    return user32.CallNextHookEx(None, code, message, data)
                if is_key_down or is_key_up:
                    if is_key_down and virtual_key in SHIFT_KEYS and not keyboard_tracker.shift_active:
                        keyboard_selection_start = windows_caret_rect()
                    is_selection_key = (
                        is_key_down
                        and keyboard_tracker.shift_active
                        and virtual_key in KEYBOARD_SELECTION_KEYS
                    )
                    if is_selection_key and keyboard_selection_start is None:
                        keyboard_selection_start = windows_caret_rect()
                    prefer_above = keyboard_tracker.handle(virtual_key, is_key_down)
                    if prefer_above is not None:
                        current_caret = windows_caret_rect()
                        foreground_window = root_window(user32.GetForegroundWindow())
                        fallback_rect = (
                            last_pointer_rect
                            if last_pointer_window and foreground_window == last_pointer_window
                            else None
                        )
                        rect_hint = selection_rect_from_keyboard(
                            keyboard_selection_start,
                            current_caret,
                            fallback_rect,
                        )
                        keyboard_selection_start = None
                        self.selection_finished.emit(
                            SelectionTrigger(
                                source="keyboard",
                                prefer_above=prefer_above,
                                rect_hint=rect_hint,
                            )
                        )
                    elif is_key_down and virtual_key == 0x1B:
                        keyboard_selection_start = None
                        keyboard_tracker.reset()
                        self.dismiss_requested.emit()
                    elif is_key_down and not is_selection_key and virtual_key not in MODIFIER_KEYS:
                        keyboard_selection_start = None
                        self.dismiss_requested.emit()
            return user32.CallNextHookEx(None, code, message, data)

        module = kernel32.GetModuleHandleW(None)
        mouse_hook = user32.SetWindowsHookExW(wh_mouse_ll, mouse_callback, module, 0)
        keyboard_hook = user32.SetWindowsHookExW(wh_keyboard_ll, keyboard_callback, module, 0)
        if not mouse_hook and not keyboard_hook:
            self._thread_id = 0
            return
        try:
            message = wintypes.MSG()
            while not self._stop_requested.is_set() and user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
                user32.TranslateMessage(ctypes.byref(message))
                user32.DispatchMessageW(ctypes.byref(message))
        finally:
            if mouse_hook:
                user32.UnhookWindowsHookEx(mouse_hook)
            if keyboard_hook:
                user32.UnhookWindowsHookEx(keyboard_hook)


class SystemSelectionController(QObject):
    def __init__(
        self,
        manager: ManagerClient,
        delivery_targets_provider: Callable[[], list[SelectionDeliveryTarget]],
        notify: Callable[[str, str, bool], None],
        settings_path: Path | None = None,
        reader: WindowsSelectionReader | None = None,
        hook: WindowsGlobalSelectionHook | None = None,
        clipboard_reader: WindowsClipboardSelectionReader | None = None,
    ) -> None:
        super().__init__()
        self._manager = manager
        self._notify = notify
        self._delivery_targets_provider = delivery_targets_provider
        self._settings_path = settings_path
        self._reader = reader or WindowsSelectionReader()
        self._hook = hook or WindowsGlobalSelectionHook()
        self._clipboard_reader = clipboard_reader or WindowsClipboardSelectionReader(self)
        self._toolbar = SelectionActionBar(delivery_targets_provider)
        self._settings = SelectionSpeechSettings()
        self._selected: SelectedText | None = None
        self._selection_generation = 0
        self._settings_task: QtAsyncTask | None = None
        self._selection_task: QtAsyncTask | None = None
        self._action_task: QtAsyncTask | None = None
        self._selection_error_notified = False
        self._settings_refresh_scheduled = False
        self._running = False

        self._settings_watcher = QFileSystemWatcher(self)
        self._settings_watcher.fileChanged.connect(self._settings_changed)
        self._settings_watcher.directoryChanged.connect(self._settings_changed)
        self._hook.pointer_pressed.connect(self._pointer_pressed)
        self._hook.selection_finished.connect(self._selection_finished)
        self._hook.dismiss_requested.connect(self.dismiss)
        self._toolbar.read_requested.connect(self._read_selected)
        self._toolbar.deliver_requested.connect(self._deliver_selected)

    @property
    def running(self) -> bool:
        return self._running

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._hook.start()
        self._arm_settings_watcher()
        self.refresh_settings()

    def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        self._hook.stop()
        current_paths = self._settings_watcher.files() + self._settings_watcher.directories()
        if current_paths:
            self._settings_watcher.removePaths(current_paths)
        self._settings_refresh_scheduled = False
        self.dismiss()

    def _arm_settings_watcher(self) -> None:
        current_paths = self._settings_watcher.files() + self._settings_watcher.directories()
        if current_paths:
            self._settings_watcher.removePaths(current_paths)
        if self._settings_path is None:
            return
        watch_paths: list[str] = []
        if self._settings_path.exists():
            watch_paths.append(str(self._settings_path))
        directory = self._settings_path.parent
        while not directory.exists() and directory != directory.parent:
            directory = directory.parent
        if directory.exists():
            watch_paths.append(str(directory))
        if watch_paths:
            self._settings_watcher.addPaths(list(dict.fromkeys(watch_paths)))

    @Slot(str)
    def _settings_changed(self, _path: str) -> None:
        if not self._running:
            return
        self._arm_settings_watcher()
        if self._settings_refresh_scheduled:
            return
        self._settings_refresh_scheduled = True
        QTimer.singleShot(50, self._refresh_settings_after_change)

    @Slot()
    def _refresh_settings_after_change(self) -> None:
        self._settings_refresh_scheduled = False
        if not self._running:
            return
        self._arm_settings_watcher()
        self.refresh_settings()

    @Slot()
    def refresh_settings(self) -> None:
        if not self._running or self._settings_task is not None:
            return

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._settings_task is task:
                self._settings_task = None
            if not self._running:
                return
            if isinstance(result, SelectionSpeechSettings):
                self._settings = result
                if not result.enabled:
                    self.dismiss()
                elif self._toolbar.isVisible():
                    self._toolbar.set_read_visible(result.read_aloud_enabled)

        self._settings_task = start_qt_task(
            self._manager.selection_speech_settings,
            completed,
            on_error=lambda error: error,
        )

    @Slot()
    def _pointer_pressed(self) -> None:
        if self._toolbar.contains_cursor():
            return
        self.dismiss()

    @Slot(object)
    def _selection_finished(self, trigger: object = None) -> None:
        if not self._settings.enabled or self._toolbar.contains_cursor():
            return
        cursor = QCursor.pos()
        selection_trigger = trigger if isinstance(trigger, SelectionTrigger) else SelectionTrigger(
            source="mouse",
            anchor_x=cursor.x(),
            anchor_y=cursor.y(),
        )
        clipboard_fallback_allowed = self._clipboard_reader.can_capture_foreground()
        self.dismiss()
        self._selection_generation += 1
        generation = self._selection_generation

        def present(result: object) -> None:
            if generation != self._selection_generation or not self._settings.enabled:
                return
            if not isinstance(result, SelectedText):
                return
            self._selection_error_notified = False
            self._selected = result
            effective_rect = result.rect or selection_trigger.rect_hint
            self._toolbar.show_for(
                selection_trigger.anchor(),
                bool(self._delivery_targets_provider()),
                self._settings.read_aloud_enabled,
                selection_rect=effective_rect,
                prefer_above=selection_trigger.prefer_above,
            )

        def capture_from_clipboard() -> None:
            if not clipboard_fallback_allowed:
                return
            self._clipboard_reader.capture(present)

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._selection_task is task:
                self._selection_task = None
            if generation != self._selection_generation or not self._settings.enabled:
                return
            if isinstance(result, Exception):
                if clipboard_fallback_allowed:
                    capture_from_clipboard()
                elif not self._selection_error_notified:
                    self._selection_error_notified = True
                    self._notify("系统划词", f"无法读取当前软件的文字选区：{result}", True)
                return
            if isinstance(result, SelectedText):
                present(result)
            else:
                capture_from_clipboard()

        self._selection_task = start_qt_task(
            self._reader.read,
            completed,
            on_error=lambda error: error,
        )

    @Slot()
    def dismiss(self) -> None:
        self._clipboard_reader.cancel()
        self._selection_generation += 1
        self._selected = None
        self._toolbar.hide()

    @Slot()
    def _read_selected(self) -> None:
        selected = self._selected
        settings = self._settings
        self._toolbar.hide()
        if selected is None or not settings.read_aloud_enabled or self._action_task is not None:
            return

        def operation() -> SpeechActionResult:
            model = resolve_selection_speech_model(settings, self._manager.speech_models())
            if not model:
                return SpeechActionResult(ok=False, message="没有可用的 TTS 模型。")
            return self._manager.synthesize_speech(selected.text, model)

        def completed(task: QtAsyncTask, result: SpeechActionResult) -> None:
            if self._action_task is task:
                self._action_task = None
            if result.ok:
                self._notify("系统划词", "已加入主机朗读队列。", False)
            else:
                self._notify("系统划词", f"朗读失败：{result.message or '未知错误'}", True)

        self._action_task = start_qt_task(
            operation,
            completed,
            on_error=lambda error: SpeechActionResult(ok=False, message=str(error)),
        )

    @Slot()
    def _deliver_selected(self, gateway_id: str) -> None:
        selected = self._selected
        label = self._toolbar.delivery_target_label(gateway_id)
        self._toolbar.hide()
        if selected is None or self._action_task is not None:
            return
        if not gateway_id or not label:
            self._notify("系统划词", "激活人格列表已更新，请重新划词后选择。", True)
            return

        def completed(task: QtAsyncTask, result: RolePanelSendResult) -> None:
            if self._action_task is task:
                self._action_task = None
            if result.ok:
                self._notify("系统划词", f"已投递至 {label or '当前人格'}。", False)
            else:
                self._notify("系统划词", f"投递失败：{result.message or '未知错误'}", True)

        self._action_task = start_qt_task(
            lambda: self._manager.send_role_panel_message(gateway_id, selected.text, []),
            completed,
            on_error=lambda error: RolePanelSendResult(ok=False, message=str(error)),
        )
