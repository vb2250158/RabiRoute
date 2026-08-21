from __future__ import annotations

import ctypes
import json
import os
import sys
import uuid
import threading
import time
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from PIL import ImageGrab
from PySide6.QtCore import QEvent, QFileSystemWatcher, QObject, QPoint, QRect, QSize, QTimer, Qt, Signal, Slot
from PySide6.QtGui import QAction, QColor, QContextMenuEvent, QCursor, QImage, QKeyEvent, QMouseEvent, QPainter, QPalette, QPen, QPixmap, QWheelEvent
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMenu,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .manager_client import DesktopSettings, ManagerClient, RolePanelSendResult
from .qt_async import QtAsyncTask, start_qt_task
from .system_selection import SelectionDeliveryTarget
from .windows_app_identity import sync_startup_shortcut


DEFAULT_SCREENSHOT_SHORTCUT = "Ctrl+Shift+S"
DEFAULT_CLIPBOARD_PIN_SHORTCUT = "F3"
_HISTORY_LIMIT = 30
_SETTINGS_RETRY_DELAY_MS = 2_000
def _screenshot_theme_colors() -> dict[str, str]:
    app = QApplication.instance()
    dark = bool(app and app.palette().color(QPalette.ColorRole.Window).lightness() < 128)
    if dark:
        return {
            "surface": "#19242e",
            "border": "#526779",
            "text": "#e9f2f7",
            "hover": "#1b3a40",
            "toolbar": "rgba(16, 22, 29, 236)",
            "selection": "#43d4d7",
        }
    return {
        "surface": "#ffffff",
        "border": "#cbd5e1",
        "text": "#0f172a",
        "hover": "#e2f5f0",
        "toolbar": "rgba(15, 23, 42, 232)",
        "selection": "#2dd4bf",
    }


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
    clipboard_shortcut: str = DEFAULT_CLIPBOARD_PIN_SHORTCUT
    auto_copy: bool = True


@dataclass(frozen=True)
class ScreenshotWindowCandidate:
    rectangle: QRect


def screenshot_window_candidates(ignore_handles: tuple[int, ...] = ()) -> tuple[ScreenshotWindowCandidate, ...]:
    """Return visible top-level application windows in front-to-back order."""
    if sys.platform != "win32":
        return ()
    ignored = {handle for handle in ignore_handles if handle}
    user32 = ctypes.windll.user32
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
    candidates: list[ScreenshotWindowCandidate] = []
    ws_ex_toolwindow = 0x00000080
    ws_ex_noactivate = 0x08000000

    @callback_type
    def inspect_window(handle, _lparam):
        if int(handle) in ignored or not user32.IsWindowVisible(handle) or user32.IsIconic(handle):
            return True
        ex_style = int(user32.GetWindowLongPtrW(handle, -20))
        if ex_style & ws_ex_toolwindow and ex_style & ws_ex_noactivate:
            return True
        rect = wintypes.RECT()
        if not user32.GetWindowRect(handle, ctypes.byref(rect)):
            return True
        width = int(rect.right - rect.left)
        height = int(rect.bottom - rect.top)
        if width < 24 or height < 24:
            return True
        candidates.append(ScreenshotWindowCandidate(QRect(int(rect.left), int(rect.top), width, height)))
        return True

    user32.EnumWindows(inspect_window, 0)
    return tuple(candidates)


def screenshot_window_candidate_at(
    candidates: tuple[ScreenshotWindowCandidate, ...],
    screen_point: QPoint,
) -> ScreenshotWindowCandidate | None:
    return next((candidate for candidate in candidates if candidate.rectangle.contains(screen_point)), None)


@dataclass(frozen=True)
class ScreenshotHistory:
    paths: tuple[Path, ...]
    index: int = 0

    @property
    def current(self) -> Path | None:
        return self.paths[self.index] if self.paths else None

    def move(self, offset: int) -> "ScreenshotHistory":
        if not self.paths:
            return self
        return ScreenshotHistory(self.paths, max(0, min(self.index + offset, len(self.paths) - 1)))


@dataclass(frozen=True)
class PinnedScreenshot:
    pin_id: str
    image_path: Path
    x: int
    y: int
    width: int
    height: int
    opacity: float


def desktop_screenshot_state_directory(project_root: Path) -> Path:
    return project_root / "data" / "desktop"


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_json_object(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.{time.time_ns()}.tmp")
    try:
        temporary_path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary_path, path)
    finally:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            pass


class ScreenshotRegionStore:
    def __init__(self, project_root: Path) -> None:
        self._path = desktop_screenshot_state_directory(project_root) / "screenshot-region-history.json"

    def get(self, image_path: Path) -> QRect | None:
        entries = _read_json_object(self._path).get("regions")
        if not isinstance(entries, list):
            return None
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("image") != image_path.name:
                continue
            try:
                rect = QRect(int(entry["x"]), int(entry["y"]), int(entry["width"]), int(entry["height"]))
            except (KeyError, TypeError, ValueError):
                return None
            return rect if rect.width() > 0 and rect.height() > 0 else None
        return None

    def remember(self, image_path: Path, source_rect: QRect) -> None:
        if source_rect.isEmpty() or not image_path.name:
            return
        payload = _read_json_object(self._path)
        entries = payload.get("regions")
        records = [entry for entry in entries if isinstance(entry, dict) and entry.get("image") != image_path.name] if isinstance(entries, list) else []
        records.insert(
            0,
            {
                "image": image_path.name,
                "x": source_rect.x(),
                "y": source_rect.y(),
                "width": source_rect.width(),
                "height": source_rect.height(),
            },
        )
        _write_json_object(self._path, {"version": 1, "regions": records[:_HISTORY_LIMIT]})


