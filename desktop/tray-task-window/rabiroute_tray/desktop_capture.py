"""Headless full-desktop pixels shared by F1 and scheduled recording."""
from PIL import ImageGrab


def capture_desktop_pixels():
    """Capture all monitors at native pixel resolution, without UI or storage."""
    captured = ImageGrab.grab(all_screens=True)
    if captured.width <= 0 or captured.height <= 0:
        raise RuntimeError("截图像素不可用。")
    return captured
