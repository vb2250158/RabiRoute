from __future__ import annotations

import ctypes
import os
from ctypes import wintypes


def covers_monitor(window_rect: tuple[int, int, int, int], monitor_rect: tuple[int, int, int, int], tolerance: int = 2) -> bool:
    left, top, right, bottom = window_rect
    monitor_left, monitor_top, monitor_right, monitor_bottom = monitor_rect
    return (
        left <= monitor_left + tolerance
        and top <= monitor_top + tolerance
        and right >= monitor_right - tolerance
        and bottom >= monitor_bottom - tolerance
    )

def is_foreground_fullscreen() -> bool:
    if os.name != "nt":
        return False
    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()
    if not hwnd or not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd):
        return False
    window_rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(window_rect)):
        return False
    monitor = user32.MonitorFromWindow(hwnd, 2)  # MONITOR_DEFAULTTONEAREST
    if not monitor:
        return False

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

    info = MONITORINFO(cbSize=ctypes.sizeof(MONITORINFO))
    if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        return False
    return covers_monitor(
        (window_rect.left, window_rect.top, window_rect.right, window_rect.bottom),
        (info.rcMonitor.left, info.rcMonitor.top, info.rcMonitor.right, info.rcMonitor.bottom),
    )
