import os
import ctypes
import unittest
from ctypes import wintypes
from dataclasses import replace
from unittest.mock import MagicMock, patch

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from PySide6.QtCore import QEvent, QSize
from PySide6.QtTest import QSignalSpy
from PySide6.QtWidgets import QApplication
from pet_motion_fixture import walking_animation
from rabiroute_tray.desktop_pet_window import DesktopPetWindow
from rabiroute_tray.desktop_pet_drag import NativeDrag, preserve_dpi_size


class PixelSizeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.window = DesktopPetWindow()
        self.window.show()
        self.native = MagicMock()
        self.bounds = [400, 300, 256, 256]
        self.native.sample.side_effect = lambda: ((450,350), tuple(self.bounds))
        def resize(width,height):
            self.bounds[2:] = width,height
            return True
        self.native.resize.side_effect = resize
        self.native.move.return_value = True
        self.native_patch = patch('rabiroute_tray.desktop_pet_window.NativeDrag.for_window', return_value=self.native)
        self.native_patch.start()
        self.ratio = 1.0
        self.dpi_patch = patch.object(self.window,'devicePixelRatioF', side_effect=lambda:self.ratio)
        self.dpi_patch.start()
        self.pack,self.animation = walking_animation()
        self.window.play(self.pack,self.animation)

    def tearDown(self):
        self.window.close()
        self.dpi_patch.stop()
        self.native_patch.stop()

    def test_monitor_dpi_changes_preserve_native_pixels_frames_and_direction(self):
        frames = self.window._png_frames
        self.window._png_index = 2
        self.window._facing_left = True
        for ratio in (1.5,1.75,2,1.25,1):
            self.ratio = ratio
            self.window._sync_pixel_size()
            self.assertEqual(self.bounds[2:], [256,256])
            self.assertEqual(self.window.width(), round(256 / ratio))
            self.assertIs(self.window._png_frames,frames)
            self.assertEqual(self.window._png_index,2)
            self.assertTrue(self.window._facing_left)
            pixmap=self.window._label.pixmap()
            self.assertAlmostEqual(pixmap.deviceIndependentSize().width(),256 / ratio,delta=1)

    def test_preview_scales_pixels_without_redecoding_or_restarting_playback(self):
        frames=self.window._png_frames
        self.window._png_index=2
        self.ratio=1.5
        with patch.object(self.window,'_decode_png_frames',side_effect=AssertionError('Preview redecoded frames')):
            for scale in (.75,1,.25):
                self.window.set_scale_preview(scale)
                expected=round(512*scale)
                self.assertEqual(self.bounds[2:],[expected,expected])
                self.assertAlmostEqual(self.window._label.pixmap().deviceIndependentSize().width(),expected / self.ratio,delta=1)
                self.assertEqual(self.window._png_index,2)
                self.assertIs(self.window._png_frames,frames)
        self.window.set_scale_preview(None)
        self.assertEqual(self.bounds[2:],[256,256])
        self.assertEqual(self.window._scale,.5)

    def test_gait_keeps_the_same_physical_stride_on_all_dpi_values(self):
        stride=self.window._gait.cycle_distance
        for ratio in (1.5,1.75,2,1):
            self.ratio=ratio
            self.window._sync_pixel_size()
            self.assertAlmostEqual(self.window._gait.cycle_distance*ratio,stride)

    def test_dpi_event_syncs_before_repaint_without_playing_another_action(self):
        with patch.object(self.window,'play') as play:
            with patch.object(self.window,'_sync_pixel_size') as sync:
                self.window.event(QEvent(QEvent.Type.DevicePixelRatioChange))
                sync.assert_called_once()
            play.assert_not_called()

    def test_native_size_change_preserves_64_bit_handle_and_focus(self):
        with patch('rabiroute_tray.desktop_pet_drag._drag_user32') as factory:
            factory.return_value.SetWindowPos.return_value=True
            adapter=NativeDrag(0x100000001)
            self.assertTrue(adapter.resize(256,256))
            factory.return_value.SetWindowPos.assert_called_once_with(0x100000001,None,0,0,256,256,0x0216)

    @unittest.skipUnless(os.name == 'nt', 'Windows message layout')
    def test_dpi_suggestion_retains_physical_size_and_negative_desktop_origin(self):
        bounds = wintypes.RECT(-1800,-200,-1416,184)
        message = wintypes.MSG()
        message.message = 0x02E0
        message.lParam = ctypes.addressof(bounds)
        preserve_dpi_size(ctypes.addressof(message), (256,256))
        self.assertEqual((bounds.left,bounds.top,bounds.right,bounds.bottom),(-1800,-200,-1544,56))
        message.message = 0x0046
        preserve_dpi_size(ctypes.addressof(message),(512,512))
        self.assertEqual((bounds.right,bounds.bottom),(-1544,56))


if __name__=='__main__':
    unittest.main()
