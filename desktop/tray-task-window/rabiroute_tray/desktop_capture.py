"""Headless full-desktop pixels shared by F1 and scheduled recording."""
import os
import sys
import threading
from PIL import ImageGrab

_capture_lock = threading.RLock()

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
