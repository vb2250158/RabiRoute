from __future__ import annotations

import os
import base64
import time
import unittest
from unittest.mock import patch
from dataclasses import replace

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QPoint
from PySide6.QtTest import QSignalSpy, QTest
from PySide6.QtWidgets import QApplication

from rabiroute_tray.desktop_pet_client import DesktopPetBinding, DesktopPetPack, DesktopPetState, LoadedDesktopPetAnimation, parse_desktop_pet_binding
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_motion import ForegroundWindow, corner_positions, logical_bounds, matches_monitor, travel_kind
from rabiroute_tray.desktop_pet_window import DesktopPetWindow
from rabiroute_tray.desktop_pet_gait import SoleFrame, walking_gait
from pet_motion_fixture import play_walk, finish_walk, walking_animation, advance_walk


class DesktopPetMotionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_binding_keeps_nested_wander_choices_and_wait_interval(self):
        binding = parse_desktop_pet_binding({"wanderEnabled": True, "wanderToActiveWindow": True,
                                             "wanderCorners": ["top-left", "unknown", "top-left"],
                                             "wanderWaitMinSeconds": 120, "wanderWaitMaxSeconds": 10})
        self.assertTrue(binding.wander_enabled)
        self.assertTrue(binding.wander_to_active_window)
        self.assertEqual(binding.wander_corners, ("top-left",))
        self.assertEqual(binding.wander_wait_max_seconds, 120)
        self.assertEqual(parse_desktop_pet_binding({"wanderCorners": []}).wander_corners, ())
        self.assertFalse(parse_desktop_pet_binding({}).wander_enabled)

    def test_selected_corners_clamp_small_and_offscreen_windows(self):
        positions = corner_positions((-400, -200, 500, 400), (0, 0, 800, 600), (256, 256),
                                     ("top-left", "bottom-right"))
        self.assertEqual(positions, {"bottom-right": (232, 132), "top-left": (0, 0)})
        self.assertEqual(corner_positions((0, 0, 10, 10), (0, 0, 80, 60), (256, 256), ("bottom-right",)),
                         {"bottom-right": (0, 0)})
        self.assertEqual(corner_positions((0, 0, 100, 100), (0, 0, 800, 600), (64, 64), ()), {})

    def test_mixed_dpi_conversion_preserves_left_screen_origin(self):
        native = ForegroundWindow(1, (-1920, 0, -960, 720), "secondary", (-1920, 0, 0, 1080))
        self.assertEqual(logical_bounds(native, (-1280, 0, 1280, 720)), (-1280, 0, -640, 480))
        self.assertTrue(matches_monitor((-3840, -707, 0, 1453), (-3840, -707, 2560, 1440), 1.5))
        self.assertFalse(matches_monitor((-3840, -707, 0, 1453), (0, 0, 2560, 1440), 1.5))

    def test_nearby_monitor_edge_walks_and_more_than_one_screen_teleports(self):
        self.assertEqual(travel_kind(True, (0, 0), (1920, 1080), (1920, 1080)), "move")
        self.assertEqual(travel_kind(False, (1900, 100), (1950, 100), (1920, 1080)), "move")
        self.assertEqual(travel_kind(False, (-1920, 0), (-640, 720), (1280, 720)), "move")
        self.assertEqual(travel_kind(False, (0, 0), (3000, 100), (1920, 1080)), "teleport")

    def test_wander_waits_then_reads_foreground_and_respects_pause_conditions(self):
        with (patch.object(DesktopPetEventStream, "start"), patch.object(DesktopPetEventStream, "stop"),
              patch.object(DesktopPetController, "_load_binding"), patch.object(DesktopPetController, "_load_catalog")):
            controller = DesktopPetController("http://127.0.0.1:1", "sample", lambda _: None)
            try:
                controller._pack = DesktopPetPack("sample", "Sample", "sample", 512, 512, 0.5, {
                    "idle": DesktopPetState("idle", "png-sequence", ("/idle.png",), 12, True),
                    "move": DesktopPetState("move", "png-sequence", ("/move.png",), 12, True)})
                binding = DesktopPetBinding(enabled=True, pack_id="sample", wander_enabled=True,
                                            wander_to_active_window=True, wander_corners=("top-left",),
                                            wander_wait_min_seconds=8, wander_wait_max_seconds=13)
                screen = self.app.primaryScreen()
                x, y, width, height = screen.geometry().getRect()
                native = ForegroundWindow(1, (x + 100, y + 100, x + 600, y + 600), "Win32-device-name",
                                          (x, y, x + width, y + height))
                with patch("rabiroute_tray.desktop_pet_controller.foreground_window", return_value=native) as foreground:
                    with patch.object(controller._random, "uniform", return_value=10) as delay:
                        controller._apply_binding(binding)
                        delay.assert_called_with(8, 13)
                        self.assertEqual(controller._wander_timer.interval(), 10000)
                    foreground.assert_not_called()
                    controller.window.move(x + 10, y + 10)
                    with patch.object(controller, "_is_action_ready", return_value=True), patch.object(controller.window, "travel_to") as travel:
                        controller._attempt_wander()
                        foreground.assert_called_once()
                        travel.assert_called_once_with(QPoint(x + 112, y + 112), "move")
                        travel.reset_mock()
                        for paused in (replace(binding, locked=True), replace(binding, wander_enabled=False), replace(binding, wander_corners=())):
                            controller._binding_snapshot = paused
                            controller._attempt_wander()
                        travel.assert_not_called()
                        controller._binding_snapshot = binding
                        controller._requested_state = "sleep"
                        controller._attempt_wander()
                        travel.assert_not_called()
                    controller._requested_state = "idle"
                    with patch.object(controller, "_is_action_ready", return_value=False), patch.object(controller.window, "travel_to") as travel:
                        controller._attempt_wander()
                        travel.assert_not_called()
                    controller._manual_pause_until = time.monotonic() + 30
                    with patch.object(controller, "_is_action_ready", return_value=True), patch.object(controller.window, "travel_to") as travel:
                        controller._attempt_wander()
                        travel.assert_not_called()
            finally:
                controller.close()

    def test_walk_moves_between_frames_then_finishes_without_writing_placement(self):
        window = DesktopPetWindow()
        play_walk(window)
        window.show()
        window.move(100, 100)
        finished = QSignalSpy(window.travel_finished)
        persisted = QSignalSpy(window.placement_changed)
        self.assertTrue(window.travel_to(QPoint(400, 100), "move"))
        window._advance_png_frame()
        self.assertEqual(window.pos(), QPoint(100, 100))
        index = window._png_index
        advance_walk(window)
        self.assertGreater(window.x(), 100)
        self.assertEqual(window._png_index, index)
        self.assertFalse(window._png_timer.isActive())
        finish_walk(window)
        self.assertEqual(window.pos(), QPoint(400, 100))
        self.assertEqual(finished.count(), 1)
        self.assertEqual(persisted.count(), 0)
        window.close()

    def test_faces_destination_before_first_step_and_retains_facing_after_arrival(self):
        window = DesktopPetWindow()
        play_walk(window)
        window.show()
        window.move(400, 100)
        self.assertTrue(window.travel_to(QPoint(100, 100), "move"))
        self.assertEqual(window.pos(), QPoint(400, 100))
        self.assertTrue(window._facing_left)
        advance_walk(window)
        self.assertLess(window.x(), 400)
        finish_walk(window)
        play_walk(window)
        # The red feature on the source's left is now on the display's right.
        self.assertGreater(window._label.pixmap().toImage().pixelColor(240, 20).red(), 200)
        self.assertTrue(window.travel_to(QPoint(400, 100), "move"))
        self.assertFalse(window._facing_left)
        window.close()

    def test_stride_scales_with_pet_size_and_frame_cap_controls_cadence(self):
        window = DesktopPetWindow()
        pack, animation = walking_animation()
        window.play(pack, animation)
        small = window._gait.cycle_distance
        window.apply_presentation_settings(scale=1, opacity=1, always_on_top=True,
                                          locked=False, bubble_enabled=True, fps_cap=6)
        self.assertAlmostEqual(window._gait.cycle_distance, small * 2)
        self.assertEqual(window._png_timer.interval(), 167)
        window.close()

    def test_left_facing_source_is_not_mirrored_when_walking_left(self):
        window = DesktopPetWindow()
        pack, animation = walking_animation()
        window.play(replace(pack, source_facing="left"), animation)
        window.show()
        window.move(400, 100)
        self.assertTrue(window.travel_to(QPoint(100, 100), "move"))
        self.assertEqual(window._facing_scale(), 1)
        self.assertGreater(window._label.pixmap().toImage().pixelColor(15, 20).red(), 200)
        advance_walk(window)
        self.assertLess(window.x(), 400)
        finish_walk(window)
        self.assertTrue(window.travel_to(QPoint(400, 100), "move"))
        self.assertEqual(window._facing_scale(), -1)
        self.assertGreater(window._label.pixmap().toImage().pixelColor(240, 20).red(), 200)
        window.close()

    def test_one_shared_clock_matches_measured_cycle_and_bounds_stall_catchup(self):
        window = DesktopPetWindow()
        play_walk(window)
        window.show()
        window.move(100, 100)
        window.travel_to(QPoint(400, 100), "move")
        for _ in range(20):
            advance_walk(window, 0.0166)
        self.assertAlmostEqual(window._walked_distance, window._gait.cycle_distance, places=5)
        self.assertEqual(window._png_index, 0)
        before = window._walked_distance
        advance_walk(window, 100)
        self.assertAlmostEqual(window._walked_distance - before, window._walk_speed * 0.05)
        window.close()

    def test_support_change_and_still_frames_do_not_add_sliding_distance(self):
        frames = (SoleFrame((10, 90), (30, 80)), SoleFrame((8, 90), (35, 80)),
                  SoleFrame((5, 80), (40, 90)), SoleFrame((5, 80), (40, 90)))
        gait = walking_gait(frames)
        self.assertIsNotNone(gait)
        self.assertEqual(gait.advances, (0, 2, 0, 0))
        self.assertEqual(gait.floor_offsets, (0, 0, 0, 0))
        self.assertIsNone(walking_gait((frames[0], frames[0])))

    def test_source_facing_reverses_which_sole_sweep_counts_as_forward(self):
        frames = (SoleFrame((10, 90), (30, 90)), SoleFrame((8, 90), (35, 90)))
        self.assertEqual(walking_gait(frames).advances, (5, 2))
        self.assertEqual(walking_gait(frames, "left").advances, (2, 5))

    def test_qt_event_loop_updates_position_more_often_than_animation_frames(self):
        window = DesktopPetWindow()
        window.apply_presentation_settings(scale=1, opacity=1, always_on_top=True,
                                          locked=False, bubble_enabled=True, fps_cap=15)
        play_walk(window)
        window.show()
        window.move(100, 100)
        window.travel_to(QPoint(220, 100), "move")
        changes, frame_changes = 0, 0
        previous_x, previous_frame = window.x(), window._png_index
        for _ in range(25):
            QTest.qWait(20)
            changes += window.x() != previous_x
            frame_changes += window._png_index != previous_frame
            previous_x, previous_frame = window.x(), window._png_index
        self.assertGreater(frame_changes, 0)
        self.assertGreater(changes, frame_changes)
        self.assertGreater(window.x(), 100)
        window.close()

    def test_gif_walk_is_prepared_with_original_delays_and_measured_soles(self):
        payload = base64.b64decode(
            "R0lGODlhQABAAIEAAAAAAAAA/wAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQJCgAAACwAAAAAQABAAAAIgAABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSj0aoGrVh1avmswaAGvWk1y9WgX71WHYrWUbnp3Ktq1bAAEBACH5BAkUAAAALBAANgAZAAUAgQAAAAAA/wAAAAAAAAghAAMIFAigoMGDCAcqHIiw4cGFCx1KhKhQokOKDC0mVBgQACH5BAkKAAAALA4ANgAZAAUAgQAAAAAA/wAAAAAAAAghAAMIFAigoMGDCAcqHIiw4cGFCx1KhKhQokOKDC0mVBgQACH5BAkUAAAALBAANgAZAAUAgQAAAAAA/wAAAAAAAAghAAMIFAigoMGDCAcqHIiw4cGFCx1KhKhQokOKDC0mVBgQADs=")
        state = DesktopPetState("move", "gif", ("/move.gif",), 12, True)
        pack = DesktopPetPack("gif-sample", "Sample", "sample", 64, 64, 1, {"move": state})
        animation = LoadedDesktopPetAnimation(state, (payload,))
        window = DesktopPetWindow()
        self.assertTrue(window.prepare_animation(pack, animation))
        self.assertTrue(window.is_animation_prepared(pack, animation))
        window.play(pack, animation)
        self.assertEqual(len(window._png_frames), 4)
        self.assertEqual(window._png_frame_delays, (100, 200, 100, 200))
        self.assertIsNotNone(window._gait)
        window.close()

    def test_teleport_changes_position_only_at_midpoint_and_can_be_cancelled(self):
        window = DesktopPetWindow()
        window.show()
        window.move(100, 100)
        phases = QSignalSpy(window.travel_phase_changed)
        self.assertTrue(window.travel_to(QPoint(400, 300), "teleport"))
        window._travel_started = time.monotonic() - 0.2
        window._advance_travel()
        self.assertEqual(window.pos(), QPoint(100, 100))
        window._travel_started = time.monotonic() - 0.5
        window._advance_travel()
        self.assertEqual(window.pos(), QPoint(400, 300))
        self.assertEqual(phases.count(), 2)
        window.cancel_travel()
        self.assertFalse(window.travelling)
        self.assertEqual(window._travel_opacity.opacity(), 1)
        self.assertFalse(window._travel_halo.isVisible())
        window._locked = True
        self.assertFalse(window.travel_to(QPoint(100, 100), "move"))
        window.close()


if __name__ == "__main__":
    unittest.main()
