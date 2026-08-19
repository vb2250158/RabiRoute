from __future__ import annotations

import ctypes
import re
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from PySide6.QtCore import QFileSystemWatcher, QObject, QPoint, QTimer, Qt, Signal, Slot
from PySide6.QtGui import QImage, QPainter, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QLabel,
    QPlainTextEdit,
    QVBoxLayout,
)

from .manager_client import DesktopSettings, ManagerClient, RolePanelSendResult
from .qt_async import QtAsyncTask, start_qt_task
from .system_selection import SelectionDeliveryTarget
from .windows_app_identity import sync_startup_shortcut


DEFAULT_SCREENSHOT_SHORTCUT = "Ctrl+Shift+S"
_MODIFIERS = {
    "CTRL": 0x0002,
    "CONTROL": 0x0002,
    "ALT": 0x0001,
    "SHIFT": 0x0004,
    "WIN": 0x0008,
    "WINDOWS": 0x0008,
}
_SPECIAL_KEYS = {
    "SPACE": 0x20,
    "TAB": 0x09,
    "ENTER": 0x0D,
    "ESC": 0x1B,
    "ESCAPE": 0x1B,
    "F1": 0x70,
    "F2": 0x71,
    "F3": 0x72,
    "F4": 0x73,
    "F5": 0x74,
    "F6": 0x75,
    "F7": 0x76,
    "F8": 0x77,
    "F9": 0x78,
    "F10": 0x79,
    "F11": 0x7A,
    "F12": 0x7B,
}


@dataclass(frozen=True)
class ScreenshotSettings:
    enabled: bool = False
    shortcut: str = DEFAULT_SCREENSHOT_SHORTCUT


def parse_hotkey(value: str) -> tuple[int, int] | None:
    tokens = [item.strip().upper() for item in value.split("+") if item.strip()]
    if len(tokens) < 2:
        return None
    modifiers = 0
    key: int | None = None
    for token in tokens:
        modifier = _MODIFIERS.get(token)
        if modifier is not None:
            modifiers |= modifier
            continue
        if key is not None:
            return None
        if token in _SPECIAL_KEYS:
            key = _SPECIAL_KEYS[token]
        elif len(token) == 1 and (token.isalpha() or token.isdigit()):
            key = ord(token)
        else:
            return None
    return (modifiers | 0x4000, key) if key is not None and modifiers else None


class WindowsGlobalScreenshotHotkey(QObject):
    activated = Signal()

    def __init__(self) -> None:
        super().__init__()
        self._thread: threading.Thread | None = None
        self._thread_id = 0
        self._stop_requested = threading.Event()
        self._hotkey: tuple[int, int] | None = None

    def configure(self, enabled: bool, shortcut: str) -> None:
        hotkey = parse_hotkey(shortcut) if enabled else None
        if hotkey == self._hotkey and (hotkey is None or self._thread is not None):
            return
        self.stop()
        self._hotkey = hotkey
        if hotkey is not None:
            self.start()

    def start(self) -> None:
        if sys.platform != "win32" or self._thread is not None or self._hotkey is None:
            return
        self._stop_requested.clear()
        self._thread = threading.Thread(target=self._run, name="RabiRouteScreenshotHotkey", daemon=True)
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

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        self._thread_id = int(kernel32.GetCurrentThreadId())
        modifiers, virtual_key = self._hotkey or (0, 0)
        if not user32.RegisterHotKey(None, 0x5242, modifiers, virtual_key):
            self._thread_id = 0
            return
        try:
            message = wintypes.MSG()
            while not self._stop_requested.is_set() and user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
                if message.message == 0x0312 and message.wParam == 0x5242:
                    self.activated.emit()
        finally:
            user32.UnregisterHotKey(None, 0x5242)


def capture_desktop(project_root: Path, screens: list[Any] | None = None) -> Path:
    screens = screens if screens is not None else list(QApplication.screens())
    if not screens:
        raise RuntimeError("没有可用的显示器。")
    geometries = [screen.geometry() for screen in screens]
    left = min(rect.left() for rect in geometries)
    top = min(rect.top() for rect in geometries)
    right = max(rect.right() + 1 for rect in geometries)
    bottom = max(rect.bottom() + 1 for rect in geometries)
    image = QImage(right - left, bottom - top, QImage.Format.Format_ARGB32)
    image.fill(Qt.GlobalColor.black)
    painter = QPainter(image)
    try:
        for screen, geometry in zip(screens, geometries):
            pixmap = screen.grabWindow(0)
            painter.drawPixmap(geometry.left() - left, geometry.top() - top, pixmap)
    finally:
        painter.end()
    directory = project_root / ".rabiroute-message-images"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"screenshot-{time.strftime('%Y%m%d-%H%M%S')}-{time.time_ns() % 1_000_000:06d}.png"
    if not image.save(str(path), "PNG"):
        raise RuntimeError("截图保存失败。")
    return path


