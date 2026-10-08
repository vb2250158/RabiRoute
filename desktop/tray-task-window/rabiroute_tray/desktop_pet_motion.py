"""Foreground geometry and travel decisions; no window focus or application control."""
from __future__ import annotations

import ctypes
import math
import os
from ctypes import wintypes
from dataclasses import dataclass


@dataclass(frozen=True)
class ForegroundWindow:
    handle: int
    bounds: tuple[int, int, int, int]
    screen_name: str
    monitor_bounds: tuple[int, int, int, int]


def foreground_window() -> ForegroundWindow | None:
    if os.name != "nt":
        return None
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.MonitorFromWindow.restype = wintypes.HANDLE
    hwnd = user32.GetForegroundWindow()
    if not hwnd or not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd):
        return None
    process_id = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
    if process_id.value == os.getpid():
        return None
    class_name = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, class_name, len(class_name))
    if class_name.value in {"Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"}:
        return None
    rect = wintypes.RECT()
    # DWM's visible frame is expressed in physical pixels, including mixed DPI desktops.
    dwmapi = ctypes.WinDLL("dwmapi")
    dwmapi.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
    cloaked = wintypes.DWORD()
    if dwmapi.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked)) == 0 and cloaked.value:
        return None
    if dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect)) != 0:
        return None
    if rect.right <= rect.left or rect.bottom <= rect.top:
        return None

    class MonitorInfo(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                    ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD), ("szDevice", wintypes.WCHAR * 32)]

    monitor = user32.MonitorFromWindow(hwnd, 2)
    info = MonitorInfo(cbSize=ctypes.sizeof(MonitorInfo))
    user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MonitorInfo)]
    if not monitor or not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        return None
    return ForegroundWindow(int(hwnd), (rect.left, rect.top, rect.right, rect.bottom), info.szDevice,
                            (info.rcMonitor.left, info.rcMonitor.top, info.rcMonitor.right, info.rcMonitor.bottom))


def logical_bounds(window: ForegroundWindow, screen: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """Convert native physical pixels using the owning Qt screen, preserving negative origins."""
    left, top, right, bottom = window.monitor_bounds
    x, y, width, height = screen
    scale_x, scale_y = width / (right - left), height / (bottom - top)
    wl, wt, wr, wb = window.bounds
    return (round(x + (wl - left) * scale_x), round(y + (wt - top) * scale_y),
            round(x + (wr - left) * scale_x), round(y + (wb - top) * scale_y))


def matches_monitor(monitor: tuple[int, int, int, int], screen: tuple[int, int, int, int], pixel_ratio: float) -> bool:
    """Qt may expose a friendly monitor name instead of the Win32 device name."""
    left, top, right, bottom = monitor
    x, y, width, height = screen
    return (abs(x - left) <= 2 and abs(y - top) <= 2
            and abs(width * pixel_ratio - (right - left)) <= 2
            and abs(height * pixel_ratio - (bottom - top)) <= 2)


def corner_positions(bounds: tuple[int, int, int, int], work_area: tuple[int, int, int, int],
                     size: tuple[int, int], corners: tuple[str, ...], inset: int = 12) -> dict[str, tuple[int, int]]:
    left, top, right, bottom = bounds
    ax, ay, aw, ah = work_area
    width, height = size
    positions = {
        "bottom-right": (right - width - inset, bottom - height - inset),
        "bottom-left": (left + inset, bottom - height - inset),
        "top-right": (right - width - inset, top + inset),
        "top-left": (left + inset, top + inset),
    }
    return {corner: (max(ax, min(x, ax + max(0, aw - width))),
                     max(ay, min(y, ay + max(0, ah - height))))
            for corner, (x, y) in positions.items() if corner in corners}


def travel_kind(same_screen: bool, origin: tuple[int, int], destination: tuple[int, int],
                screen_size: tuple[int, int]) -> str:
    # A nearby destination across a monitor edge is still a walk. One screen's
    # diagonal is the longest ordinary travel distance within that screen.
    distance = math.dist(origin, destination)
    return "move" if same_screen or distance <= math.hypot(*screen_size) else "teleport"
