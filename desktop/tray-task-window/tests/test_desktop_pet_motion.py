from __future__ import annotations

import os
import time
import unittest
from unittest.mock import patch
from dataclasses import replace

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QPoint
from PySide6.QtTest import QSignalSpy
from PySide6.QtWidgets import QApplication

from rabiroute_tray.desktop_pet_client import DesktopPetBinding, DesktopPetPack, DesktopPetState, parse_desktop_pet_binding
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_motion import ForegroundWindow, corner_positions, logical_bounds, matches_monitor, travel_kind
from rabiroute_tray.desktop_pet_window import DesktopPetWindow


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

    def test_walk_advances_position_then_finishes_without_writing_placement(self):
        window = DesktopPetWindow()
        window.show()
        window.move(100, 100)
        finished = QSignalSpy(window.travel_finished)
        persisted = QSignalSpy(window.placement_changed)
        self.assertTrue(window.travel_to(QPoint(400, 100), "move"))
        window._travel_started = time.monotonic() - window._travel_duration / 2
        window._advance_travel()
        self.assertGreater(window.x(), 100)
        self.assertLess(window.x(), 400)
        window._travel_started = time.monotonic() - window._travel_duration - 0.1
        window._advance_travel()
        self.assertEqual(window.pos(), QPoint(400, 100))
        self.assertEqual(finished.count(), 1)
        self.assertEqual(persisted.count(), 0)
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