class ScreenshotComposer(QDialog):
    send_requested = Signal(str, str)

    def __init__(self, image_path: Path, targets: list[SelectionDeliveryTarget], parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("发送截图")
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
        self.setModal(False)
        self._image_path = image_path
        self._preview = QLabel()
        self._preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._preview.setMinimumSize(420, 260)
        pixmap = QPixmap(str(image_path))
        if not pixmap.isNull():
            self._preview.setPixmap(pixmap.scaled(720, 480, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        self._target = QComboBox()
        for target in targets:
            self._target.addItem(target.label, target.gateway_id)
        self._text = QPlainTextEdit()
        self._text.setPlaceholderText("输入要和截图一起发送给人格的文字……")
        self._text.setMinimumHeight(80)
        self._error = QLabel()
        self._error.setStyleSheet("color: #b42318;")
        self._error.hide()
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Cancel | QDialogButtonBox.StandardButton.Ok)
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("发送")
        buttons.rejected.connect(self.reject)
        buttons.accepted.connect(self._send)
        layout = QVBoxLayout(self)
        layout.addWidget(self._preview)
        layout.addWidget(QLabel("投递至人格"))
        layout.addWidget(self._target)
        layout.addWidget(self._text)
        layout.addWidget(self._error)
        layout.addWidget(buttons)
        self.resize(760, 700)

    @property
    def image_path(self) -> Path:
        return self._image_path

    def set_error(self, message: str) -> None:
        self._error.setText(message)
        self._error.setVisible(bool(message))

    def set_sending(self, sending: bool) -> None:
        self._target.setEnabled(not sending)
        self._text.setEnabled(not sending)

    @Slot()
    def _send(self) -> None:
        gateway_id = str(self._target.currentData() or "").strip()
        if not gateway_id:
            self.set_error("没有可投递的激活人格。")
            return
        self.send_requested.emit(gateway_id, self._text.toPlainText().strip())


class SystemScreenshotController(QObject):
    def __init__(
        self,
        manager: ManagerClient,
        project_root: Path,
        delivery_targets_provider: Callable[[], list[SelectionDeliveryTarget]],
        notify: Callable[[str, str, bool], None],
        settings_path: Path | None = None,
        hotkey: WindowsGlobalScreenshotHotkey | None = None,
    ) -> None:
        super().__init__()
        self._manager = manager
        self._project_root = project_root
        self._delivery_targets_provider = delivery_targets_provider
        self._notify = notify
        self._settings_path = settings_path
        self._hotkey = hotkey or WindowsGlobalScreenshotHotkey()
        self._settings = ScreenshotSettings()
        self._settings_task: QtAsyncTask | None = None
        self._send_task: QtAsyncTask | None = None
        self._composer: ScreenshotComposer | None = None
        self._settings_refresh_scheduled = False
        self._settings_watcher = QFileSystemWatcher(self)
        self._settings_watcher.fileChanged.connect(self._settings_changed)
        self._settings_watcher.directoryChanged.connect(self._settings_changed)
        self._hotkey.activated.connect(self._capture_requested)

    def start(self) -> None:
        self._arm_settings_watcher()
        self.refresh_settings()

    def stop(self) -> None:
        self._hotkey.stop()
        if self._composer is not None:
            self._composer.close()
            self._composer = None

    def _arm_settings_watcher(self) -> None:
        current = self._settings_watcher.files() + self._settings_watcher.directories()
        if current:
            self._settings_watcher.removePaths(current)
        if self._settings_path is None:
            return
        paths: list[str] = []
        if self._settings_path.exists():
            paths.append(str(self._settings_path))
        directory = self._settings_path.parent
        while not directory.exists() and directory != directory.parent:
            directory = directory.parent
        if directory.exists():
            paths.append(str(directory))
        if paths:
            self._settings_watcher.addPaths(list(dict.fromkeys(paths)))

    @Slot(str)
    def _settings_changed(self, _path: str) -> None:
        self._arm_settings_watcher()
        if self._settings_refresh_scheduled:
            return
        self._settings_refresh_scheduled = True
        QTimer.singleShot(80, self._refresh_settings_after_change)

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
            if isinstance(result, DesktopSettings):
                self._settings = ScreenshotSettings(result.screenshot_enabled, result.screenshot_shortcut)
                self._hotkey.configure(self._settings.enabled, self._settings.shortcut)
                sync_startup_shortcut(self._project_root, result.autostart)

        self._settings_task = start_qt_task(
            self._manager.desktop_settings,
            completed,
            on_error=lambda error: error,
        )

    @Slot()
    def _capture_requested(self) -> None:
        if not self._settings.enabled or self._send_task is not None or self._composer is not None:
            return
        try:
            image_path = capture_desktop(self._project_root)
        except Exception as error:
            self._notify("系统截图", f"截图失败：{error}", True)
            return
        targets = self._delivery_targets_provider()
        if not targets:
            self._notify("系统截图", "当前没有已激活人格，截图已保存但未打开投递窗口。", True)
            return
        composer = ScreenshotComposer(image_path, targets)
        self._composer = composer
        composer.send_requested.connect(self._send_screenshot)
        composer.finished.connect(lambda _result: self._clear_composer(composer))
        composer.show()
        composer.raise_()
        composer.activateWindow()

    def _clear_composer(self, composer: ScreenshotComposer) -> None:
        if self._composer is composer:
            self._composer = None

    @Slot(str, str)
    def _send_screenshot(self, gateway_id: str, text: str) -> None:
        composer = self._composer
        if composer is None or self._send_task is not None:
            return
        try:
            size = composer.image_path.stat().st_size
        except OSError:
            composer.set_error("截图文件已不可用，请重新截图。")
            return
        composer.set_sending(True)
        attachment = {
            "kind": "image",
            "name": composer.image_path.name,
            "path": str(composer.image_path),
            "size": size,
        }

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._send_task is task:
                self._send_task = None
            if not isinstance(result, RolePanelSendResult):
                result = RolePanelSendResult(ok=False, message="未知发送结果")
            if result.ok:
                label = next((target.label for target in self._delivery_targets_provider() if target.gateway_id == gateway_id), gateway_id)
                self._notify("系统截图", f"已投递至 {label}。", False)
                if self._composer is not None:
                    self._composer.accept()
            else:
                if self._composer is not None:
                    self._composer.set_sending(False)
                    self._composer.set_error(f"投递失败：{result.message or '未知错误'}")

        self._send_task = start_qt_task(
            lambda: self._manager.send_role_panel_message(gateway_id, text, [attachment]),
            completed,
            on_error=lambda error: RolePanelSendResult(ok=False, message=str(error)),
        )
