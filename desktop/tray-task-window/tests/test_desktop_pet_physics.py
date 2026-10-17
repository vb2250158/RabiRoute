import math
import os
import unittest
from unittest.mock import patch, MagicMock

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from PySide6.QtCore import QEvent, QPoint, QPointF, Qt
from PySide6.QtGui import QMouseEvent
from PySide6.QtTest import QSignalSpy
from PySide6.QtWidgets import QApplication
from rabiroute_tray.desktop_pet_physics import DisplayArea, PetFlight, ReleaseTrail
from rabiroute_tray.desktop_pet_window import DesktopPetWindow
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from types import SimpleNamespace


class FlightTest(unittest.TestCase):
    area = DisplayArea((0, 0, 1920, 1080), (0, 0, 1920, 1040))

    def trail(self, scale=1, fps=60):
        trail = ReleaseTrail()
        for i in range(round(fps * .16) + 1):
            t = i / fps
            trail.add(t, (1600 * t * scale, -800 * t * scale))
        return trail

    def test_fast_release_preserves_direction_and_caps_speed(self):
        vx, vy = self.trail().velocity(.16, 1)
        self.assertGreater(vx, 1000)
        self.assertAlmostEqual(vy / vx, -.5)
        self.assertLess(math.hypot(vx, vy), 3600)

    def test_held_still_and_slow_moves_do_not_throw(self):
        trail = self.trail()
        for i in range(1, 8):
            trail.add(.16 + i * .016, (256, -128))
        self.assertIsNone(trail.velocity(.272, 1))
        self.assertIsNone(self.trail(.1).velocity(.16, 1))
        self.assertIsNone(self.trail().velocity(1, 1))

    def test_scaled_pixels_and_sampling_rates_have_matching_velocity(self):
        for fps in (30, 60, 120, 1000):
            base = self.trail(1, fps).velocity(.16, 1)
            scaled = self.trail(1.5, fps).velocity(.16, 1.5)
            self.assertAlmostEqual(scaled[0] / base[0], 1.5)
            self.assertAlmostEqual(scaled[1] / base[1], 1.5)

    def test_release_history_is_bounded(self):
        self.assertLessEqual(len(self.trail(1, 10000).samples), 64)

    def test_flight_bounces_then_rests_above_taskbar(self):
        flight = PetFlight(1400, 300, 2200, -1000)
        bounced = False
        for i in range(1800):
            flight.advance(1/120, (256, 256), [self.area])
            bounced |= flight.vx < 0
            self.assertGreaterEqual(flight.x, 0)
            self.assertLessEqual(flight.x, 1664)
            self.assertGreaterEqual(flight.y, 0)
            self.assertLessEqual(flight.y, 784)
            if flight.at_rest:
                break
        self.assertTrue(bounced)
        self.assertTrue(flight.at_rest)
        self.assertEqual(flight.y, 784)
        self.assertLess(i / 120, 12)

    def test_adjacent_panels_pass_through_seam(self):
        left = DisplayArea((-1920, -200, 0, 1080), (-1920, -200, 0, 1040))
        flight = PetFlight(-300, 300, 2000, -200)
        for _ in range(30):
            flight.advance(1/120, (256, 256), [left, self.area])
        self.assertGreater(flight.x, 100)
        self.assertGreater(flight.vx, 0)

    def test_taskbar_strip_between_vertical_panels_is_not_a_wall(self):
        below = DisplayArea((0, 1080, 1920, 2160), (0, 1080, 1920, 2120))
        flight = PetFlight(700, 780, 0, 1200)
        for _ in range(40):
            flight.advance(1/120, (256, 256), [self.area, below])
        self.assertGreater(flight.y, 1080)
        self.assertGreater(flight.vy, 0)

    def test_gap_in_desktop_layout_bounces_instead_of_leaking(self):
        far = DisplayArea((2200, 0, 4000, 1080), (2200, 0, 4000, 1040))
        flight = PetFlight(1600, 200, 3400, 0)
        for _ in range(30):
            flight.advance(1/120, (128, 128), [self.area, far])
        self.assertLess(flight.x, 1792)
        self.assertLess(flight.vx, 0)

    def test_frame_rates_and_scale_preserve_trajectory(self):
        results = []
        for fps in (30, 60, 120):
            flight = PetFlight(300, 400, 1100, -500)
            for _ in range(round(.4 * fps)):
                flight.advance(1/fps, (256, 256), [self.area])
            results.append((flight.x, flight.y))
        for x, y in results:
            self.assertAlmostEqual(x, results[0][0], delta=.1)
            self.assertAlmostEqual(y, results[0][1], delta=.1)
        large = PetFlight(600, 800, 2200, -1000)
        display = DisplayArea((0,0,3840,2160), (0,0,3840,2080))
        for _ in range(48):
            large.advance(1/120, (512,512), [display])
        self.assertAlmostEqual(large.x / 2, results[0][0], delta=.1)
        self.assertAlmostEqual(large.y / 2, results[0][1], delta=.1)

    def test_stalled_frame_and_disconnected_monitors_are_bounded(self):
        flight = PetFlight(-4000, -4000, -3000, 1000)
        flight.advance(100, (256,256), [self.area])
        self.assertTrue(math.isfinite(flight.x))
        self.assertGreaterEqual(flight.x, 0)
        flight.advance(.016, (256,256), [])
        self.assertTrue(flight.at_rest)


class ThrowWindowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.window = DesktopPetWindow()
        self.window.show()
        self.window.resize(256, 256)
        self.native = MagicMock()
        self.cursor = (100, 100)
        self.bounds = (50, 50, 256, 256)
        self.native.sample.side_effect = lambda: (self.cursor, self.bounds)
        self.native.button_down.return_value = True
        self.native.move.return_value = True
        self.native.display_areas.return_value = [FlightTest.area]
        self.clock = 10.0
        self.native_patch = patch('rabiroute_tray.desktop_pet_window.NativeDrag.for_window', return_value=self.native)
        self.time_patch = patch('rabiroute_tray.desktop_pet_window.time.monotonic', side_effect=lambda: self.clock)
        self.native_patch.start()
        self.time_patch.start()

    def tearDown(self):
        self.window.close()
        self.time_patch.stop()
        self.native_patch.stop()

    def press(self):
        event = QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(50,50), QPointF(*self.cursor),
                            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
        with patch.object(self.window, 'grabMouse'):
            self.window.mousePressEvent(event)

    def throw(self):
        self.press()
        for _ in range(7):
            self.clock += .016
            self.cursor = self.cursor[0] + 28, self.cursor[1] - 12
            self.window._advance_drag()
        self.native.button_down.return_value = False
        self.window._finish_drag()

    def test_release_enters_flight_and_only_commits_once_at_rest(self):
        finished, placed = QSignalSpy(self.window.drag_finished), QSignalSpy(self.window.placement_changed)
        launched = QSignalSpy(self.window.flight_started)
        self.throw()
        self.assertEqual(launched.count(), 1)
        self.assertTrue(self.window.airborne)
        self.assertIsNotNone(self.window._flight)
        self.assertTrue(self.window.pointer_engaged)
        self.assertEqual(finished.count(), 0)
        for _ in range(1000):
            self.clock += .016
            self.window._advance_drag()
            if not self.window.pointer_engaged:
                break
        self.assertFalse(self.window.pointer_engaged)
        self.assertIsNone(self.window._flight)
        self.assertEqual(finished.count(), 1)
        self.assertEqual(placed.count(), 1)
        self.assertFalse(self.window._drag_timer.isActive())
        self.assertFalse(self.window.airborne)
        self.assertEqual(self.window._airborne_angle, 0)

    def test_flight_tilts_without_resizing_and_new_grab_resets_the_pose(self):
        self.throw()
        size = self.window.size()
        self.clock += .016
        self.window._advance_drag()
        self.assertGreater(abs(self.window._airborne_angle), .1)
        self.assertLessEqual(abs(self.window._airborne_angle), 16)
        self.assertEqual(self.window.size(), size)
        self.press()
        self.assertEqual(self.window._airborne_angle, 0)

    def test_grabbing_again_interrupts_flight_immediately(self):
        self.throw()
        self.press()
        self.assertIsNone(self.window._flight)
        self.assertTrue(self.window.pointer_engaged)
        self.assertEqual(len(self.window._release_trail.samples), 1)

    def test_hiding_cancels_without_saving_a_flight_position(self):
        placed = QSignalSpy(self.window.placement_changed)
        self.throw()
        self.window.hide()
        self.assertIsNone(self.window._flight)
        self.assertFalse(self.window.pointer_engaged)
        self.assertEqual(placed.count(), 0)

    def test_restoring_settings_during_flight_cannot_snap_back(self):
        self.throw()
        self.window.move(500,300)
        self.window.restore_placement({'xRatio':0, 'yRatio':0})
        self.window.recover_to_visible_screen()
        self.assertEqual(self.window.pos(), QPoint(500,300))

    def test_locking_or_enabling_click_through_cancels_flight(self):
        self.throw()
        self.window.apply_presentation_settings(scale=.5, opacity=1, always_on_top=True,
                                                locked=True, bubble_enabled=True, fps_cap=15)
        self.assertIsNone(self.window._flight)
        self.assertFalse(self.window.pointer_engaged)
        self.window._locked = False
        self.native.button_down.return_value = True
        self.throw()
        self.window.set_click_through(True)
        self.assertIsNone(self.window._flight)
        self.assertFalse(self.window.pointer_engaged)

    def test_one_shot_animation_completion_cannot_replace_airborne_drag(self):
        self.throw()
        controller = SimpleNamespace(window=self.window, _pack=None, _requested_state='drag', _resume_context=MagicMock())
        DesktopPetController._animation_finished(controller, 'idle')
        controller._resume_context.assert_not_called()

    def test_native_move_failure_cancels_without_a_saved_landing(self):
        placed = QSignalSpy(self.window.placement_changed)
        self.throw()
        self.native.move.return_value = False
        self.clock += .016
        self.window._advance_drag()
        self.assertFalse(self.window.pointer_engaged)
        self.assertIsNone(self.window._flight)
        self.assertEqual(placed.count(), 0)


if __name__ == '__main__':
    unittest.main()
