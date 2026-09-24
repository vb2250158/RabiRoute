"""Headless full-desktop pixels shared by F1 and scheduled recording."""
import os
import sys
from PIL import ImageGrab


def _attach_interactive_desktop():
    if os.name != "nt":
        return
    try:
        import ctypes
        user32 = ctypes.windll.user32
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
    except Exception:
        pass


def capture_desktop_pixels():
    """Capture all monitors at native pixel resolution, without UI or storage."""
    _attach_interactive_desktop()
    try:
        captured = ImageGrab.grab(all_screens=True)
    except Exception:
        try:
            captured = ImageGrab.grab(all_screens=False)
        except Exception as err:
            raise RuntimeError(f"屏幕截图失败: {err}") from err

    if captured.width <= 0 or captured.height <= 0:
        raise RuntimeError("截图像素不可用。")
    return captured
