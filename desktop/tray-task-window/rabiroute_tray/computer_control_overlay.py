"""Qt presentation for the original ComputerService; it never injects input or owns tasks."""
from __future__ import annotations

import ctypes
import json
import math
import os
import sys
import threading
from pathlib import Path
from typing import Any

from PySide6.QtCore import QPointF, QRectF, Qt, QObject, Signal, QTimer
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QApplication, QWidget, QHBoxLayout, QLabel, QPushButton

# The installed standalone entry uses its own packaged parent, never the caller's cwd.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from rabiroute_tray.theme import apply_rabi_application_theme
from rabiroute_tray.themes import register_custom_theme


def physical_bounds(screen) -> tuple[int, int, int, int]:
    """Read native monitor pixels so mixed-DPI Qt screens don't reinterpret source coordinates."""
    if os.name == "nt":
        from ctypes import wintypes

        class MonitorInfo(ctypes.Structure):
            _fields_ = [("size", wintypes.DWORD), ("monitor", wintypes.RECT),
                        ("work", wintypes.RECT), ("flags", wintypes.DWORD),
                        ("device", wintypes.WCHAR * 32)]

        result = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR,
                                           wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)

        def visit(monitor, _dc, _rect, _data):
            info = MonitorInfo()
            info.size = ctypes.sizeof(info)
            if ctypes.windll.user32.GetMonitorInfoW(monitor, ctypes.byref(info)) and info.device == screen.name():
                r = info.monitor
                result.append((r.left, r.top, r.right - r.left, r.bottom - r.top))
            return True

        callback = callback_type(visit)
        ctypes.windll.user32.EnumDisplayMonitors(None, None, callback, 0)
        if result:
            return result[0]
    geometry = screen.geometry()
    ratio = screen.devicePixelRatio()
    return geometry.x(), geometry.y(), round(geometry.width() * ratio), round(geometry.height() * ratio)


def map_source_point(source: dict, x: float, y: float) -> tuple[float, float]:
    if source.get("coordinateSpace") == "capture":
        bounds = source.get("bounds", {})
        width, height = source.get("width", 0), source.get("height", 0)
        if width <= 0 or height <= 0:
            raise ValueError("Capture coordinates require the original source dimensions")
        return bounds.get("x", 0) + x * bounds["width"] / width, bounds.get("y", 0) + y * bounds["height"] / height
    return x, y


