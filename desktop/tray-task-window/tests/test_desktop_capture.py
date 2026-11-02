import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image
from rabiroute_tray.desktop_capture import capture_desktop_pixels, capture_desktop_region


class DesktopCaptureTests(unittest.TestCase):
    def test_native_pixels_preserved(self):
        pixels = Image.new("RGB", (4000, 1200))
        with patch("PIL.ImageGrab.grab", return_value=pixels) as grab:
            self.assertIs(capture_desktop_pixels(), pixels)
        grab.assert_called_once_with(all_screens=True)

    def test_empty_capture_rejected(self):
        with patch("PIL.ImageGrab.grab", return_value=Image.new("RGB", (0, 0))):
            with self.assertRaises(RuntimeError):
                capture_desktop_pixels()

    @unittest.skipUnless(sys.platform == "win32", "Windows region capture")
    def test_region_capture_preserves_negative_coordinates_and_detaches(self):
        from unittest.mock import Mock
        pixels = Image.new("RGB", (64, 32))
        detach = Mock()
        with patch("rabiroute_tray.desktop_capture._attach_interactive_desktop", return_value=detach), \
                patch("rabiroute_tray.desktop_capture._virtual_desktop_bounds", return_value=(-200, -100, 200, 100)), \
                patch("rabiroute_tray.desktop_capture._capture_windows_region", return_value=pixels) as grab:
            self.assertIs(capture_desktop_region((-100, -20, -36, 12)), pixels)
        grab.assert_called_once_with((-100, -20, -36, 12))
        detach.assert_called_once_with()

    @unittest.skipUnless(sys.platform == "win32", "Windows region capture")
    def test_region_capture_clips_to_virtual_desktop(self):
        pixels = Image.new("RGB", (20, 10))
        with patch("rabiroute_tray.desktop_capture._attach_interactive_desktop", return_value=lambda: None), \
                patch("rabiroute_tray.desktop_capture._virtual_desktop_bounds", return_value=(-100, -50, 100, 50)), \
                patch("rabiroute_tray.desktop_capture._capture_windows_region", return_value=pixels) as grab:
            self.assertIs(capture_desktop_region((-120, -60, -80, -40)), pixels)
            self.assertIsNone(capture_desktop_region((120, 0, 140, 10)))
        grab.assert_called_once_with((-100, -50, -80, -40))

    @unittest.skipUnless(sys.platform == "win32", "Windows region capture")
    def test_region_capture_detaches_after_failure(self):
        from unittest.mock import Mock
        detach = Mock()
        with patch("rabiroute_tray.desktop_capture._attach_interactive_desktop", return_value=detach), \
                patch("rabiroute_tray.desktop_capture._virtual_desktop_bounds", return_value=(0, 0, 100, 100)), \
                patch("rabiroute_tray.desktop_capture._capture_windows_region", side_effect=RuntimeError("failed")), \
                patch("PIL.ImageGrab.grab", side_effect=RuntimeError("failed")):
            with self.assertRaisesRegex(RuntimeError, "failed"):
                capture_desktop_region((0, 0, 10, 10))
        detach.assert_called_once_with()

    @unittest.skipUnless(sys.platform == "win32", "Windows region capture")
    def test_region_capture_falls_back_to_matching_full_desktop_crop(self):
        import ctypes
        x = ctypes.windll.user32.GetSystemMetrics(76)
        y = ctypes.windll.user32.GetSystemMetrics(77)
        desktop = Image.new("RGB", (100, 80), "red")
        with patch("rabiroute_tray.desktop_capture._attach_interactive_desktop", return_value=lambda: None), \
                patch("rabiroute_tray.desktop_capture._virtual_desktop_bounds", return_value=(x, y, x + 100, y + 80)), \
                patch("rabiroute_tray.desktop_capture._capture_windows_region", side_effect=RuntimeError("failed")), \
                patch("PIL.ImageGrab.grab", return_value=desktop) as grab:
            result = capture_desktop_region((x + 10, y + 15, x + 30, y + 25))
        self.assertEqual(result.size, (20, 10))
        self.assertEqual(result.getpixel((0, 0)), (255, 0, 0))
        grab.assert_called_once_with(all_screens=True)

    @unittest.skipUnless(sys.platform == "win32", "Windows foreground capture")
    def test_companion_requests_foreground_bounds(self):
        import ctypes
        from types import SimpleNamespace
        from rabiroute_tray.desktop_pet_companion import foreground_observation

        user32 = ctypes.windll.user32
        user32.GetForegroundWindow.restype = ctypes.c_void_p
        handle = user32.GetForegroundWindow()
        self.assertTrue(handle)
        left, top = user32.GetSystemMetrics(76), user32.GetSystemMetrics(77)
        window = SimpleNamespace(handle=handle, bounds=(left - 20, top - 20, left + 64, top + 32))
        pixels = Image.new("RGB", (64, 32), "red")
        with patch("rabiroute_tray.desktop_pet_companion.foreground_window", return_value=window), \
                patch("rabiroute_tray.desktop_pet_companion.capture_desktop_region", return_value=pixels) as grab, \
                patch("rabiroute_tray.desktop_pet_companion.foreground_media_evidence", return_value=None):
            result = foreground_observation(7)
        grab.assert_called_once_with(window.bounds)
        self.assertEqual(result["sequence"], 7)
        self.assertTrue(result["jpeg"])

    @unittest.skipUnless(sys.platform == "win32", "Windows F1 capture")
    def test_f1_converts_shared_pixels_to_owned_qimage(self):
        from rabiroute_tray.system_screenshot import capture_desktop_image_async
        with patch("PIL.ImageGrab.grab", return_value=Image.new("RGB", (64, 32), "red")) as grab:
            image = capture_desktop_image_async()
        grab.assert_called_once_with(all_screens=True)
        self.assertEqual((image.width(), image.height()), (64, 32))
        self.assertEqual(image.pixelColor(0, 0).name(), "#ff0000")


if __name__ == "__main__":
    unittest.main()
