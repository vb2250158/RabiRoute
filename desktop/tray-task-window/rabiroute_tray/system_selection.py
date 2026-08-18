from __future__ import annotations

import ctypes
import re
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PySide6.QtCore import QFileSystemWatcher, QObject, QPoint, QTimer, Qt, Signal, Slot
from PySide6.QtGui import QCursor
from PySide6.QtWidgets import QApplication, QFrame, QHBoxLayout, QPushButton, QVBoxLayout, QWidget

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


def calculate_overlay_position(
    anchor_x: int,
    anchor_y: int,
    width: int,
    height: int,
    available_left: int,
    available_top: int,
    available_right: int,
    available_bottom: int,
) -> tuple[int, int]:
    padding = 8
    gap = 12
    x = anchor_x - width // 2
    x = max(available_left + padding, min(x, available_right - width - padding))
    below = anchor_y + gap
    y = below if below + height + padding <= available_bottom else anchor_y - height - gap
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
        last_rect: ScreenRect | None = None
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
                    last_rect = candidate
        text = normalize_selected_text(" ".join(texts))
        return SelectedText(text=text, rect=last_rect) if text else None


class _NullContext:
    def __enter__(self):
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        return None


class SelectionActionBar(QWidget):
    read_requested = Signal()
    deliver_requested = Signal()

    def __init__(self) -> None:
        flags = Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus
        super().__init__(None, flags)
        self.setAttribute(Qt.WA_ShowWithoutActivating, True)
        self.setAttribute(Qt.WA_TranslucentBackground, True)

        frame = QFrame(self)
        frame.setObjectName("selectionActionFrame")
        layout = QHBoxLayout(frame)
        layout.setContentsMargins(4, 4, 4, 4)
        layout.setSpacing(0)

        self.read_button = QPushButton("朗读")
        self.read_button.setObjectName("selectionReadButton")
        self.deliver_button = QPushButton("投递至当前人格")
        self.deliver_button.setObjectName("selectionDeliverButton")
        layout.addWidget(self.read_button)
        layout.addWidget(self.deliver_button)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(frame)
        self.setStyleSheet(
            "#selectionActionFrame { background: white; border: 1px solid #cbd5e1; border-radius: 18px; }"
            "QPushButton { min-height: 30px; padding: 0 14px; border: 0; color: #0f172a; background: transparent; font-weight: 600; }"
            "#selectionReadButton { color: white; background: #0f766e; border-radius: 14px 0 0 14px; }"
            "#selectionReadButton:hover { background: #115e59; }"
            "#selectionDeliverButton { border-left: 1px solid #cbd5e1; border-radius: 0 14px 14px 0; }"
            "#selectionDeliverButton:hover { background: #ecfeff; }"
            "QPushButton:disabled { color: #94a3b8; background: #f8fafc; }"
        )
        self.read_button.clicked.connect(self.read_requested.emit)
        self.deliver_button.clicked.connect(self.deliver_requested.emit)
        self._hide_timer = QTimer(self)
        self._hide_timer.setSingleShot(True)
        self._hide_timer.timeout.connect(self.hide)

    def show_for(self, anchor: QPoint, target_label: str, can_deliver: bool) -> None:
        compact_label = target_label.strip() or "当前人格"
        if len(compact_label) > 18:
            compact_label = f"{compact_label[:17]}…"
        self.deliver_button.setText(f"投递至 {compact_label}")
        self.deliver_button.setEnabled(can_deliver)
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
        )
        self.move(x, y)
        self.show()
        self.raise_()
        self._hide_timer.start(10_000)

    def contains_cursor(self) -> bool:
        return self.isVisible() and self.geometry().contains(QCursor.pos())

    def hide(self) -> None:
        self._hide_timer.stop()
        super().hide()


