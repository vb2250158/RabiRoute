from __future__ import annotations

import ctypes
import os
from ctypes import wintypes
from functools import lru_cache


def covers_monitor(window_rect: tuple[int, int, int, int], monitor_rect: tuple[int, int, int, int], tolerance: int = 2) -> bool:
    left, top, right, bottom = window_rect
    monitor_left, monitor_top, monitor_right, monitor_bottom = monitor_rect
    return all(abs(edge - monitor_edge) <= tolerance for edge, monitor_edge in zip(
        (left, top, right, bottom), (monitor_left, monitor_top, monitor_right, monitor_bottom)))


class _MonitorInfo(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]


@lru_cache(maxsize=1)
def _user32():
    # HWND and HMONITOR are pointer-sized on the packaged 64-bit Windows runtime.
    api = ctypes.WinDLL("user32", use_last_error=True)
    signatures = {
        "GetForegroundWindow": ([], wintypes.HWND),
        "IsWindowVisible": ([wintypes.HWND], wintypes.BOOL),
        "IsIconic": ([wintypes.HWND], wintypes.BOOL),
        "IsZoomed": ([wintypes.HWND], wintypes.BOOL),
        "GetWindowRect": ([wintypes.HWND, ctypes.POINTER(wintypes.RECT)], wintypes.BOOL),
        "GetWindowLongPtrW": ([wintypes.HWND, ctypes.c_int], ctypes.c_ssize_t),
        "GetClassNameW": ([wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
        "MonitorFromWindow": ([wintypes.HWND, wintypes.DWORD], wintypes.HANDLE),
        "GetMonitorInfoW": ([wintypes.HANDLE, ctypes.POINTER(_MonitorInfo)], wintypes.BOOL),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(api, name)
        function.argtypes, function.restype = arguments, result
    return api

def is_foreground_fullscreen(pet_hwnd: int | None = None) -> bool:
    if os.name != "nt":
        return False
    return _foreground_fullscreen(_user32(), pet_hwnd)


def _foreground_fullscreen(user32, pet_hwnd: int | None) -> bool:
    hwnd = user32.GetForegroundWindow()
    if (not hwnd or hwnd == pet_hwnd or not user32.IsWindowVisible(hwnd)
            or user32.IsIconic(hwnd) or user32.IsZoomed(hwnd)):
        return False
    # A normal window's maximized outer frame can cover a whole monitor,
    # particularly with an auto-hidden taskbar. It is still not fullscreen.
    if user32.GetWindowLongPtrW(hwnd, -16) & 0x00C00000:  # GWL_STYLE / WS_CAPTION
        return False
    class_name = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, class_name, len(class_name))
    if class_name.value in {"Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"}:
        return False
    window_rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(window_rect)):
        return False
    monitor = user32.MonitorFromWindow(hwnd, 2)  # MONITOR_DEFAULTTONEAREST
    if not monitor:
        return False
    if pet_hwnd and user32.MonitorFromWindow(pet_hwnd, 2) != monitor:
        return False
    info = _MonitorInfo(cbSize=ctypes.sizeof(_MonitorInfo))
    if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        return False
    return covers_monitor(
        (window_rect.left, window_rect.top, window_rect.right, window_rect.bottom),
        (info.rcMonitor.left, info.rcMonitor.top, info.rcMonitor.right, info.rcMonitor.bottom),
    )
