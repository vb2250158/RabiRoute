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

from PySide6.QtCore import QPoint, QPointF, QRect, QRectF, Qt, QObject, Signal, QTimer
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPalette, QPen
from PySide6.QtWidgets import QApplication, QWidget, QHBoxLayout, QVBoxLayout, QLabel, QPushButton, QSizePolicy

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
        dimensions = source.get("imageView") or source
        width, height = dimensions.get("width", 0), dimensions.get("height", 0)
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
        self.screen_name = screen.name()
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


def centered_bar_position(work_area: QRect, width: int, height: int, placement: str) -> QPoint:
    """Place in the active display's work area, including negative screen origins."""
    margin = min(16, max(0, min(work_area.width(), work_area.height()) // 8))
    x = work_area.left() + max(0, (work_area.width() - width) // 2)
    top = work_area.top() + margin
    bottom = work_area.top() + work_area.height() - height - margin
    y = bottom if placement == "bottom-center" else top
    return QPoint(x, max(work_area.top(), y))


class ElidedLabel(QLabel):
    def paintEvent(self, _event):
        painter = QPainter(self)
        painter.setPen(self.palette().color(self.foregroundRole()))
        text = self.fontMetrics().elidedText(self.text(), Qt.TextElideMode.ElideRight, self.width())
        painter.drawText(self.rect(), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, text)


class ControlBar(QWidget):
    def __init__(self, stop):
        super().__init__(None, Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint |
                         Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setObjectName("computerControlBar")
        self.avatar = QLabel()
        self.avatar.setObjectName("controlAvatar")
        self.avatar.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.avatar.setFixedSize(8, 8)
        self.title_label = ElidedLabel()
        self.title_label.setObjectName("controlTitle")
        self.subtitle_label = ElidedLabel()
        self.subtitle_label.setObjectName("controlSubtitle")
        for label in (self.title_label, self.subtitle_label):
            label.setTextFormat(Qt.TextFormat.PlainText)
            label.setMinimumWidth(0)
            label.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        self.button = QPushButton("■")
        self.button.setObjectName("controlStop")
        self.button.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.button.clicked.connect(stop)
        text = QVBoxLayout()
        text.setSpacing(0)
        text.addWidget(self.title_label)
        text.addWidget(self.subtitle_label)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(14, 6, 9, 6)
        layout.setSpacing(9)
        layout.addWidget(self.avatar)
        layout.addLayout(text, 1)
        layout.addWidget(self.button)
        self.apply_appearance(False)

    def apply_appearance(self, large: bool) -> None:
        palette = QApplication.palette()
        color = lambda role: palette.color(role).name()
        self.background_color = palette.color(QPalette.ColorRole.Window)
        self.large_text = large
        foreground = palette.color(QPalette.ColorRole.WindowText)
        tint = lambda alpha: f"rgba({foreground.red()}, {foreground.green()}, {foreground.blue()}, {alpha})"
        self.setStyleSheet(
            "QWidget#computerControlBar { background: transparent; color: " + color(QPalette.ColorRole.WindowText) + "; }"
            "QLabel { border: none; background: transparent; }"
            "QLabel#controlSubtitle { color: " + tint(165) + "; }"
            "QLabel#controlAvatar { background: " + color(QPalette.ColorRole.Highlight) +
            "; border-radius: 4px; }"
            "QPushButton#controlStop { background: " + tint(18) +
            "; color: " + color(QPalette.ColorRole.WindowText) +
            "; border: none; border-radius: " + str(18 if large else 14) + "px; padding: 0; font-size: 10px; }"
            "QPushButton#controlStop:hover { background: " + tint(36) + "; }"
            "QPushButton#controlStop:pressed { background: " + tint(58) + "; }"
        )
        title_font = QFont(self.font())
        title_font.setPixelSize(16 if large else 13)
        title_font.setWeight(QFont.Weight.DemiBold)
        self.title_label.setFont(title_font)
        subtitle_font = QFont(self.font())
        subtitle_font.setPixelSize(13 if large else 11)
        self.subtitle_label.setFont(subtitle_font)
        self.button.setFixedSize(36 if large else 28, 36 if large else 28)
        self.setFixedHeight(58 if large else 46)
        self.update()

    def preferred_width(self) -> int:
        text_width = max(label.fontMetrics().horizontalAdvance(label.text())
                         for label in (self.title_label, self.subtitle_label))
        return min(440 if self.large_text else 360, max(320 if self.large_text else 280, text_width + 88))

    def paintEvent(self, _event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        body = QRectF(self.rect()).adjusted(2, 2, -2, -3)
        radius = body.height() / 2
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(0, 0, 0, 24))
        painter.drawRoundedRect(body.translated(0, 2), radius, radius)
        border = QApplication.palette().color(QPalette.ColorRole.WindowText)
        border.setAlpha(24)
        painter.setPen(QPen(border, 1))
        painter.setBrush(self.background_color)
        painter.drawRoundedRect(body, radius, radius)

    def set_content(self, title: str, subtitle: str, action: str) -> None:
        if self.title_label.text() != title:
            self.title_label.setText(title)
        if self.subtitle_label.text() != subtitle:
            self.subtitle_label.setText(subtitle)
        self.button.setText("×" if action == "关闭提示" else "■")
        self.button.setAccessibleName(action)
        self.button.setToolTip(f"{action}\n{title}\n{subtitle}")
        self.setAccessibleName(title)

    def nativeEvent(self, event_type, message):
        if os.name == "nt":
            from ctypes import wintypes
            native = wintypes.MSG.from_address(int(message))
            if native.message == 0x84:
                point = wintypes.POINT(ctypes.c_short(native.lParam & 0xffff).value,
                                       ctypes.c_short((native.lParam >> 16) & 0xffff).value)
                client = wintypes.RECT()
                user32 = ctypes.windll.user32
                user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
                user32.GetClientRect.restype = wintypes.BOOL
                user32.ScreenToClient.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
                user32.ScreenToClient.restype = wintypes.BOOL
                handle = int(self.winId())
                if user32.GetClientRect(handle, ctypes.byref(client)) and user32.ScreenToClient(handle, ctypes.byref(point)):
                    width, height = client.right - client.left, client.bottom - client.top
                    if width > 0 and height > 0:
                        local = QPoint(round(point.x * self.width() / width),
                                       round(point.y * self.height() / height))
                        if not self.button.geometry().contains(local):
                            return True, -1
        return super().nativeEvent(event_type, message)

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
        self._appearance_key = None
        self._notice_timer = QTimer(self.bar)
        self._notice_timer.setSingleShot(True)
        self._notice_timer.timeout.connect(self.hide_completed_notice)
        self.app.screenAdded.connect(self.sync_screens)
        self.app.screenRemoved.connect(self.sync_screens)
        for screen in self.app.screens():
            screen.availableGeometryChanged.connect(self.reposition)
            screen.geometryChanged.connect(self.sync_screens)

    def sync_screens(self, *_args):
        current = {screen.name(): screen for screen in self.app.screens()}
        existing = {surface.screen_name: surface for surface in self.surfaces}
        for name, surface in existing.items():
            if name not in current:
                surface.close()
        self.surfaces = []
        for name, screen in current.items():
            surface = existing.get(name)
            if surface is None:
                surface = DrawingSurface(screen)
                surface.show()
                surface.ensure_native_visible()
                screen.availableGeometryChanged.connect(self.reposition)
                screen.geometryChanged.connect(self.sync_screens)
            surface.setGeometry(screen.geometry())
            surface.physical = physical_bounds(screen)
            surface.state = self.state
            self.surfaces.append(surface)
        self.reposition()

    def active_screen(self):
        screens = {screen.name(): screen for screen in self.app.screens()}
        source_display = self.state.get("sourceDisplay") or {}
        display_id = source_display.get("displayId") or self.state.get("displayId")
        if display_id in screens:
            return screens[display_id]
        bounds = source_display.get("nativeBounds") or self.state.get("observedRegion") or {}
        point = self.state.get("pointer") or {}
        if bounds.get("width", 0) > 0 and bounds.get("height", 0) > 0:
            point = {"x": bounds.get("x", 0) + bounds["width"] / 2,
                     "y": bounds.get("y", 0) + bounds["height"] / 2}
        if "x" in point and "y" in point:
            for surface in self.surfaces:
                left, top, width, height = surface.physical
                if left <= point["x"] < left + width and top <= point["y"] < top + height:
                    return screens.get(surface.screen_name, self.app.primaryScreen())
        return self.app.primaryScreen()

    def reposition(self, *_args):
        screen = self.active_screen()
        if screen is None:
            return
        area = screen.availableGeometry()
        self.bar.setMaximumWidth(max(1, area.width() - 32))
        preferred_width = min(self.bar.preferred_width(), max(1, area.width() - 32))
        self.bar.resize(preferred_width, self.bar.height())
        placement = (self.state.get("presentationSettings") or {}).get("barPlacement", "top-center")
        self.bar.move(centered_bar_position(area, self.bar.width(), self.bar.height(), placement))

    def stop(self):
        action = self.state.get("stopAction")
        if isinstance(action, dict) and action.get("action") in (
                "input.cancel", "control.end", "annotation.track.stop"):
            print(json.dumps({"event": "stop-operation", **action}), flush=True)
        elif self.state.get("controlSessionId"):
            print(json.dumps({"event": "exit-control", "controlSessionId": self.state["controlSessionId"]}), flush=True)
        else:
            self.bar.hide()

    def hide_completed_notice(self):
        if self.state.get("phase") in ("returned", "stopped"):
            self.bar.hide()

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
        self._notice_timer.stop()
        for surface in self.surfaces:
            surface.state = state
            surface.repaint()
        phase = state.get("phase") or ("ready" if state.get("controlSessionId") else "")
        if phase:
            source = state.get("source", {})
            label = source.get("label") or source.get("id") or "已连接来源"
            remaining = state.get("remainingMs")
            suffix = f" · 剩余 {math.ceil(remaining / 1000)} 秒" if remaining is not None and remaining <= state.get("countdownSeconds", 10) * 1000 else ""
            shortcut = state.get("exitShortcut", "Ctrl+Alt+Esc")
            display_id = (state.get("sourceDisplay") or {}).get("name") or (state.get("sourceDisplay") or {}).get("displayId")
            titles = {
                "capturing": "正在获取清晰画面", "prepared": "画面已准备",
                "provided": "画面已提供给 Agent", "operating": "Rabi 正在操作",
                "returning": "正在归还鼠标和前台", "returned": "已归还你的鼠标和前台",
                "tracking": "正在跟踪目标", "stopped": "本次操作已停止",
                "failed": "本次操作需要处理", "ready": "控制已就绪，等待操作"
            }
            title = titles.get(phase, "电脑操作状态")
            if phase == "returned":
                returned = state.get("returnState") or {}
                cursor = returned.get("cursor")
                foreground = returned.get("foreground")
                if returned.get("state") == "yielded" or "yielded" in (cursor, foreground):
                    title = "已让出操作，保留你当前的位置"
                elif cursor == "restored" and foreground == "restored":
                    title = "已归还你的鼠标和前台"
                elif returned.get("state") in ("partial", "failed", "unavailable"):
                    title = "本批次结束，归还需要检查"
                elif cursor == "disabled" or foreground == "disabled":
                    title = "本批次结束，按设置保留当前位置"
                else:
                    title = "本批次结束，归还状态待确认"

            if display_id:
                title += f" · {display_id}"
            detail = f"{label} · {shortcut} 退出{suffix}"
            if phase == "prepared":
                detail = f"{label} · 可展开查看画面与来源"
            elif phase == "returned":
                detail = f"{label} · 本批次操作结束"
            settings = state.get("presentationSettings") or {}
            appearance_key = (self.resolved_theme, settings.get("textSize", "standard"))
            if appearance_key != self._appearance_key:
                self.bar.apply_appearance(settings.get("textSize") == "large")
                self._appearance_key = appearance_key
            action_label = "停止本次操作" if state.get("stopAction") else "退出控制" if state.get("controlSessionId") else "关闭提示"
            self.bar.set_content(title, detail, action_label)
            self.reposition()
            self.bar.show()
            self.bar.ensure_native_visible()
            if phase in ("returned", "stopped"):
                self._notice_timer.start(round(settings.get("noticeDurationMs", 2500)))
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
