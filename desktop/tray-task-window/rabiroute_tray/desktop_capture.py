"""Headless full-desktop pixels shared by F1 and scheduled recording."""
import os
import sys
import threading
import logging
from PIL import Image, ImageGrab

_capture_lock = threading.RLock()
_region_fallback_logged = False


def _capture_windows_region(bounds):
    """Read visible desktop pixels for a physical-coordinate rectangle."""
    import ctypes
    from ctypes import wintypes

    class BitmapInfoHeader(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("width", wintypes.LONG),
                    ("height", wintypes.LONG), ("planes", wintypes.WORD),
                    ("bit_count", wintypes.WORD), ("compression", wintypes.DWORD),
                    ("size_image", wintypes.DWORD), ("x_pixels", wintypes.LONG),
                    ("y_pixels", wintypes.LONG), ("colors_used", wintypes.DWORD),
                    ("colors_important", wintypes.DWORD)]

    class BitmapInfo(ctypes.Structure):
        _fields_ = [("header", BitmapInfoHeader), ("colors", wintypes.DWORD * 3)]

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    user32.GetDC.argtypes = [wintypes.HWND]
    user32.GetDC.restype = wintypes.HDC
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi32.CreateCompatibleDC.restype = wintypes.HDC
    gdi32.DeleteDC.argtypes = [wintypes.HDC]
    gdi32.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.POINTER(BitmapInfo), wintypes.UINT,
                                       ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
    gdi32.CreateDIBSection.restype = wintypes.HBITMAP
    gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HANDLE]
    gdi32.SelectObject.restype = wintypes.HANDLE
    gdi32.DeleteObject.argtypes = [wintypes.HANDLE]
    gdi32.BitBlt.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                             wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.DWORD]
    gdi32.BitBlt.restype = wintypes.BOOL
    gdi32.GdiFlush.restype = wintypes.BOOL

    left, top, right, bottom = bounds
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0:
        raise ValueError("截图区域为空。")
    screen = user32.GetDC(None)
    if not screen:
        raise RuntimeError("无法获取屏幕设备上下文。")
    memory = bitmap = previous = None
    try:
        memory = gdi32.CreateCompatibleDC(screen)
        if not memory:
            raise RuntimeError("无法创建截图设备上下文。")
        info = BitmapInfo()
        info.header.size = ctypes.sizeof(BitmapInfoHeader)
        info.header.width, info.header.height = width, -height
        info.header.planes, info.header.bit_count = 1, 32
        bits = ctypes.c_void_p()
        bitmap = gdi32.CreateDIBSection(screen, ctypes.byref(info), 0, ctypes.byref(bits), None, 0)
        if not bitmap or not bits.value:
            raise RuntimeError("无法创建截图位图。")
        previous = gdi32.SelectObject(memory, bitmap)
        if not previous or previous == ctypes.c_void_p(-1).value:
            previous = None
            raise RuntimeError("无法选中截图位图。")
        if not gdi32.BitBlt(memory, 0, 0, width, height, screen, left, top, 0x00CC0020):
            raise RuntimeError("屏幕区域读取失败。")
        if not gdi32.GdiFlush():
            raise RuntimeError("屏幕区域读取未完成。")
        pixels = ctypes.string_at(bits, width * height * 4)
        return Image.frombytes("RGB", (width, height), pixels, "raw", "BGRX")
    finally:
        if previous:
            gdi32.SelectObject(memory, previous)
        if bitmap:
            gdi32.DeleteObject(bitmap)
        if memory:
            gdi32.DeleteDC(memory)
        user32.ReleaseDC(None, screen)


def _virtual_desktop_bounds():
    import ctypes
    user32 = ctypes.windll.user32
    left, top = user32.GetSystemMetrics(76), user32.GetSystemMetrics(77)
    return left, top, left + user32.GetSystemMetrics(78), top + user32.GetSystemMetrics(79)


def capture_desktop_region(bounds):
    """Capture a visible physical-coordinate region without reading other monitors."""
    global _region_fallback_logged
    with _capture_lock:
        detach = _attach_interactive_desktop()
        try:
            if os.name == "nt":
                origin_x, origin_y, desktop_right, desktop_bottom = _virtual_desktop_bounds()
                left, top, right, bottom = bounds
                bounds = (max(left, origin_x), max(top, origin_y),
                          min(right, desktop_right), min(bottom, desktop_bottom))
                if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
                    return None
                try:
                    return _capture_windows_region(bounds)
                except (OSError, RuntimeError) as error:
                    if not _region_fallback_logged:
                        logging.getLogger(__name__).warning("区域截图失败，回退到全屏截图: %s", error)
                        _region_fallback_logged = True
                    desktop = ImageGrab.grab(all_screens=True)
                    try:
                        left, top, right, bottom = bounds
                        return desktop.crop((left - origin_x, top - origin_y,
                                             right - origin_x, bottom - origin_y))
                    finally:
                        desktop.close()
            return ImageGrab.grab(bbox=bounds, all_screens=True)
        finally:
            detach()

def _attach_interactive_desktop():
    if os.name != "nt":
        return lambda: None
    try:
        import ctypes
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        for name in ("GetProcessWindowStation", "OpenWindowStationW", "GetThreadDesktop", "OpenInputDesktop", "OpenDesktopW"):
            getattr(user32, name).restype = ctypes.c_void_p
        for name in ("SetProcessWindowStation", "SetThreadDesktop", "CloseWindowStation", "CloseDesktop"):
            getattr(user32, name).argtypes = [ctypes.c_void_p]
        previous_station = user32.GetProcessWindowStation()
        previous_desktop = user32.GetThreadDesktop(kernel32.GetCurrentThreadId())
        # Ensure Process is connected to WinSta0 (Interactive WindowStation)
        hwinsta = user32.OpenWindowStationW("WinSta0", False, 0x37F)
        if hwinsta:
            user32.SetProcessWindowStation(hwinsta)
        # Try to attach current thread to the active Input Desktop or Default Desktop
        hdesk = user32.OpenInputDesktop(0, False, 0x1FF) or user32.OpenDesktopW("Default", 0, False, 0x1FF)
        if hdesk:
            user32.SetThreadDesktop(hdesk)
        # Set per-monitor DPI awareness if available
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass
        def detach():
            # A continuous recorder must release every opened native handle.
            # Restore borrowed handles before closing handles we own.
            if hdesk:
                user32.SetThreadDesktop(previous_desktop)
                user32.CloseDesktop(hdesk)
            if hwinsta:
                user32.SetProcessWindowStation(previous_station)
                user32.CloseWindowStation(hwinsta)
        return detach
    except Exception:
        return lambda: None


def capture_desktop_pixels():
    """Capture all monitors at native pixel resolution, without UI or storage."""
    with _capture_lock:
        detach = _attach_interactive_desktop()
        try:
            try:
                captured = ImageGrab.grab(all_screens=True)
            except Exception:
                try:
                    captured = ImageGrab.grab(all_screens=False)
                except Exception as err:
                    raise RuntimeError(f"屏幕截图失败: {err}") from err
        finally:
            detach()

    if captured.width <= 0 or captured.height <= 0:
        raise RuntimeError("截图像素不可用。")
    return captured