class PinnedScreenshotStore:
    def __init__(self, project_root: Path) -> None:
        self._directory = desktop_screenshot_state_directory(project_root) / "screenshot-pins"
        self._manifest_path = self._directory / "manifest.json"

    def create(self, image: QImage, position: QPoint, size: QSize, opacity: float) -> PinnedScreenshot:
        if image.isNull():
            raise RuntimeError("贴图图片不可用。")
        pin_id = uuid.uuid4().hex
        image_path = self._directory / f"{pin_id}.png"
        self._directory.mkdir(parents=True, exist_ok=True)
        if not image.save(str(image_path), "PNG"):
            raise RuntimeError("贴图保存失败。")
        record = PinnedScreenshot(pin_id, image_path, position.x(), position.y(), max(1, size.width()), max(1, size.height()), self._opacity(opacity))
        try:
            records = self._read_records()
            records.insert(0, record)
            self._write_records(records)
        except Exception:
            try:
                image_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        return record

    def load(self) -> tuple[PinnedScreenshot, ...]:
        return tuple(record for record in self._read_records() if record.image_path.is_file() and not QImage(str(record.image_path)).isNull())

    def update(self, pin_id: str, position: QPoint, size: QSize, opacity: float) -> None:
        records = self._read_records()
        updated = [
            PinnedScreenshot(record.pin_id, record.image_path, position.x(), position.y(), max(1, size.width()), max(1, size.height()), self._opacity(opacity)) if record.pin_id == pin_id else record
            for record in records
        ]
        if updated != records:
            self._write_records(updated)

    def delete(self, pin_id: str) -> None:
        records = self._read_records()
        removed = [record for record in records if record.pin_id == pin_id]
        if not removed:
            return
        self._write_records([record for record in records if record.pin_id != pin_id])
        for record in removed:
            try:
                record.image_path.unlink(missing_ok=True)
            except OSError:
                pass

    def _read_records(self) -> list[PinnedScreenshot]:
        entries = _read_json_object(self._manifest_path).get("pins")
        if not isinstance(entries, list):
            return []
        records: list[PinnedScreenshot] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            pin_id = str(entry.get("id") or "").strip()
            image_name = str(entry.get("image") or "").strip()
            if not pin_id or not image_name or Path(image_name).name != image_name:
                continue
            try:
                record = PinnedScreenshot(
                    pin_id,
                    self._directory / image_name,
                    int(entry["x"]),
                    int(entry["y"]),
                    max(1, int(entry["width"])),
                    max(1, int(entry["height"])),
                    self._opacity(float(entry.get("opacity", 1.0))),
                )
            except (KeyError, TypeError, ValueError):
                continue
            records.append(record)
        return records

    def _write_records(self, records: list[PinnedScreenshot]) -> None:
        _write_json_object(
            self._manifest_path,
            {
                "version": 1,
                "pins": [
                    {
                        "id": record.pin_id,
                        "image": record.image_path.name,
                        "x": record.x,
                        "y": record.y,
                        "width": record.width,
                        "height": record.height,
                        "opacity": record.opacity,
                    }
                    for record in records
                ],
            },
        )

    @staticmethod
    def _opacity(value: float) -> float:
        return max(0.1, min(1.0, value))


def parse_hotkey(value: str) -> tuple[int, int] | None:
    tokens = [item.strip().upper() for item in value.split("+") if item.strip()]
    if not tokens:
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
    if key is None or (not modifiers and not 0x70 <= key <= 0x7B):
        return None
    return modifiers | 0x4000, key


def screenshot_directory(project_root: Path) -> Path:
    return project_root / ".rabiroute-message-images"


def screenshot_history(image_path: Path) -> ScreenshotHistory:
    directory = image_path.parent
    candidates = [
        path
        for pattern in ("screenshot-*.png", "screen-*.png")
        for path in directory.glob(pattern)
        if path.is_file()
    ]
    candidates.sort(key=lambda path: path.stat().st_mtime_ns, reverse=True)
    ordered = [image_path, *(path for path in candidates if path != image_path)]
    return ScreenshotHistory(tuple(ordered[:_HISTORY_LIMIT]))


def save_screenshot_image(project_root: Path, image: QImage, prefix: str = "screenshot") -> Path:
    directory = screenshot_directory(project_root)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{prefix}-{time.strftime('%Y%m%d-%H%M%S')}-{time.time_ns() % 1_000_000:06d}.png"
    if image.isNull() or not image.save(str(path), "PNG"):
        raise RuntimeError("截图保存失败。")
    return path


class WindowsGlobalHotkey(QObject):
    activated = Signal()

    def __init__(self, hotkey_id: int, thread_name: str) -> None:
        super().__init__()
        self._hotkey_id = hotkey_id
        self._thread_name = thread_name
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
        self._thread = threading.Thread(target=self._run, name=self._thread_name, daemon=True)
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
        if not user32.RegisterHotKey(None, self._hotkey_id, modifiers, virtual_key):
            self._thread_id = 0
            return
        try:
            message = wintypes.MSG()
            while not self._stop_requested.is_set() and user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
                if message.message == 0x0312 and message.wParam == self._hotkey_id:
                    self.activated.emit()
        finally:
            user32.UnregisterHotKey(None, self._hotkey_id)


class WindowsGlobalScreenshotHotkey(WindowsGlobalHotkey):
    def __init__(self) -> None:
        super().__init__(0x5242, "RabiRouteScreenshotHotkey")


class WindowsGlobalClipboardPinHotkey(WindowsGlobalHotkey):
    def __init__(self) -> None:
        super().__init__(0x5243, "RabiRouteClipboardPinHotkey")


def capture_desktop_image(screens: list[Any] | None = None) -> QImage:
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
    return image


def capture_desktop_image_async() -> QImage:
    if sys.platform != "win32":
        raise RuntimeError("系统截图仅支持 Windows。")
    captured = ImageGrab.grab(all_screens=True)
    if captured.mode != "RGBA":
        captured = captured.convert("RGBA")
    image = QImage(captured.tobytes(), captured.width, captured.height, QImage.Format.Format_RGBA8888).copy()
    if image.isNull():
        raise RuntimeError("截图像素不可用。")
    return image


def capture_desktop(project_root: Path, screens: list[Any] | None = None) -> Path:
    return save_screenshot_image(project_root, capture_desktop_image(screens), "capture")


