import math
import os
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from PySide6.QtCore import QEvent, QPoint, QPointF, QRect, Qt
from PySide6.QtGui import QMouseEvent
from PySide6.QtTest import QSignalSpy
from PySide6.QtWidgets import QApplication
from rabiroute_tray.desktop_pet_drag import DragFollow, NativeDrag
from rabiroute_tray.desktop_pet_physics import ReleaseTrail
from rabiroute_tray.desktop_pet_window import DesktopPetWindow
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from pet_motion_fixture import walking_animation


class DragGeometryTest(unittest.TestCase):
    def test_negative_origin_and_dpi_resize_keep_the_grab_anchor(self):
        follow = DragFollow.begin((80, 100), (0, 0, 256, 256))
        for _ in range(40): position = follow.advance((-500, -100), (384, 384), .016)
        self.assertEqual(position, (-620, -250))
        for _ in range(40): position = follow.advance((300, 200), (256, 256), .016)
        self.assertEqual(position, (220, 100))

    def test_spring_is_independent_of_event_rate_and_does_not_overshoot(self):
        results = []
        for fps in (30, 60, 120):
            follow = DragFollow.begin((20, 20), (0, 0, 200, 200))
            previous = 0
            for _ in range(round(fps * .4)):
                x, y = follow.advance((320, 220), (200, 200), 1 / fps)
                self.assertGreaterEqual(x, previous)
                self.assertLessEqual(x, 300)
                previous = x
            results.append((x, y))
        self.assertEqual(results, [(300, 200)] * 3)

    def test_stalled_callback_has_finite_bounded_catchup(self):
        follow = DragFollow.begin((0, 0), (0, 0, 200, 200))
        follow.advance((2000, 0), (200, 200), 100)
        self.assertTrue(math.isfinite(follow.x))
        self.assertGreater(follow.x, 0)
        self.assertLess(follow.x, 2000)

    def test_native_adapter_preserves_64_bit_handle_and_window_flags(self):
        with patch('rabiroute_tray.desktop_pet_drag._drag_user32') as create:
            api = create.return_value
            def cursor(pointer):
                pointer._obj.x, pointer._obj.y = -1200, 400
                return True
            def bounds(handle, pointer):
                pointer._obj.left, pointer._obj.top = -1300, 300
                pointer._obj.right, pointer._obj.bottom = -1000, 600
                return True
            api.GetCursorPos.side_effect = cursor
            api.GetWindowRect.side_effect = bounds
            api.GetAsyncKeyState.return_value = -32768
            api.SetWindowPos.return_value = True
            drag = NativeDrag(0x100000001)
            self.assertEqual(drag.sample(), ((-1200, 400), (-1300, 300, 300, 300)))
            self.assertTrue(drag.button_down())
            self.assertTrue(drag.move(-1400, 200))
            api.SetWindowPos.assert_called_once_with(0x100000001, None, -1400, 200, 0, 0, 0x0215)


class DragWindowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.window = DesktopPetWindow()
        self.window.show()
        self.native = MagicMock()
        self.cursor, self.bounds = (50, 50), (0, 0, 256, 256)
        self.native.sample.side_effect = lambda: (self.cursor, self.bounds)
        self.native.button_down.return_value = True
        self.native.move.return_value = True
        self.native_patch = patch('rabiroute_tray.desktop_pet_window.NativeDrag.for_window', return_value=self.native)
        self.native_patch.start()
        # These cases exercise gentle placement; throwing has its own flight tests.
        self.velocity_patch = patch.object(ReleaseTrail, "velocity", return_value=None)
        self.velocity_patch.start()
        self.grab_patch = patch.object(self.window, 'grabMouse')
        self.grab_patch.start()

    def tearDown(self):
        self.window.close()
        self.grab_patch.stop()
        self.native_patch.stop()
        self.velocity_patch.stop()

    def press(self):
        event = QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(50, 50), QPointF(50, 50),
                            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
        self.window.mousePressEvent(event)

    def tick(self):
        with patch('rabiroute_tray.desktop_pet_window.time.monotonic', return_value=self.window._drag_last_tick + .016):
            self.window._advance_drag()

    def test_native_cursor_drives_drag_without_any_mouse_move_events(self):
        started = QSignalSpy(self.window.drag_started)
        self.press()
        self.cursor = (-800, 300)
        for _ in range(35): self.tick()
        self.assertEqual(started.count(), 1)
        self.assertTrue(self.window.pointer_engaged)
        x, y = self.native.move.call_args.args
        self.assertEqual((x, y), (-850, 250))

    def test_drag_animation_and_settings_cannot_snap_back_to_a_screen(self):
        self.press()
        self.window.move(790, 100)
        expected = self.window.pos()
        pack, move = walking_animation()
        drag = replace(move, state=replace(move.state, name='drag'))
        self.window.play(pack, drag)
        self.window.restore_placement({'screen': '', 'xRatio': 0, 'yRatio': 0})
        self.window.recover_to_visible_screen()
        self.assertEqual(self.window.pos(), expected)

    def test_release_outside_window_finishes_once_and_stops_following(self):
        finished = QSignalSpy(self.window.drag_finished)
        placed = QSignalSpy(self.window.placement_changed)
        self.press()
        self.cursor = (-800, 300)
        self.tick()
        self.native.button_down.return_value = False
        for _ in range(20): self.tick()
        self.assertFalse(self.window.pointer_engaged)
        self.assertFalse(self.window._drag_timer.isActive())
        self.assertEqual(finished.count(), 1)
        self.assertEqual(placed.count(), 1)

    def test_release_settles_to_the_release_point_without_following_later_cursor_motion(self):
        self.press()
        self.cursor = (-800, 300)
        self.tick()
        self.window._finish_drag()
        self.cursor = (2000, 1000)
        for _ in range(9): self.tick()
        x, y = self.native.move.call_args.args
        self.assertLess(x, 0)
        self.assertAlmostEqual(y, 250, delta=15)
        for _ in range(20): self.tick()
        self.assertFalse(self.window.pointer_engaged)

    def test_hide_cancels_pointer_capture_without_saving_a_drop(self):
        placed = QSignalSpy(self.window.placement_changed)
        self.press()
        self.cursor = (100, 100)
        self.tick()
        self.window.hide()
        self.assertFalse(self.window.pointer_engaged)
        self.assertFalse(self.window._drag_timer.isActive())
        self.assertEqual(placed.count(), 0)

    def test_small_pointer_jitter_remains_a_click(self):
        started = QSignalSpy(self.window.drag_started)
        self.press()
        self.cursor = (51, 51)
        self.tick()
        self.native.move.assert_not_called()
        self.assertEqual(started.count(), 0)
        self.native.button_down.return_value = False
        self.tick()
        self.assertFalse(self.window.pointer_engaged)

    def test_fullscreen_hiding_is_deferred_until_the_grab_finishes(self):
        controller = SimpleNamespace(window=self.window, _fullscreen_timer=MagicMock())
        self.press()
        with patch('rabiroute_tray.desktop_pet_controller.is_foreground_fullscreen') as detect:
            DesktopPetController._reconcile_fullscreen_visibility(controller)
            detect.assert_not_called()

    def test_same_named_monitors_round_trip_to_the_correct_display(self):
        first, second = MagicMock(), MagicMock()
        for screen, area in [(first, QRect(0, 0, 1200, 900)), (second, QRect(1200, 0, 1200, 900))]:
            screen.name.return_value = 'Same model'
            screen.geometry.return_value = area
            screen.availableGeometry.return_value = area
        self.window.resize(200, 200)
        self.window.move(1500, 100)
        with patch.object(QApplication, 'screens', return_value=[first, second]), patch.object(QApplication, 'screenAt', return_value=second):
            placement = self.window.placement()
            self.assertEqual(placement['screen'], 'Same model [1200,0]')
            self.window.move(0, 0)
            self.window.restore_placement(placement)
            self.assertEqual(self.window.pos(), QPoint(1500, 100))

    def test_legacy_plain_screen_name_still_restores(self):
        screen = MagicMock()
        screen.name.return_value = 'Unique model'
        screen.geometry.return_value = QRect(-1200, 0, 1200, 900)
        screen.availableGeometry.return_value = QRect(-1200, 0, 1200, 900)
        self.window.resize(200, 200)
        with patch.object(QApplication, 'screens', return_value=[screen]):
            self.window.restore_placement({'screen': 'Unique model', 'xRatio': .5, 'yRatio': .5})
            self.assertEqual(self.window.pos(), QPoint(-700, 350))
            self.assertEqual(self.window._screen_key(screen), 'Unique model')


if __name__ == '__main__':
    unittest.main()
