import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image
from rabiroute_tray.desktop_capture import capture_desktop_pixels


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
