"""Frame-paced dragging in a stable coordinate space across monitor DPI changes."""
from __future__ import annotations

import ctypes
import math
import os
from ctypes import wintypes
from dataclasses import dataclass
from functools import lru_cache


def preserve_dpi_size(message_pointer: int, size: tuple[int, int]) -> None:
    """Keep WM_DPICHANGED's suggested native rectangle at the pet's pixel size.

    The message still reaches Qt so screen identity, layout units and input
    coordinates receive the new DPI. Only the suggested physical extent changes.
    """
    if os.name != "nt":
        return
    message = ctypes.cast(message_pointer, ctypes.POINTER(wintypes.MSG)).contents
    if message.message == 0x02E0 and message.lParam:
        bounds = ctypes.cast(message.lParam, ctypes.POINTER(wintypes.RECT)).contents
        bounds.right = bounds.left + size[0]
        bounds.bottom = bounds.top + size[1]


@dataclass
class DragFollow:
    x: float
    y: float
    anchor_x: float
    anchor_y: float
    cursor_x: float
    cursor_y: float
    velocity_x: float = 0.0
    velocity_y: float = 0.0

    @classmethod
    def begin(cls, cursor: tuple[float, float], bounds: tuple[float, float, float, float]) -> DragFollow:
        x, y, width, height = bounds
        return cls(x, y, (cursor[0] - x) / max(1, width), (cursor[1] - y) / max(1, height), *cursor)

    def distance(self, cursor: tuple[float, float]) -> float:
        return math.hypot(cursor[0] - self.cursor_x, cursor[1] - self.cursor_y)

    def advance(self, cursor: tuple[float, float], size: tuple[float, float], elapsed: float) -> tuple[int, int]:
        # The normalized grab point survives WM_DPICHANGED resizing the window.
        target_x = cursor[0] - self.anchor_x * size[0]
        target_y = cursor[1] - self.anchor_y * size[1]
        dt = max(0.0, min(0.05, elapsed))
        frequency = 45.0
        decay = math.exp(-frequency * dt)
        for axis, target in (("x", target_x), ("y", target_y)):
            velocity_name = "velocity_" + axis
            offset = getattr(self, axis) - target
            velocity = getattr(self, velocity_name)
            coupled = velocity + frequency * offset
            setattr(self, axis, target + (offset + coupled * dt) * decay)
            setattr(self, velocity_name, (velocity - frequency * coupled * dt) * decay)
        return round(self.x), round(self.y)


@lru_cache(maxsize=1)
def _drag_user32():
    api = ctypes.WinDLL("user32", use_last_error=True)
    api.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    api.GetCursorPos.restype = wintypes.BOOL
    api.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    api.GetWindowRect.restype = wintypes.BOOL
    api.GetAsyncKeyState.argtypes = [ctypes.c_int]
    api.GetAsyncKeyState.restype = ctypes.c_short
    api.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, wintypes.UINT]
    api.SetWindowPos.restype = wintypes.BOOL
    return api


class NativeDrag:
    def __init__(self, handle: int) -> None:
        self.handle = handle
        self.api = _drag_user32()

    @classmethod
    def for_window(cls, handle: int) -> NativeDrag | None:
        if os.name != "nt":
            return None
        drag = cls(handle)
        return drag if drag.sample() is not None else None

    def sample(self) -> tuple[tuple[float, float], tuple[float, float, float, float]] | None:
        cursor, rect = wintypes.POINT(), wintypes.RECT()
        if not self.api.GetCursorPos(ctypes.byref(cursor)) or not self.api.GetWindowRect(self.handle, ctypes.byref(rect)):
            return None
        return (cursor.x, cursor.y), (rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)

    def button_down(self) -> bool:
        return bool(self.api.GetAsyncKeyState(1) & 0x8000)

    def move(self, x: int, y: int) -> bool:
        # Keep size/z-order/focus unchanged. Qt handles the resulting native
        # geometry and DPI notifications, including negative desktop origins.
        return bool(self.api.SetWindowPos(self.handle, None, x, y, 0, 0, 0x0215))


    def display_areas(self):
        from .desktop_pet_physics import DisplayArea

        class MonitorInfo(ctypes.Structure):
            _fields_ = [("size", wintypes.DWORD), ("panel", wintypes.RECT),
                        ("work", wintypes.RECT), ("flags", wintypes.DWORD)]

        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HANDLE, wintypes.HDC,
                                          ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)
        self.api.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MonitorInfo)]
        self.api.GetMonitorInfoW.restype = wintypes.BOOL
        self.api.EnumDisplayMonitors.argtypes = [wintypes.HDC, ctypes.POINTER(wintypes.RECT), callback_type, wintypes.LPARAM]
        self.api.EnumDisplayMonitors.restype = wintypes.BOOL
        displays = []

        @callback_type
        def collect(handle, dc, rect, data):
            info = MonitorInfo()
            info.size = ctypes.sizeof(info)
            if self.api.GetMonitorInfoW(handle, ctypes.byref(info)):
                def edges(row):
                    return row.left, row.top, row.right, row.bottom
                displays.append(DisplayArea(edges(info.panel), edges(info.work)))
            return True

        self.api.EnumDisplayMonitors(None, None, collect, 0)
        return displays


    def resize(self, width: int, height: int) -> bool:
        # NOMOVE | NOZORDER | NOACTIVATE | NOOWNERZORDER, exact physical pixels.
        return bool(self.api.SetWindowPos(self.handle, None, 0, 0, width, height, 0x0216))