class ScreenshotColorPreviewWindow(QFrame):
    """Mouse-transparent color magnifier rendered independently from the capture overlay."""

    def __init__(self) -> None:
        super().__init__()
        self._magnifier_pixmap = QPixmap()
        self._color_name = ""
        self.magnifier = QLabel(self)
        self.swatch = QLabel(self)
        self.hex_label = QLabel(self)
        self._configure_window()
        self._configure_layout()

    def _configure_window(self) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.WindowDoesNotAcceptFocus
            | Qt.WindowType.WindowTransparentForInput
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setFixedSize(126, 150)
        colors = _screenshot_theme_colors()
        self.setStyleSheet(
            f"background: {colors['toolbar']}; color: white; border: 1px solid {colors['selection']}; border-radius: 6px;"
        )

    def _configure_layout(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(5, 5, 7, 5)
        layout.setSpacing(6)
        self.magnifier.setFixedSize(110, 110)
        self.magnifier.setStyleSheet("border: 0;")
        self.swatch.setFixedSize(34, 24)
        self.hex_label.setStyleSheet("border: 0; font-family: Consolas, 'Courier New', monospace; font-weight: 600;")
        details = QHBoxLayout()
        details.setContentsMargins(0, 0, 0, 0)
        details.setSpacing(6)
        details.addWidget(self.swatch)
        details.addWidget(self.hex_label)
        details.addStretch(1)
        layout.addWidget(self.magnifier, 0, Qt.AlignmentFlag.AlignHCenter)
        layout.addLayout(details)

    def present(self, position: QPoint, magnifier: QImage, color: QColor) -> None:
        self.move(position)
        if not self.isVisible():
            self.show()
            self.raise_()
        self._magnifier_pixmap.convertFromImage(magnifier)
        self.magnifier.setPixmap(self._magnifier_pixmap)
        color_name = color.name().upper()
        if color_name != self._color_name:
            self._color_name = color_name
            self.swatch.setStyleSheet(
                f"background: {color_name}; border: 1px solid rgba(255, 255, 255, 180); border-radius: 3px;"
            )
            self.hex_label.setText(color_name)


class ScreenshotCaptureOverlay(QWidget):
    copy_requested = Signal(QImage)
    pin_requested = Signal(QImage, QRect)
    send_requested = Signal(QImage)
    color_copy_requested = Signal(str)

    def __init__(
        self,
        history: ScreenshotHistory,
        virtual_geometry: QRect | None = None,
        region_store: ScreenshotRegionStore | None = None,
        transient_paths: tuple[Path, ...] = (),
        auto_copy_on_confirm: bool = True,
    ) -> None:
        super().__init__()
        self._history = history
        self._region_store = region_store
        self._transient_paths = set(transient_paths)
        self._auto_copy_on_confirm = auto_copy_on_confirm
        self._image = QImage()
        self._capture_ready = bool(history.paths)
        self._pending_action: str | None = None
        self._selection = QRect()
        self._drag_start: QPoint | None = None
        self._selection_move_offset: QPoint | None = None
        self._window_candidates: tuple[ScreenshotWindowCandidate, ...] = ()
        self._hover_window_candidate: ScreenshotWindowCandidate | None = None
        self._candidate_click_pending = False
        self._pointer_position: QPoint | None = None
        self._color_preview: QColor | None = None
        self._toolbar = QFrame(self)
        self._history_label = QLabel(self)
        self._color_tip = ScreenshotColorPreviewWindow()
        self._color_magnifier = self._color_tip.magnifier
        self._color_swatch = self._color_tip.swatch
        self._color_hex_label = self._color_tip.hex_label
        self._copy_button = QPushButton("复制", self._toolbar)
        self._pin_button = QPushButton("贴图", self._toolbar)
        self._send_button = QPushButton("发送", self._toolbar)
        self._configure_window(virtual_geometry)
        self._configure_toolbar()
        self._show_history(self._history.index)

    def _configure_window(self, virtual_geometry: QRect | None) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        geometry = virtual_geometry or self._virtual_geometry()
        self.setGeometry(geometry)
        colors = _screenshot_theme_colors()
        self._history_label.setStyleSheet(
            f"background: {colors['toolbar']}; color: white; border-radius: 6px; padding: 5px 8px;"
        )
        self._history_label.move(14, 14)
        self._color_tip.hide()

    def _configure_toolbar(self) -> None:
        colors = _screenshot_theme_colors()
        self._toolbar.setStyleSheet(
            f"QFrame {{ background: {colors['surface']}; border: 1px solid {colors['border']}; border-radius: 8px; }}"
            f"QPushButton {{ border: 0; border-radius: 6px; padding: 6px 11px; color: {colors['text']}; }}"
            f"QPushButton:hover {{ background: {colors['hover']}; }}"
        )
        layout = QHBoxLayout(self._toolbar)
        layout.setContentsMargins(5, 5, 5, 5)
        layout.setSpacing(3)
        layout.addWidget(self._copy_button)
        layout.addWidget(self._pin_button)
        layout.addWidget(self._send_button)
        self._toolbar.hide()
        for widget in (self._history_label, self._toolbar, self._copy_button, self._pin_button, self._send_button):
            widget.installEventFilter(self)
        self._copy_button.clicked.connect(self._copy)
        self._pin_button.clicked.connect(self._pin)
        self._send_button.clicked.connect(self._send)

    @staticmethod
    def _virtual_geometry() -> QRect:
        screens = list(QApplication.screens())
        if not screens:
            return QRect(0, 0, 1, 1)
        result = QRect(screens[0].geometry())
        for screen in screens[1:]:
            result = result.united(screen.geometry())
        return result

    def _show_history(self, index: int) -> None:
        if not self._history.paths:
            self._history_label.setText("正在准备截图…")
            self._history_label.adjustSize()
            self.update()
            return
        index = max(0, min(index, len(self._history.paths) - 1))
        path = self._history.paths[index]
        image = QImage(str(path))
        if image.isNull():
            self._history = ScreenshotHistory(tuple(item for item in self._history.paths if item != path), 0)
            self._show_history(0)
            return
        self._history = ScreenshotHistory(self._history.paths, index)
        self._image = image
        self._capture_ready = True
        source_rect = self._region_store.get(path) if self._region_store is not None else None
        self._selection = self._selection_from_source(source_rect) if source_rect is not None else QRect()
        self._toolbar.hide()
        self._history_label.setText(f"{index + 1} / {len(self._history.paths)}    < 上一张    > 下一张")
        self._history_label.adjustSize()
        if not self._selection.isEmpty():
            self._position_toolbar()
        self.update()

    def set_capture_image(self, image: QImage) -> None:
        if image.isNull():
            return
        self._image = image
        self._update_color_preview()
        self._history_label.setText("正在保存截图…")
        self._history_label.adjustSize()
        self.update()

    def complete_capture(self, history: ScreenshotHistory, transient_path: Path) -> None:
        if not history.paths:
            return
        self._history = history
        self._transient_paths.add(transient_path)
        self._capture_ready = True
        self._history_label.setText(f"{history.index + 1} / {len(history.paths)}    < 上一张    > 下一张")
        self._history_label.adjustSize()
        if self._selection.isEmpty():
            source_rect = self._region_store.get(history.current) if history.current is not None and self._region_store is not None else None
            self._selection = self._selection_from_source(source_rect) if source_rect is not None else QRect()
            if not self._selection.isEmpty():
                self._position_toolbar()
        pending_action = self._pending_action
        self._pending_action = None
        self.update()
        if pending_action is not None:
            self._execute_selection_action(pending_action)

    def capture_failed(self) -> None:
        self._pending_action = None
        self._history_label.setText("截图失败")
        self._history_label.adjustSize()
        self.update()

    def _image_selection(self) -> QImage:
        if self._selection.isEmpty() or self._image.isNull() or self.width() <= 0 or self.height() <= 0:
            return QImage()
        source = self._source_rect(self._selection)
        return self._image.copy(source)

    def _position_toolbar(self) -> None:
        if self._selection.isEmpty():
            return
        self._toolbar.adjustSize()
        x = max(8, min(self._selection.left(), self.width() - self._toolbar.width() - 8))
        below = self._selection.bottom() + 10
        y = below if below + self._toolbar.height() <= self.height() - 8 else self._selection.top() - self._toolbar.height() - 10
        y = max(8, min(y, self.height() - self._toolbar.height() - 8))
        self._toolbar.move(x, y)
        self._toolbar.show()
        self._toolbar.raise_()

    def _complete_selection(self) -> None:
        self._candidate_click_pending = False
        if self._selection.width() < 2 or self._selection.height() < 2:
            self._selection = QRect()
            self._toolbar.hide()
            self.update()
            return
        self._position_toolbar()
        self.update()

    def _commit_current_capture(self) -> Path | None:
        current = self._history.current
        if current is None or current not in self._transient_paths:
            return current
        target = current.with_name(f"screenshot-{current.name.removeprefix('capture-')}")
        try:
            current.replace(target)
        except OSError:
            return None
        self._history = ScreenshotHistory(tuple(target if path == current else path for path in self._history.paths), self._history.index)
        self._transient_paths.discard(current)
        return target

    def _remember_selection(self) -> None:
        current = self._commit_current_capture()
        if current is None or self._region_store is None:
            return
        try:
            self._region_store.remember(current, self._source_rect(self._selection))
        except OSError:
            pass

    def set_window_candidates(self, candidates: tuple[ScreenshotWindowCandidate, ...]) -> None:
        self._window_candidates = candidates
        self._pointer_position = self._pointer_position or self.mapFromGlobal(QCursor.pos())
        self._update_window_hover(self._pointer_position)
        self._update_color_preview()
        self.update()

    def _selection_from_window_candidate(self, candidate: ScreenshotWindowCandidate) -> QRect:
        top_left = candidate.rectangle.topLeft() - self.geometry().topLeft()
        return QRect(top_left, candidate.rectangle.size()).intersected(self.rect())

    def _update_window_hover(self, point: QPoint) -> None:
        if not self._selection.isEmpty() or self._drag_start is not None:
            self._hover_window_candidate = None
            return
        self._hover_window_candidate = screenshot_window_candidate_at(
            self._window_candidates,
            self.mapToGlobal(point),
        )

    def _update_color_preview(self) -> None:
        if not self._selection.isEmpty() or self._drag_start is not None:
            self._color_preview = None
        else:
            self._color_preview = self._color_at(self._pointer_position)
        self._update_color_tip()

    def _update_color_tip(self) -> None:
        if self._color_preview is None or self._pointer_position is None:
            self._color_tip.hide()
            return
        magnifier = self._color_magnifier_image(self._pointer_position)
        if magnifier.isNull():
            self._color_tip.hide()
            return
        self._color_tip.present(
            self.mapToGlobal(self._color_tip_position(self._pointer_position)),
            magnifier,
            self._color_preview,
        )
    def _color_tip_position(self, cursor: QPoint) -> QPoint:
        margin = 14
        size = self._color_tip.size()
        candidates = (
            QPoint(cursor.x() + margin, cursor.y() + margin),
            QPoint(cursor.x() - size.width() - margin, cursor.y() + margin),
            QPoint(cursor.x() + margin, cursor.y() - size.height() - margin),
            QPoint(cursor.x() - size.width() - margin, cursor.y() - size.height() - margin),
        )
        bounds = self.rect().adjusted(8, 8, -8, -8)
        for position in candidates:
            if bounds.contains(QRect(position, size)):
                return position
        return QPoint(
            max(bounds.left(), min(cursor.x() + margin, bounds.right() - size.width() + 1)),
            max(bounds.top(), min(cursor.y() + margin, bounds.bottom() - size.height() + 1)),
        )

    def _color_magnifier_image(self, point: QPoint) -> QImage:
        if self._image.isNull():
            return QImage()
        source = self._source_rect(QRect(point, QSize(1, 1)))
        if source.isEmpty():
            return QImage()
        sample_size = 11
        sample_radius = sample_size // 2
        center = source.topLeft()
        requested = QRect(
            center.x() - sample_radius,
            center.y() - sample_radius,
            sample_size,
            sample_size,
        )
        if self._image.rect().contains(requested):
            sample = self._image.copy(requested)
        else:
            visible = requested.intersected(self._image.rect())
            sample = QImage(sample_size, sample_size, QImage.Format.Format_ARGB32)
            sample.fill(self._image.pixelColor(center))
            painter = QPainter(sample)
            try:
                painter.drawImage(visible.topLeft() - requested.topLeft(), self._image, visible)
            finally:
                painter.end()
        magnifier = sample.scaled(
            sample_size * 10,
            sample_size * 10,
            Qt.AspectRatioMode.IgnoreAspectRatio,
            Qt.TransformationMode.FastTransformation,
        )
        painter = QPainter(magnifier)
        try:
            center_offset = sample_radius * 10
            painter.setPen(QPen(QColor("black"), 3))
            painter.drawRect(center_offset, center_offset, 10, 10)
            painter.setPen(QPen(QColor("white"), 1))
            painter.drawRect(center_offset, center_offset, 10, 10)
        finally:
            painter.end()
        return magnifier

    def _color_at(self, point: QPoint | None) -> QColor | None:
        if point is None or self._image.isNull() or not self.rect().contains(point):
            return None
        source = self._source_rect(QRect(point, QSize(1, 1)))
        if source.isEmpty():
            return None
        return self._image.pixelColor(source.topLeft())

    def copy_current_color(self) -> bool:
        color = self._color_preview or self._color_at(self._pointer_position)
        if color is None:
            return False
        self._color_preview = color
        self.color_copy_requested.emit(color.name().upper())
        self._update_color_tip()
        self.update()
        return True

    def _copy(self) -> None:
        self._run_selection_action("copy")

    def pin_selection(self) -> bool:
        return self._run_selection_action("pin")

    def _pin(self) -> None:
        self.pin_selection()

    def _send(self) -> None:
        self._run_selection_action("send")

    def _focus_hovered_window_candidate(self) -> bool:
        if not self._selection.isEmpty() or self._drag_start is not None or self._hover_window_candidate is None:
            return not self._selection.isEmpty()
        selection = self._selection_from_window_candidate(self._hover_window_candidate)
        if selection.isEmpty():
            return False
        self._selection = selection
        self._hover_window_candidate = None
        self._candidate_click_pending = False
        self._position_toolbar()
        self._update_color_preview()
        self.update()
        return True

    def _run_selection_action(self, action: str) -> bool:
        if self._selection.isEmpty() and not self._focus_hovered_window_candidate():
            return False
        if not self._capture_ready:
            self._pending_action = action
            self._history_label.setText("正在准备截图，完成后继续…")
            self._history_label.adjustSize()
            self.update()
            return True
        self._execute_selection_action(action)
        return True

    def _execute_selection_action(self, action: str) -> None:
        image = self._image_selection()
        if image.isNull():
            return
        self._remember_selection()
        if action != "copy" and self._auto_copy_on_confirm:
            self.copy_requested.emit(image)
        if action == "copy":
            self.copy_requested.emit(image)
        elif action == "pin":
            origin = QRect(self.mapToGlobal(self._selection.topLeft()), self._selection.size())
            self.pin_requested.emit(image, origin)
        elif action == "send":
            self.send_requested.emit(image)
        else:
            return
        self.close()

    def paintEvent(self, _event) -> None:
        painter = QPainter(self)
        try:
            painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_Source)
            painter.fillRect(self.rect(), Qt.GlobalColor.transparent)
            painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_SourceOver)
            if not self._image.isNull():
                painter.drawImage(self.rect(), self._image)
            if not self._selection.isEmpty():
                painter.fillRect(self.rect(), QColor(15, 23, 42, 132))
                if not self._image.isNull():
                    painter.drawImage(self._selection, self._image, self._source_rect(self._selection))
                painter.setPen(QPen(QColor(_screenshot_theme_colors()["selection"]), 2, Qt.PenStyle.DashLine))
                painter.drawRect(self._selection.adjusted(0, 0, -1, -1))
                selection = self._image_selection()
                label = f"{selection.width()} × {selection.height()}" if not selection.isNull() else "正在准备截图…"
                metrics = painter.fontMetrics()
                label_rect = QRect(self._selection.left(), max(0, self._selection.top() - metrics.height() - 9), metrics.horizontalAdvance(label) + 14, metrics.height() + 7)
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(QColor(13, 148, 136, 230))
                painter.drawRoundedRect(label_rect, 4, 4)
                painter.setPen(QColor("white"))
                painter.drawText(label_rect, Qt.AlignmentFlag.AlignCenter, label)
            elif self._hover_window_candidate is not None:
                candidate_rect = self._selection_from_window_candidate(self._hover_window_candidate)
                if not candidate_rect.isEmpty():
                    if not self._image.isNull():
                        painter.fillRect(self.rect(), QColor(15, 23, 42, 132))
                        painter.drawImage(candidate_rect, self._image, self._source_rect(candidate_rect))
                    painter.setPen(QPen(QColor(_screenshot_theme_colors()["selection"]), 2, Qt.PenStyle.DashLine))
                    painter.drawRect(candidate_rect.adjusted(0, 0, -1, -1))
                    label = f"窗口 {candidate_rect.width()} × {candidate_rect.height()} · 回车复制 / F3 贴图 / F2 发送"
                    metrics = painter.fontMetrics()
                    label_rect = QRect(candidate_rect.left(), max(0, candidate_rect.top() - metrics.height() - 9), metrics.horizontalAdvance(label) + 14, metrics.height() + 7)
                    painter.setPen(Qt.PenStyle.NoPen)
                    painter.setBrush(QColor(13, 148, 136, 230))
                    painter.drawRoundedRect(label_rect, 4, 4)
                    painter.setPen(QColor("white"))
                    painter.drawText(label_rect, Qt.AlignmentFlag.AlignCenter, label)
        finally:
            painter.end()

    def _source_rect(self, selection: QRect) -> QRect:
        if self.width() <= 0 or self.height() <= 0:
            return QRect()
        return QRect(
            round(selection.x() * self._image.width() / self.width()),
            round(selection.y() * self._image.height() / self.height()),
            max(1, round(selection.width() * self._image.width() / self.width())),
            max(1, round(selection.height() * self._image.height() / self.height())),
        ).intersected(self._image.rect())

    def _selection_from_source(self, source: QRect) -> QRect:
        if source.isEmpty() or self._image.isNull() or self._image.width() <= 0 or self._image.height() <= 0:
            return QRect()
        return QRect(
            round(source.x() * self.width() / self._image.width()),
            round(source.y() * self.height() / self._image.height()),
            max(1, round(source.width() * self.width() / self._image.width())),
            max(1, round(source.height() * self.height() / self._image.height())),
        ).intersected(self.rect())

    def eventFilter(self, watched: QObject, event) -> bool:
        if event.type() == QEvent.Type.MouseButtonPress and isinstance(event, QMouseEvent) and event.button() == Qt.MouseButton.RightButton:
            self.close()
            event.accept()
            return True
        return super().eventFilter(watched, event)

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.RightButton:
            self.close()
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton:
            point = event.position().toPoint()
            self._pointer_position = point
            if self._selection.isEmpty() and self._hover_window_candidate is not None:
                selection = self._selection_from_window_candidate(self._hover_window_candidate)
                if not selection.isEmpty():
                    self._selection = selection
                    self._drag_start = point
                    self._candidate_click_pending = True
                    self._selection_move_offset = None
                    self._toolbar.hide()
                    self.update()
                    event.accept()
                    return
            if not self._selection.isEmpty() and self._selection.contains(point):
                self._selection_move_offset = point - self._selection.topLeft()
                event.accept()
                return
            self._hover_window_candidate = None
            self._drag_start = point
            self._selection_move_offset = None
            self._candidate_click_pending = False
            self._selection = QRect(self._drag_start, self._drag_start)
            self._toolbar.hide()
            self._update_color_preview()
            self.update()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        point = event.position().toPoint()
        self._pointer_position = point
        if self._selection_move_offset is not None and event.buttons() & Qt.MouseButton.LeftButton:
            point -= self._selection_move_offset
            x = max(0, min(point.x(), self.width() - self._selection.width()))
            y = max(0, min(point.y(), self.height() - self._selection.height()))
            self._selection.moveTo(x, y)
            self._position_toolbar()
            self._update_color_preview()
            self.update()
            event.accept()
            return
        if self._drag_start is not None and event.buttons() & Qt.MouseButton.LeftButton:
            if self._candidate_click_pending and (point - self._drag_start).manhattanLength() <= 4:
                event.accept()
                return
            self._candidate_click_pending = False
            self._hover_window_candidate = None
            self._selection = QRect(self._drag_start, point).normalized()
            self._update_color_preview()
            self.update()
            event.accept()
            return
        previous_hover = self._hover_window_candidate
        self._update_window_hover(point)
        self._update_color_preview()
        if self._hover_window_candidate != previous_hover:
            self.update()
        event.accept()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton and self._selection_move_offset is not None:
            self._selection_move_offset = None
            self._position_toolbar()
            self.update()
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton and self._drag_start is not None:
            if not self._candidate_click_pending:
                self._selection = QRect(self._drag_start, event.position().toPoint()).normalized()
            self._drag_start = None
            self._complete_selection()
            self._update_color_preview()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def closeEvent(self, event) -> None:
        self._color_tip.close()
        self._color_tip.deleteLater()
        for path in tuple(self._transient_paths):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        self._transient_paths.clear()
        event.accept()

    def keyPressEvent(self, event: QKeyEvent) -> None:
        if event.key() == Qt.Key.Key_Escape:
            self.close()
            return
        if event.key() == Qt.Key.Key_C and event.modifiers() == Qt.KeyboardModifier.NoModifier:
            self.copy_current_color()
            return
        if event.key() == Qt.Key.Key_A and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self._selection = self.rect()
            self._complete_selection()
            return
        if event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter) or (
            event.key() == Qt.Key.Key_C and event.modifiers() & Qt.KeyboardModifier.ControlModifier
        ):
            self._copy()
            return
        if event.key() == Qt.Key.Key_F2:
            self._send()
            return
        if event.key() == Qt.Key.Key_Comma or event.text() == "<":
            self._show_history(self._history.move(1).index)
            return
        if event.key() == Qt.Key.Key_Period or event.text() == ">":
            self._show_history(self._history.move(-1).index)
            return
        super().keyPressEvent(event)


