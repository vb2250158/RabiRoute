from __future__ import annotations

import os
import unittest
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QBuffer, QIODevice, QPoint, Qt
from PySide6.QtGui import QPixmap
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from rabiroute_tray.desktop_pet_client import (
    DesktopPetBinding, DesktopPetIdleBehavior, DesktopPetModeAnimationSet, DesktopPetPack,
    DesktopPetState, LoadedDesktopPetAnimation, parse_desktop_pet_catalog,
)
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_companion import DesktopPetCompanion
from rabiroute_tray.desktop_pet_speech import DesktopPetSpeech


class DesktopPetModeAnimationSetsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self) -> None:
        patches = [patch.object(DesktopPetCompanion, "reconnect"), patch.object(DesktopPetSpeech, "reconnect"),
            patch.object(DesktopPetCompanion, "_enabled", return_value=False),
            patch.object(DesktopPetEventStream, "start"), patch.object(DesktopPetEventStream, "stop"),
            patch.object(DesktopPetController, "_persist"), patch.object(DesktopPetController, "_enqueue_animation_preloads")]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.controller = DesktopPetController("http://127.0.0.1:1", "sample", lambda _: None,
            initial_binding=DesktopPetBinding(), event_stream=DesktopPetEventStream("http://127.0.0.1:1"))
        self.addCleanup(self.controller.close)
        states = {name: DesktopPetState(name, "png-sequence", ("/1.png", "/2.png"), 12, True)
                  for name in ("idle", "thinking", "talking", "drag", "move", "run", "sleep", "work-idle", "quiet-idle")}
        for name, target in (("attention", "idle"), ("work-type", "work-idle"),
                             ("work-read", "work-idle"), ("work-nod", "work-idle")):
            states[name] = DesktopPetState(name, "png-sequence", ("/1.png", "/2.png"), 12, False, target)
        self.group = DesktopPetModeAnimationSet("work-idle", 10, 20, ("work-type", "work-read"), ("work-nod", "work-read"))
        self.pack = DesktopPetPack("sample", "Sample", "sample", 32, 32, .5, states,
            idle_behavior=DesktopPetIdleBehavior(10, 20, ("attention",), 60, "sleep"),
            companion_states={"watch": "thinking"},
            mode_animation_sets={"work": self.group, "quiet": DesktopPetModeAnimationSet("quiet-idle")})
        frame = QPixmap(8, 8)
        frame.fill(Qt.GlobalColor.cyan)
        buffer = QBuffer()
        buffer.open(QIODevice.OpenModeFlag.WriteOnly)
        self.assertTrue(frame.save(buffer, "PNG"))
        payload = bytes(buffer.data())
        buffer.close()
        self.controller._pack = self.pack
        self.controller._preferred_pack_id = self.pack.pack_id
        self.controller._binding_snapshot = DesktopPetBinding(enabled=True, pack_id=self.pack.pack_id)
        for state in states.values():
            animation = LoadedDesktopPetAnimation(state, (payload, payload))
            self.assertTrue(self.controller.window.prepare_animation(self.pack, animation))
            self.controller._animation_cache[state.name] = animation
        self.controller._fullscreen_timer.stop()
        self.controller.window.show()
        self.controller._configure_idle_scheduler()
        self.controller.set_state("idle")
        self.session = {"id": "activity", "revision": 2, "version": 3, "status": "active", "presetId": "work",
                        "activityKind": "work", "observationOwner": "desktop"}

    def enter(self, **overrides) -> None:
        self.controller._companion_changed({"roleId": "sample", "session": {**self.session, **overrides}})

    def test_catalog_dto_retains_generic_mode_sets_and_separate_action_pools(self) -> None:
        states = {name: {"type": "png-sequence", "assets": ["/frame.png"], "fps": 12,
                        "loop": state.loop, "next": state.next_state} for name, state in self.pack.states.items()}
        pack = parse_desktop_pet_catalog({"data": {"personaId": "sample", "packs": [{"id": "sample", "name": "Sample", "personaId": "sample",
            "states": states, "companionStates": {"watch": "thinking"}, "modeAnimationSets": {
                "custom-focus": {"idleState": "work-idle", "randomMinSeconds": 45, "randomMaxSeconds": 120,
                                 "randomStates": ["work-type", "attention"], "clickStates": ["work-nod"]},
                "broken": {"idleState": "attention"}}}]}}, "sample")[0]
        self.assertEqual(tuple(pack.mode_animation_sets), ("custom-focus",))
        group = pack.mode_animation_sets["custom-focus"]
        self.assertEqual(group.random_states, ("work-type",))
        self.assertEqual(group.click_states, ("work-nod",))
        self.assertEqual(group.idle_behavior().idle_state, "work-idle")
        self.assertEqual(pack.companion_states, {"watch": "thinking"})

    def test_active_mode_owns_idle_random_pool_without_ordinary_sleep(self) -> None:
        self.enter()
        self.assertEqual(self.controller.window.active_state, "work-idle")
        scheduler = self.controller._idle_scheduler
        self.assertEqual(scheduler._behavior, self.group.idle_behavior())
        self.assertTrue(scheduler._random_timer.isActive())
        self.assertFalse(scheduler._sleep_timer.isActive())
        scheduler._random_timer.stop()
        scheduler._request_random_animation()
        self.assertIn(self.controller.window.active_state, self.group.random_states)
        self.controller._animation_finished("idle")
        self.assertEqual(self.controller.window.active_state, "work-idle")
        self.assertTrue(scheduler._random_timer.isActive())

    def test_same_profile_sse_revision_does_not_postpone_random_deadline(self) -> None:
        self.enter()
        scheduler = self.controller._idle_scheduler
        before = scheduler._random_timer.remainingTime()
        QTest.qWait(60)
        with patch.object(scheduler, "configure", wraps=scheduler.configure) as configure:
            self.enter(version=4, revision=3)
        self.assertEqual(configure.call_count, 0)
        self.assertLess(scheduler._random_timer.remainingTime(), before)

    def test_click_uses_mode_pool_and_repeated_click_restarts_the_selected_action(self) -> None:
        self.enter()
        with patch.object(self.controller._random, "choice", side_effect=lambda values: values[0]):
            self.controller._clicked()
            self.assertEqual(self.controller.window.active_state, "work-nod")
            self.controller._clicked()
            self.assertEqual(self.controller.window.active_state, "work-read")
        self.controller._animation_finished("idle")
        self.assertEqual(self.controller.window.active_state, "work-idle")

    def test_mode_with_no_click_actions_retains_its_own_idle(self) -> None:
        self.enter(presetId="quiet", activityKind="work")
        self.assertEqual(self.controller.window.active_state, "quiet-idle")
        self.controller._clicked()
        self.assertEqual(self.controller.window.active_state, "quiet-idle")

    def test_speech_preserves_current_mode_one_shot_then_returns_to_mode_idle(self) -> None:
        self.enter()
        self.controller.set_state("work-type")
        self.controller.window._png_index = 1
        self.controller._speech_changed({"status": "playing", "text": "requested help"})
        self.assertEqual(self.controller.window.active_state, "work-type")
        self.assertEqual(self.controller.window._png_index, 1)
        self.controller._animation_finished("idle")
        self.assertEqual(self.controller.window.active_state, "work-idle")
        self.controller._speech_changed({"status": "finished"})
        self.assertEqual(self.controller.window.active_state, "work-idle")

    def test_drag_and_run_interruptions_return_to_current_mode_idle(self) -> None:
        self.enter()
        self.controller.set_state("work-read")
        self.controller._drag_started()
        self.assertEqual(self.controller.window.active_state, "drag")
        self.controller._drag_finished()
        self.assertEqual(self.controller.window.active_state, "work-idle")
        self.controller._state_before_travel = "work-idle"
        self.controller._travel_phase_changed("run")
        self.assertEqual(self.controller.window.active_state, "run")
        with patch.object(self.controller, "_face_current_window"):
            self.controller._travel_finished(True)
        self.assertEqual(self.controller.window.active_state, "work-idle")

    def test_pause_and_end_restore_ordinary_context_and_end_restores_idle_settings(self) -> None:
        self.enter()
        self.enter(status="paused", revision=3, version=4, pauseReason="user")
        self.assertEqual(self.controller.window.active_state, "idle")
        self.assertFalse(self.controller._idle_scheduler._active)
        self.controller._resume_context("work-idle")
        self.assertEqual(self.controller.window.active_state, "idle")
        self.enter(status="ended", revision=4, version=5)
        scheduler = self.controller._idle_scheduler
        self.assertEqual(scheduler._behavior, self.pack.idle_behavior)
        self.assertTrue(scheduler._random_timer.isActive())
        self.assertTrue(scheduler._sleep_timer.isActive())

    def test_preset_group_precedes_classification_group_and_switches_when_preset_changes(self) -> None:
        self.enter(presetId="quiet", activityKind="work")
        self.assertEqual(self.controller.window.active_state, "quiet-idle")
        self.enter(presetId="work", activityKind="work", revision=3, version=4)
        self.assertEqual(self.controller.window.active_state, "work-idle")

    def test_legacy_mapping_stays_single_idle_without_copying_ordinary_random_pool(self) -> None:
        self.enter(presetId="legacy", activityKind="watch")
        group = self.controller._companion_animation_set()
        self.assertEqual(group.idle_state, "thinking")
        self.assertEqual(group.random_states, ())
        self.assertEqual(group.click_states, ())
        self.assertFalse(self.controller._idle_scheduler._random_timer.isActive())
        self.controller._clicked()
        self.assertEqual(self.controller.window.active_state, "attention")
        self.controller._animation_finished("idle")
        self.assertEqual(self.controller.window.active_state, "thinking")

    def test_blocked_mode_random_rearms_using_mode_idle(self) -> None:
        self.enter()
        self.controller.window._drag_offset = QPoint(0, 0)
        scheduler = self.controller._idle_scheduler
        scheduler._random_timer.stop()
        scheduler._request_random_animation()
        self.assertEqual(self.controller.window.active_state, "work-idle")
        self.assertEqual(scheduler._current_state, "work-idle")
        self.assertTrue(scheduler._random_timer.isActive())
        self.controller.window._drag_offset = None


if __name__ == "__main__":
    unittest.main()