class DrawingSurface(QWidget):
    def __init__(self, screen):
        super().__init__(None, Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint |
                         Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.WindowTransparentForInput |
                         Qt.WindowType.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.setGeometry(screen.geometry())
        self.physical = physical_bounds(screen)
        self.state: dict[str, Any] = {}
        self.capture_excluded: bool | None = None

    def ensure_native_visible(self):
        if os.name == "nt" and QApplication.platformName() == "windows":
            user32 = ctypes.windll.user32
            user32.ShowWindow(ctypes.c_void_p(int(self.winId())), 4)
            self.native_visible = bool(user32.IsWindowVisible(ctypes.c_void_p(int(self.winId()))))
            self.capture_excluded = bool(user32.SetWindowDisplayAffinity(ctypes.c_void_p(int(self.winId())), 0x11))
        else:
            self.native_visible = None

    def showEvent(self, event):
        super().showEvent(event)
        QTimer.singleShot(0, self.ensure_native_visible)

    def point(self, source, x, y):
        px, py = map_source_point(source, x, y)
        left, top, width, height = self.physical
        return QPointF((px - left) * self.width() / width, (py - top) * self.height() / height)

    def paintEvent(self, _event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        for layer in self.state.get("layers", []):
            source = layer.get("source", {})
            for shape in layer.get("objects", []):
                style = shape.get("style", {})
                color = QColor(style.get("color", "#3de0cf"))
                color.setAlphaF(max(0, min(1, style.get("opacity", 1))))
                pen = QPen(color, style.get("lineWidth", 2))
                if style.get("dashed"):
                    pen.setStyle(Qt.PenStyle.DashLine)
                painter.setPen(pen)
                painter.setBrush(Qt.BrushStyle.NoBrush)
                bounds = shape.get("bounds", {})
                x, y, width, height = (bounds.get(k, 0) for k in ("x", "y", "width", "height"))
                a, b = self.point(source, x, y), self.point(source, x + width, y + height)
                rect = QRectF(a, b)
                kind = shape.get("type")
                if kind == "rect":
                    painter.drawRect(rect)
                elif kind == "ellipse":
                    painter.drawEllipse(rect)
                elif kind == "highlight":
                    color.setAlphaF(min(color.alphaF(), 0.35))
                    painter.fillRect(rect, color)
                elif kind == "text":
                    font = QFont()
                    font.setPointSizeF(style.get("fontSize", 14))
                    painter.setFont(font)
                    painter.drawText(a, str(shape.get("text", "")))
                elif kind in ("arrow", "path"):
                    points = [self.point(source, p["x"], p["y"]) for p in shape.get("points", [])]
                    if len(points) < 2:
                        continue
                    path = QPainterPath(points[0])
                    for point in points[1:]:
                        path.lineTo(point)
                    painter.drawPath(path)
                    if kind == "arrow":
                        angle = math.atan2(points[-1].y() - points[-2].y(), points[-1].x() - points[-2].x())
                        for offset in (-0.5, 0.5):
                            end = points[-1] - QPointF(12 * math.cos(angle + offset), 12 * math.sin(angle + offset))
                            painter.drawLine(points[-1], end)
        pointer = self.state.get("pointer")
        if pointer and self.state.get("controlSessionId"):
            point = self.point({"coordinateSpace": "desktop"}, pointer["x"], pointer["y"])
            painter.setPen(QPen(QColor("#3de0cf"), 3))
            painter.drawEllipse(point, 7, 7)
            painter.drawText(point + QPointF(12, 0), "Rabi")


class ControlBar(QWidget):
    def __init__(self, stop):
        super().__init__(None, Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint |
                         Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.label = QLabel()
        self.label.setTextFormat(Qt.TextFormat.PlainText)
        self.button = QPushButton("退出控制")
        self.button.clicked.connect(stop)
        layout = QHBoxLayout(self)
        layout.addWidget(self.label)
        layout.addWidget(self.button)
        self._drag = None

    def ensure_native_visible(self):
        if os.name == "nt" and QApplication.platformName() == "windows":
            user32 = ctypes.windll.user32
            user32.ShowWindow(ctypes.c_void_p(int(self.winId())), 4)
            self.native_visible = bool(user32.IsWindowVisible(ctypes.c_void_p(int(self.winId()))))
            user32.SetWindowDisplayAffinity(ctypes.c_void_p(int(self.winId())), 0x11)
        else:
            self.native_visible = None

    def showEvent(self, event):
        super().showEvent(event)
        QTimer.singleShot(0, self.ensure_native_visible)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._drag = event.globalPosition().toPoint() - self.pos()

    def mouseMoveEvent(self, event):
        if self._drag is not None and event.buttons() & Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self._drag)

    def mouseReleaseEvent(self, _event):
        self._drag = None


class Bridge(QObject):
    incoming = Signal(dict)
    eof = Signal()


class Presentation:
    def __init__(self, app):
        self.app = app
        self.resolved_theme = apply_rabi_application_theme(app, "system")
        self.state = {}
        self.surfaces = [DrawingSurface(screen) for screen in app.screens()]
        self.bar = ControlBar(self.stop)
        self.bridge = Bridge()
        self.bridge.incoming.connect(self.update)
        self.bridge.eof.connect(app.quit)
        for surface in self.surfaces:
            surface.show()
            surface.ensure_native_visible()
        geometry = app.primaryScreen().availableGeometry()
        self.bar.move(geometry.right() - 420, geometry.top() + 20)

    def stop(self):
        print(json.dumps({"event": "exit-control", "controlSessionId": self.state.get("controlSessionId")}), flush=True)

    def update(self, state):
        snapshot = state.get("presentationTheme")
        if snapshot:
            try:
                custom = snapshot.get("customTheme") or next((item for item in snapshot.get("customThemes", []) if item.get("id") == snapshot.get("theme")), None)
                register_custom_theme(custom)
                self.resolved_theme = apply_rabi_application_theme(self.app, snapshot.get("theme", "system"))
            except Exception as error:
                self.resolved_theme = apply_rabi_application_theme(self.app, "system")
                print(json.dumps({"event": "theme-diagnostic", "message": str(error), "resolved": self.resolved_theme}), flush=True)
        self.state = state
        for surface in self.surfaces:
            surface.state = state
            surface.repaint()
        if state.get("controlSessionId"):
            source = state.get("source", {})
            label = source.get("label") or source.get("id") or "已连接来源"
            remaining = state.get("remainingMs")
            suffix = f" · 剩余 {math.ceil(remaining / 1000)} 秒" if remaining is not None and remaining <= state.get("countdownSeconds", 10) * 1000 else ""
            shortcut = state.get("exitShortcut", "Ctrl+Alt+Esc")
            self.bar.label.setText(f"Rabi 正在控制此电脑 · {label}\n{shortcut} 退出{suffix}")
            self.bar.show()
            self.bar.ensure_native_visible()
        else:
            self.bar.hide()

        print(json.dumps({"event": "shown", "revision": state.get("revision", 0), "theme": self.resolved_theme,
                          "nativeVisible": all(getattr(s, "native_visible", None) is True for s in self.surfaces),
                          "captureExcluded": all(s.capture_excluded is True for s in self.surfaces)}), flush=True)

    def read(self):
        try:
            for line in sys.stdin:
                self.bridge.incoming.emit(json.loads(line))
        finally:
            self.bridge.eof.emit()


def main():
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    presentation = Presentation(app)
    print(json.dumps({"event": "ready", "nativeVisible": all(getattr(s, "native_visible", None) is True for s in presentation.surfaces) if QApplication.platformName() == "windows" else None}), flush=True)
    threading.Thread(target=presentation.read, daemon=True).start()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