class WindowsGlobalSelectionHook(QObject):
    pointer_pressed = Signal()
    selection_finished = Signal()
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
        self._thread = threading.Thread(target=self._run, name="RabiRouteSelectionMouseHook", daemon=True)
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

        wh_mouse_ll = 14
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

        result_type = ctypes.c_ssize_t
        callback_type = ctypes.WINFUNCTYPE(result_type, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        user32.SetWindowsHookExW.argtypes = [ctypes.c_int, callback_type, wintypes.HINSTANCE, wintypes.DWORD]
        user32.SetWindowsHookExW.restype = wintypes.HHOOK
        user32.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
        user32.CallNextHookEx.restype = result_type
        kernel32.GetModuleHandleW.restype = wintypes.HMODULE
        self._thread_id = int(kernel32.GetCurrentThreadId())
        drag_start: tuple[int, int] | None = None
        dragged = False

        @callback_type
        def callback(code, message, data):
            nonlocal drag_start, dragged
            if code >= 0:
                info = ctypes.cast(data, ctypes.POINTER(MouseHookStruct)).contents
                point = (int(info.pt.x), int(info.pt.y))
                if message == wm_lbuttondown:
                    drag_start = point
                    dragged = False
                    self.pointer_pressed.emit()
                elif message == wm_mousemove and drag_start is not None:
                    dragged = dragged or (point[0] - drag_start[0]) ** 2 + (point[1] - drag_start[1]) ** 2 >= 16
                elif message == wm_lbuttonup:
                    should_inspect = drag_start is not None and dragged
                    drag_start = None
                    dragged = False
                    if should_inspect:
                        self.selection_finished.emit()
                elif message in dismiss_messages:
                    self.dismiss_requested.emit()
            return user32.CallNextHookEx(None, code, message, data)

        hook = user32.SetWindowsHookExW(wh_mouse_ll, callback, kernel32.GetModuleHandleW(None), 0)
        if not hook:
            self._thread_id = 0
            return
        try:
            message = wintypes.MSG()
            while not self._stop_requested.is_set() and user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
                user32.TranslateMessage(ctypes.byref(message))
                user32.DispatchMessageW(ctypes.byref(message))
        finally:
            user32.UnhookWindowsHookEx(hook)


class SystemSelectionController(QObject):
    def __init__(
        self,
        manager: ManagerClient,
        gateway_context: Callable[[], tuple[str, str]],
        notify: Callable[[str, str, bool], None],
        settings_path: Path | None = None,
        reader: WindowsSelectionReader | None = None,
        hook: WindowsGlobalSelectionHook | None = None,
    ) -> None:
        super().__init__()
        self._manager = manager
        self._gateway_context = gateway_context
        self._notify = notify
        self._settings_path = settings_path
        self._reader = reader or WindowsSelectionReader()
        self._hook = hook or WindowsGlobalSelectionHook()
        self._toolbar = SelectionActionBar()
        self._settings = SelectionSpeechSettings()
        self._selected: SelectedText | None = None
        self._selection_generation = 0
        self._settings_task: QtAsyncTask | None = None
        self._selection_task: QtAsyncTask | None = None
        self._action_task: QtAsyncTask | None = None
        self._selection_error_notified = False
        self._settings_refresh_scheduled = False

        self._settings_watcher = QFileSystemWatcher(self)
        self._settings_watcher.fileChanged.connect(self._settings_changed)
        self._settings_watcher.directoryChanged.connect(self._settings_changed)
        self._hook.pointer_pressed.connect(self._pointer_pressed)
        self._hook.selection_finished.connect(self._selection_finished)
        self._hook.dismiss_requested.connect(self.dismiss)
        self._toolbar.read_requested.connect(self._read_selected)
        self._toolbar.deliver_requested.connect(self._deliver_selected)

    def start(self) -> None:
        self._hook.start()
        self._arm_settings_watcher()
        self.refresh_settings()

    def stop(self) -> None:
        self._hook.stop()
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
        self._arm_settings_watcher()
        if self._settings_refresh_scheduled:
            return
        self._settings_refresh_scheduled = True
        QTimer.singleShot(50, self._refresh_settings_after_change)

    @Slot()
    def _refresh_settings_after_change(self) -> None:
        self._settings_refresh_scheduled = False
        self._arm_settings_watcher()
        self.refresh_settings()

    @Slot()
    def refresh_settings(self) -> None:
        if self._settings_task is not None:
            return

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._settings_task is task:
                self._settings_task = None
            if isinstance(result, SelectionSpeechSettings):
                self._settings = result
                if not result.enabled:
                    self.dismiss()

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

    @Slot()
    def _selection_finished(self) -> None:
        if not self._settings.enabled or self._toolbar.contains_cursor():
            return
        self.dismiss()
        self._selection_generation += 1
        generation = self._selection_generation
        anchor = QCursor.pos()

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._selection_task is task:
                self._selection_task = None
            if generation != self._selection_generation or not self._settings.enabled:
                return
            if isinstance(result, Exception):
                if not self._selection_error_notified:
                    self._selection_error_notified = True
                    self._notify("系统划词", f"无法读取当前软件的文字选区：{result}", True)
                return
            if not isinstance(result, SelectedText):
                return
            self._selection_error_notified = False
            self._selected = result
            gateway_id, label = self._gateway_context()
            self._toolbar.show_for(anchor, label, bool(gateway_id))

        self._selection_task = start_qt_task(
            self._reader.read,
            completed,
            on_error=lambda error: error,
        )

    @Slot()
    def dismiss(self) -> None:
        self._selection_generation += 1
        self._selected = None
        self._toolbar.hide()

    @Slot()
    def _read_selected(self) -> None:
        selected = self._selected
        settings = self._settings
        self._toolbar.hide()
        if selected is None or self._action_task is not None:
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
    def _deliver_selected(self) -> None:
        selected = self._selected
        gateway_id, label = self._gateway_context()
        self._toolbar.hide()
        if selected is None or self._action_task is not None:
            return
        if not gateway_id:
            self._notify("系统划词", "请先在托盘中选择人格 Route。", True)
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
