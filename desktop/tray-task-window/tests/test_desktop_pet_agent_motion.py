import os
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtWidgets import QApplication
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_agent_motion import resolve_motion_target
from rabiroute_tray.desktop_pet_client import DesktopPetPack, DesktopPetState
from pet_motion_fixture import play_walk, finish_walk, advance_walk


class AgentMotionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.patches = [patch.object(DesktopPetEventStream, "start"), patch.object(DesktopPetEventStream, "stop"),
                        patch.object(DesktopPetController, "_load_binding"), patch.object(DesktopPetController, "_persist"),
                        patch.object(DesktopPetController, "set_state")]
        for item in self.patches:
            item.start()
        self.controller = DesktopPetController("http://127.0.0.1:1", "sample", lambda _: None)
        self.controller._pack = DesktopPetPack("sample", "Sample", "sample", 512, 512, 0.5, {
            name: DesktopPetState(name, "png-sequence", ("/frame.png",), 12, True)
            for name in ("idle", "move", "teleport-out", "teleport-in")})
        self.controller.window.show()
        self.controller.window.move(100, 100)
        play_walk(self.controller.window)
        self.results = []
        self.async_patch = patch("rabiroute_tray.desktop_pet_agent_motion.start_qt_task",
                                 side_effect=lambda operation, completed, **_: completed(None, operation()))
        self.async_patch.start()
        self.controller._agent_motion._post = lambda value: self.results.append(value) or None
        self.ready = patch.object(self.controller, "_is_action_ready", return_value=True)
        self.ready.start()

    def tearDown(self):
        self.controller.close()
        self.ready.stop()
        self.async_patch.stop()
        for item in reversed(self.patches):
            item.stop()

    def command(self, mode="walk"):
        agent = self.controller._agent_motion
        agent.command = {"requestId": "sample-agent-1", "token": "test-claim", "mode": mode,
                         "target": {"kind": "position", "x": 400, "y": 100}}
        agent.wait_started = time.monotonic()
        agent._run()

    def test_actual_walk_returns_arrival_only_after_rendered_steps_finish(self):
        self.controller._requested_state = "sleep"
        self.command()
        window = self.controller.window
        self.assertTrue(window.travelling)
        self.assertEqual(self.results, [])
        self.assertEqual(self.controller._state_before_travel, "idle")
        advance_walk(window)
        self.assertGreater(window.x(), 100)
        self.assertLess(window.x(), 400)
        self.assertEqual(self.results, [])
        finish_walk(window)
        self.assertEqual(self.results[0]["status"], "succeeded")
        self.assertEqual(self.results[0]["position"], {"x": 400, "y": 100})
        self.assertEqual(self.results[0]["travelKind"], "move")

    def test_progress_renews_only_after_position_changes_and_never_claims_arrival(self):
        self.command()
        agent = self.controller._agent_motion
        agent._progress()
        self.assertEqual(self.results, [])
        advance_walk(self.controller.window)
        agent._progress()
        self.assertEqual(self.results[0]["status"], "running")
        agent._progress()
        self.assertEqual(len(self.results), 1)
        finish_walk(self.controller.window)
        self.assertEqual(self.results[-1]["status"], "succeeded")
        self.assertFalse(agent.progress_timer.isActive())

    def test_teleport_reports_kind_and_click_cancels(self):
        self.command("teleport")
        self.assertEqual(self.controller.window._travel_kind, "teleport")
        self.controller._clicked()
        self.assertEqual(self.results[0]["status"], "cancelled")

    def test_lock_and_offscreen_reject_without_moving(self):
        self.controller._locked = True
        self.command()
        self.assertEqual(self.results[0]["status"], "failed")
        self.assertFalse(self.controller.window.travelling)
        with self.assertRaises(ValueError):
            resolve_motion_target({"kind": "position", "x": 99999, "y": 99999}, self.controller.window)
        with self.assertRaises(ValueError):
            resolve_motion_target({"kind": "screen-corner", "corner": "top-left", "screenName": "missing-monitor"}, self.controller.window)

    def test_screen_corner_uses_available_area_and_keeps_pet_visible(self):
        destination, kind = resolve_motion_target({"kind": "screen-corner", "corner": "bottom-right"}, self.controller.window)
        area = self.app.primaryScreen().availableGeometry()
        self.assertLessEqual(destination[0] + self.controller.window.width(), area.left() + area.width())
        self.assertLessEqual(destination[1] + self.controller.window.height(), area.top() + area.height())
        self.assertEqual(kind, "move")

    def test_missing_animation_fails_instead_of_sliding_idle(self):
        self.controller._pack.states.pop("move")
        self.ready.stop()
        self.ready = patch.object(self.controller, "_is_action_ready", return_value=False)
        self.ready.start()
        self.command()
        self.assertEqual(self.results[0]["status"], "failed")
        self.assertIn("animations", self.results[0]["reason"])