class PinnedImageWindow(QWidget):
    state_changed = Signal()
    removed = Signal()

    def __init__(
        self,
        image: QImage,
        position: QPoint | None = None,
        display_size: QSize | None = None,
        opacity: float = 1.0,
    ) -> None:
        super().__init__()
        self._source = image.copy()
        self._base_size = display_size if display_size is not None and display_size.isValid() else self.default_display_size(image)
        self._zoom = 1.0
        self._drag_offset: QPoint | None = None
        self._remove_when_closed = True
        self._toolbar = QFrame(self)
        self._image_label = QLabel(self)
        self._configure_window()
        self._configure_layout()
        self._apply_image_size()
        self.setWindowOpacity(max(0.1, min(1.0, opacity)))
        if position is not None:
            self.move(position)

    @staticmethod
    def default_display_size(image: QImage) -> QSize:
        width, height = max(1, image.width()), max(1, image.height())
        scale = min(1.0, 900 / width, 650 / height)
        return QSize(max(1, round(width * scale)), max(1, round(height * scale)))

    def close_for_shutdown(self) -> None:
        self._remove_when_closed = False
        self.close()

    def _configure_window(self) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        colors = _screenshot_theme_colors()
        self.setStyleSheet(f"background: {colors['surface']}; border: 1px solid {colors['border']}; border-radius: 8px;")

    def _configure_layout(self) -> None:
        colors = _screenshot_theme_colors()
        self._toolbar.setStyleSheet(f"background: {colors['toolbar']}; border: 0; border-radius: 7px;")
        toolbar_layout = QHBoxLayout(self._toolbar)
        toolbar_layout.setContentsMargins(5, 5, 5, 5)
        toolbar_layout.setSpacing(2)
        for label, callback in (("复制", self._copy), ("保存", self._save), ("关闭", self.close)):
            button = QPushButton(label, self._toolbar)
            button.setStyleSheet("QPushButton { color: white; border: 0; padding: 4px 8px; } QPushButton:hover { background: #334155; border-radius: 5px; }")
            button.clicked.connect(callback)
            toolbar_layout.addWidget(button)
        self._toolbar.hide()
        self._image_label.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self._image_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

    def _apply_image_size(self) -> None:
        width = max(1, round(self._base_size.width() * self._zoom))
        height = max(1, round(self._base_size.height() * self._zoom))
        pixmap = QPixmap.fromImage(self._source).scaled(width, height, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        self.resize(pixmap.size())
        self._image_label.setPixmap(pixmap)
        self._image_label.setGeometry(self.rect())
        self._toolbar.adjustSize()
        self._toolbar.move(max(6, self.width() - self._toolbar.width() - 6), 6)

    def _copy(self) -> None:
        QApplication.clipboard().setImage(self._source)

    def _save(self) -> None:
        from PySide6.QtWidgets import QFileDialog

        target, _ = QFileDialog.getSaveFileName(self, "保存贴图", "贴图.png", "PNG 图片 (*.png)")
        if target:
            self._source.save(target, "PNG")

    def _set_opacity(self, value: float) -> None:
        self.setWindowOpacity(max(0.1, min(1.0, value)))
        self.state_changed.emit()

    def enterEvent(self, event) -> None:
        self._toolbar.show()
        self._toolbar.raise_()
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:
        if not self._toolbar.underMouse():
            self._toolbar.hide()
        super().leaveEvent(event)

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            self.activateWindow()
            self.setFocus()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if self._drag_offset is not None and event.buttons() & Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self._drag_offset)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            moved = self._drag_offset is not None
            self._drag_offset = None
            if moved:
                self.state_changed.emit()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def wheelEvent(self, event: QWheelEvent) -> None:
        self._zoom = max(0.25, min(4.0, self._zoom * (1.1 if event.angleDelta().y() > 0 else 1 / 1.1)))
        self._apply_image_size()
        self.state_changed.emit()
        event.accept()

    def keyPressEvent(self, event: QKeyEvent) -> None:
        if event.key() == Qt.Key.Key_Escape:
            self.close()
            return
        if event.key() == Qt.Key.Key_C and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self._copy()
            return
        super().keyPressEvent(event)

    def contextMenuEvent(self, event: QContextMenuEvent) -> None:
        menu = QMenu(self)
        copy_action = QAction("复制", menu)
        copy_action.triggered.connect(self._copy)
        menu.addAction(copy_action)
        save_action = QAction("保存", menu)
        save_action.triggered.connect(self._save)
        menu.addAction(save_action)
        menu.addSeparator()
        for opacity in (100, 80, 60, 40):
            action = QAction(f"透明度 {opacity}%", menu)
            action.triggered.connect(lambda _checked=False, value=opacity: self._set_opacity(value / 100))
            menu.addAction(action)
        menu.addSeparator()
        close_action = QAction("关闭", menu)
        close_action.triggered.connect(self.close)
        menu.addAction(close_action)
        menu.exec(event.globalPos())

    def closeEvent(self, event) -> None:
        if self._remove_when_closed:
            self.removed.emit()
        event.accept()


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
        hotkey: WindowsGlobalHotkey | None = None,
        clipboard_hotkey: WindowsGlobalHotkey | None = None,
    ) -> None:
        super().__init__()
        self._manager = manager
        self._project_root = project_root
        self._delivery_targets_provider = delivery_targets_provider
        self._notify = notify
        self._settings_path = settings_path
        self._hotkey = hotkey or WindowsGlobalScreenshotHotkey()
        self._clipboard_hotkey = clipboard_hotkey or WindowsGlobalClipboardPinHotkey()
        self._settings = ScreenshotSettings()
        self._plugin_hotkey_handlers: frozenset[str] = frozenset()
        self._settings_task: QtAsyncTask | None = None
        self._capture_task: QtAsyncTask | None = None
        self._window_candidates_task: QtAsyncTask | None = None
        self._capture_save_task: QtAsyncTask | None = None
        self._send_task: QtAsyncTask | None = None
        self._composer: ScreenshotComposer | None = None
        self._capture_overlay: ScreenshotCaptureOverlay | None = None
        self._region_store = ScreenshotRegionStore(project_root)
        self._pin_store = PinnedScreenshotStore(project_root)
        self._pins: dict[PinnedImageWindow, str] = {}
        self._pins_restored = False
        self._started = False
        self._settings_refresh_scheduled = False
        self._settings_retry_scheduled = False
        self._settings_retry_delay_ms = _SETTINGS_RETRY_DELAY_MS
        self._settings_watcher = QFileSystemWatcher(self)
        self._settings_watcher.fileChanged.connect(self._settings_changed)
        self._settings_watcher.directoryChanged.connect(self._settings_changed)
        self._hotkey.activated.connect(self.request_capture)
        self._clipboard_hotkey.activated.connect(self.request_clipboard_pin)

    def set_plugin_hotkey_handlers(self, handler_ids: frozenset[str]) -> None:
        self._plugin_hotkey_handlers = frozenset(handler_ids)
        self._apply_hotkey_configuration()

    @Slot()
    def request_capture(self) -> None:
        self._capture_requested()

    @Slot()
    def request_clipboard_pin(self) -> None:
        self._pin_requested()

    def _apply_hotkey_configuration(self) -> None:
        self._hotkey.configure(
            self._started
            and self._settings.enabled
            and "desktop.capture-screenshot" in self._plugin_hotkey_handlers,
            self._settings.shortcut,
        )
        self._clipboard_hotkey.configure(
            self._started
            and self._settings.enabled
            and "desktop.pin-clipboard-image" in self._plugin_hotkey_handlers,
            self._settings.clipboard_shortcut,
        )

    def start(self) -> None:
        self._started = True
        self._arm_settings_watcher()
        self._restore_pinned_images()
        self._apply_hotkey_configuration()
        self.refresh_settings()

    def stop(self) -> None:
        self._started = False
        self._hotkey.stop()
        self._clipboard_hotkey.stop()
        if self._composer is not None:
            self._composer.close()
            self._composer = None
        if self._capture_overlay is not None:
            self._capture_overlay.close()
            self._capture_overlay = None
        for pin in tuple(self._pins):
            pin.close_for_shutdown()
        self._pins.clear()

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
        if not self._started:
            return
        self._arm_settings_watcher()
        if self._settings_refresh_scheduled:
            return
        self._settings_refresh_scheduled = True
        QTimer.singleShot(80, self._refresh_settings_after_change)

    @Slot()
    def _refresh_settings_after_change(self) -> None:
        self._settings_refresh_scheduled = False
        if not self._started:
            return
        self._arm_settings_watcher()
        self.refresh_settings()

    def _schedule_settings_retry(self) -> None:
        if not self._started or self._settings_retry_scheduled:
            return
        self._settings_retry_scheduled = True
        QTimer.singleShot(self._settings_retry_delay_ms, self._retry_settings)

    @Slot()
    def _retry_settings(self) -> None:
        self._settings_retry_scheduled = False
        if self._started:
            self.refresh_settings()

    @Slot()
    def refresh_settings(self) -> None:
        if not self._started or self._settings_task is not None:
            return

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._settings_task is task:
                self._settings_task = None
            if not self._started:
                return
            if not isinstance(result, DesktopSettings):
                self._schedule_settings_retry()
                return
            self._settings_retry_scheduled = False
            self._settings = ScreenshotSettings(
                result.screenshot_enabled,
                result.screenshot_shortcut,
                result.screenshot_clipboard_shortcut,
                result.screenshot_auto_copy,
            )
            self._apply_hotkey_configuration()
            sync_startup_shortcut(self._project_root, result.autostart)

        self._settings_task = start_qt_task(
            self._manager.desktop_settings,
            completed,
            on_error=lambda error: error,
        )

    @Slot()
    def _capture_requested(self) -> None:
        if not self._settings.enabled or self._capture_overlay is not None:
            return
        overlay = ScreenshotCaptureOverlay(
            ScreenshotHistory(()),
            region_store=self._region_store,
            auto_copy_on_confirm=self._settings.auto_copy,
        )
        self._capture_overlay = overlay
        overlay.copy_requested.connect(self._copy_capture_image)
        overlay.pin_requested.connect(self._pin_image)
        overlay.send_requested.connect(self._send_capture_image)
        overlay.color_copy_requested.connect(self._copy_color_text)
        overlay.destroyed.connect(lambda *_: self._clear_capture_overlay(overlay))
        overlay.show()
        overlay.raise_()
        overlay.activateWindow()
        overlay.setFocus(Qt.FocusReason.ActiveWindowFocusReason)
        QApplication.processEvents()
        self._capture_task = start_qt_task(
            capture_desktop_image_async,
            lambda task, result: self._capture_image_ready(task, overlay, result),
            on_error=lambda error: error,
        )
        overlay_handle = int(overlay.winId())
        self._window_candidates_task = start_qt_task(
            lambda: screenshot_window_candidates((overlay_handle,)),
            lambda task, result: self._window_candidates_ready(task, overlay, result),
            on_error=lambda error: error,
        )

    def _window_candidates_ready(self, task: QtAsyncTask, overlay: ScreenshotCaptureOverlay, result: object) -> None:
        if self._window_candidates_task is task:
            self._window_candidates_task = None
        if self._capture_overlay is overlay and isinstance(result, tuple):
            overlay.set_window_candidates(tuple(item for item in result if isinstance(item, ScreenshotWindowCandidate)))

    def _capture_image_ready(self, task: QtAsyncTask, overlay: ScreenshotCaptureOverlay, result: object) -> None:
        if self._capture_task is task:
            self._capture_task = None
        if not isinstance(result, QImage) or result.isNull():
            if self._capture_overlay is overlay:
                overlay.capture_failed()
                self._notify("系统截图", f"截图失败：{result}", True)
            return
        if self._capture_overlay is not overlay:
            return
        overlay.set_capture_image(result)
        self._capture_save_task = start_qt_task(
            lambda: save_screenshot_image(self._project_root, result, "capture"),
            lambda save_task, saved: self._capture_image_saved(save_task, overlay, saved),
            on_error=lambda error: error,
        )

    def _capture_image_saved(self, task: QtAsyncTask, overlay: ScreenshotCaptureOverlay, result: object) -> None:
        if self._capture_save_task is task:
            self._capture_save_task = None
        if not isinstance(result, Path):
            if self._capture_overlay is overlay:
                overlay.capture_failed()
                self._notify("系统截图", f"截图保存失败：{result}", True)
            return
        if self._capture_overlay is not overlay:
            try:
                result.unlink(missing_ok=True)
            except OSError:
                pass
            return
        overlay.complete_capture(screenshot_history(result), result)

    @Slot()
    def _pin_requested(self) -> None:
        if not self._settings.enabled:
            return
        if self._capture_overlay is not None:
            self._capture_overlay.pin_selection()
            return
        self._pin_clipboard_image()

    def _pin_clipboard_image(self) -> None:
        image = QApplication.clipboard().image()
        if image.isNull():
            self._notify("贴图", "剪贴板中没有图片。", True)
            return
        self._pin_image(image)

    def _clear_capture_overlay(self, overlay: ScreenshotCaptureOverlay) -> None:
        if self._capture_overlay is overlay:
            self._capture_overlay = None

    @Slot(QImage)
    def _copy_capture_image(self, image: QImage) -> None:
        QApplication.clipboard().setImage(image)

    @Slot(str)
    def _copy_color_text(self, value: str) -> None:
        QApplication.clipboard().setText(value)

    @Slot(QImage, QRect)
    def _pin_image(self, image: QImage, origin: QRect | None = None) -> None:
        if image.isNull():
            return
        position = origin.topLeft() if origin is not None and not origin.isEmpty() else QCursor.pos()
        display_size = origin.size() if origin is not None and not origin.isEmpty() else PinnedImageWindow.default_display_size(image)
        try:
            pin = PinnedImageWindow(image, position, display_size)
            record = self._pin_store.create(image, pin.pos(), pin.size(), pin.windowOpacity())
        except Exception as error:
            self._notify("贴图", f"贴图保存失败：{error}", True)
            return
        self._attach_pin(pin, record.pin_id)
        pin.show()
        pin.raise_()
        pin.activateWindow()

    def _restore_pinned_images(self) -> None:
        if self._pins_restored:
            return
        self._pins_restored = True
        for record in self._pin_store.load():
            image = QImage(str(record.image_path))
            if image.isNull():
                continue
            pin = PinnedImageWindow(image, QPoint(record.x, record.y), QSize(record.width, record.height), record.opacity)
            self._attach_pin(pin, record.pin_id)
            pin.show()

    def _attach_pin(self, pin: PinnedImageWindow, pin_id: str) -> None:
        self._pins[pin] = pin_id
        pin.state_changed.connect(lambda: self._save_pin_state(pin, pin_id))
        pin.removed.connect(lambda: self._remove_pin(pin, pin_id))
        pin.destroyed.connect(lambda *_: self._pins.pop(pin, None))

    def _save_pin_state(self, pin: PinnedImageWindow, pin_id: str) -> None:
        if self._pins.get(pin) == pin_id:
            self._pin_store.update(pin_id, pin.pos(), pin.size(), pin.windowOpacity())

    def _remove_pin(self, pin: PinnedImageWindow, pin_id: str) -> None:
        if self._pins.pop(pin, None) == pin_id:
            self._pin_store.delete(pin_id)

    @Slot(QImage)
    def _send_capture_image(self, image: QImage) -> None:
        try:
            image_path = save_screenshot_image(self._project_root, image, "selection")
        except Exception as error:
            self._notify("系统截图", f"截图保存失败：{error}", True)
            return
        self._open_composer(image_path)

    def _open_composer(self, image_path: Path) -> None:
        if self._send_task is not None or self._composer is not None:
            return
        targets = self._delivery_targets_provider()
        if not targets:
            self._notify("系统截图", "当前没有已激活人格，图片已复制或保存。", True)
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
            elif self._composer is not None:
                self._composer.set_sending(False)
                self._composer.set_error(f"投递失败：{result.message or '未知错误'}")

        self._send_task = start_qt_task(
            lambda: self._manager.send_role_panel_message(gateway_id, text, [attachment]),
            completed,
            on_error=lambda error: RolePanelSendResult(ok=False, message=str(error)),
        )
