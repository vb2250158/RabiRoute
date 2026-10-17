import io
import os
import time
import unittest
from dataclasses import replace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PIL import Image
from PySide6.QtCore import QPoint, Qt
from PySide6.QtTest import QTest, QSignalSpy
from PySide6.QtWidgets import QApplication, QLabel, QMenu, QSlider
from rabiroute_tray.desktop_pet_client import DesktopPetBinding, DesktopPetIdleBehavior, LoadedDesktopPetAnimation
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_speech import DesktopPetSpeech
from rabiroute_tray.desktop_pet_companion import DesktopPetCompanion
from rabiroute_tray.desktop_pet_idle import DesktopPetIdleScheduler
from rabiroute_tray.desktop_pet_physics import PetFlight
from pet_motion_fixture import walking_animation, finish_walk


class PetPlaybackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.patches = [patch.object(DesktopPetEventStream, "start"),
                        patch.object(DesktopPetEventStream, "stop"),
                        patch.object(DesktopPetSpeech, "reconnect"),
                        patch.object(DesktopPetCompanion, "reconnect"),
                        patch.object(DesktopPetController, "_load_binding"),
                        patch.object(DesktopPetController, "_persist"),
                        patch.object(DesktopPetController, "_enqueue_animation_preloads")]
        for item in self.patches:
            item.start()
        self.controller = DesktopPetController("http://127.0.0.1:1", "sample", lambda _: None)
        pack, move = walking_animation()
        self.animations = {name: replace(move, state=replace(move.state, name=name, loop=loop, next_state="idle"))
                           for name, loop in (("idle", True), ("talking", True), ("attention", False),
                                              ("drag", True), ("move", True), ("thinking", True))}
        self.pack = replace(pack, states={name: action.state for name, action in self.animations.items()})
        self.controller._pack = self.pack
        self.controller._animation_cache = self.animations.copy()
        self.controller._binding_snapshot = DesktopPetBinding(enabled=True, pack_id=self.pack.pack_id, wander_enabled=True)
        self.controller._preferred_pack_id = self.pack.pack_id
        self.window = self.controller.window
        self.window.show_on_desktop()
        self.window.move(100, 100)
        self.controller._fullscreen_timer.stop()
        self.controller.set_state("idle")

    def tearDown(self):
        self.controller.close()
        for item in reversed(self.patches):
            item.stop()

    def finish_reaction(self):
        for _ in range(4):
            self.window._advance_png_frame()

    def test_lift_throw_and_airborne_loop_restore_context_only_after_landing(self):
        for name, loop, next_state in (("lift", False, "drag"), ("throw", False, "airborne"), ("airborne", True, "")):
            self.animations[name] = replace(self.animations["drag"], state=replace(
                self.animations["drag"].state, name=name, loop=loop, next_state=next_state))
        self.pack = replace(self.pack, states={name: action.state for name, action in self.animations.items()})
        self.controller._pack = self.pack
        self.controller._animation_cache = self.animations.copy()
        self.controller.set_state("thinking")
        self.window._drag_offset = QPoint()
        self.controller._drag_started()
        self.assertEqual(self.window.active_state, "lift")
        self.finish_reaction()
        self.assertEqual(self.window.active_state, "drag")
        self.window._flight = PetFlight(100, 100, 1000, -500)
        self.window.flight_started.emit()
        self.assertEqual(self.window.active_state, "throw")
        self.finish_reaction()
        self.assertEqual(self.window.active_state, "airborne")
        for _ in range(12):
            self.window._advance_png_frame()
        self.assertEqual(self.window.active_state, "airborne")
        self.assertTrue(self.window.animation_running)
        self.window._flight = None
        self.window._drag_offset = None
        self.controller._drag_finished()
        self.assertEqual(self.window.active_state, "thinking")

    def test_older_pack_keeps_drag_animation_during_flight(self):
        self.window._drag_offset = QPoint()
        self.controller._drag_started()
        self.window._flight = PetFlight(100, 100, 1000, -500)
        self.window.flight_started.emit()
        self.assertEqual(self.window.active_state, "drag")
        self.finish_reaction()
        self.assertEqual(self.window.active_state, "drag")

    def test_failed_scene_load_retries_the_current_scene_without_another_kind_change(self):
        states = {**self.pack.states, "attention": replace(self.pack.states["attention"], loop=True)}
        self.controller._pack = replace(self.pack, states=states, companion_states={"watch": "attention"})
        self.controller._companion_session = {"id": "session", "status": "active", "activityKind": "watch"}
        self.controller._requested_state = "attention"
        self.controller._animation_unavailable()
        self.assertEqual(self.controller._requested_state, "attention")
        with patch.object(self.controller, "_resume_context") as resume:
            self.assertTrue(self.controller._animation_retry_timer.isActive())
            self.controller._animation_retry_timer.timeout.emit()
            resume.assert_called_once_with()

    def reaction(self):
        return {"roleId": "sample", "sessionId": "session", "revision": 1,
                "expiresAt": time.time() * 1000 + 20000, "state": "attention", "text": "hello"}

    def test_click_returns_to_live_speech_and_repeated_snapshots_keep_frame(self):
        self.controller._speech_changed({"status": "playing"})
        self.window._advance_png_frame()
        self.controller._speech_changed({"status": "playing"})
        self.assertEqual(self.window._png_index, 1)
        self.controller._clicked()
        self.assertEqual(self.window.active_state, "attention")
        self.finish_reaction()
        self.assertEqual(self.window.active_state, "talking")
        self.controller._speech_changed({"status": "completed"})
        self.assertEqual(self.window.active_state, "idle")

    def test_each_click_restarts_attention_using_prepared_frames(self):
        self.controller._clicked()
        frames = self.window._png_frames
        self.window._advance_png_frame()
        self.assertEqual(self.window._png_index, 1)
        with patch.object(self.window, "_decode_png_frames", wraps=self.window._decode_png_frames) as decode:
            self.controller._clicked()
            self.assertEqual(self.window.active_state, "attention")
            self.assertEqual(self.window._png_index, 0)
            self.assertIs(self.window._png_frames, frames)
            decode.assert_not_called()
        self.finish_reaction()
        self.assertEqual(self.window.active_state, "idle")

    def test_blocked_idle_request_rearms_after_menu_closes(self):
        scheduler = self.controller._idle_scheduler
        scheduler.configure(DesktopPetIdleBehavior(1, 1, ("attention",)))
        scheduler.set_active(True)
        menu = QMenu(self.window)
        self.controller._context_menu = menu
        scheduler._request_random_animation()
        self.assertEqual(self.window.active_state, "idle")
        self.assertEqual(scheduler._current_state, "idle")
        self.assertTrue(scheduler._random_timer.isActive())
        self.controller._context_menu = None
        scheduler._request_random_animation()
        self.assertEqual(self.window.active_state, "attention")
        self.finish_reaction()
        self.assertEqual(self.window.active_state, "idle")
        self.assertTrue(scheduler._random_timer.isActive())
        menu.deleteLater()

    def test_companion_disconnect_restores_idle_scheduling(self):
        concerned = replace(self.animations["attention"], state=replace(self.animations["attention"].state, name="concerned"))
        self.controller._pack = replace(self.pack, states={**self.pack.states, "concerned": concerned.state},
                                        idle_behavior=DesktopPetIdleBehavior(1, 1, ("attention",)))
        self.controller._animation_cache["concerned"] = concerned
        scheduler = self.controller._idle_scheduler
        scheduler.configure(DesktopPetIdleBehavior(1, 1, ("attention",)))
        scheduler.set_active(False)
        self.controller._companion_session = {"id": "session", "status": "active"}
        self.controller._event_connection_changed(False)
        self.assertTrue(scheduler._active)
        self.assertEqual(self.window.active_state, "concerned")
        self.finish_reaction()
        self.assertEqual(self.window.active_state, "idle")
        self.assertTrue(scheduler._random_timer.isActive())

    def test_drag_does_not_emit_click_on_release(self):
        clicked = QSignalSpy(self.window.clicked)
        started = QSignalSpy(self.window.drag_started)
        finished = QSignalSpy(self.window.drag_finished)
        QTest.mousePress(self.window, Qt.MouseButton.LeftButton, pos=QPoint(10, 10))
        QTest.mouseMove(self.window, QPoint(50, 50), delay=1)
        self.assertEqual(self.window.active_state, "drag")
        QTest.mouseRelease(self.window, Qt.MouseButton.LeftButton, pos=QPoint(50, 50))
        QTest.qWait(230)
        self.assertEqual(clicked.count(), 0)
        self.assertEqual(started.count(), 1)
        self.assertEqual(finished.count(), 1)
        self.assertEqual(self.window.active_state, "idle")

    def test_speech_ending_during_drag_does_not_restore_stale_talking(self):
        self.controller._speech_changed({"status": "playing"})
        self.controller._drag_started()
        self.controller._speech_changed({"status": "completed"})
        self.assertEqual(self.window.active_state, "drag")
        self.controller._drag_finished()
        self.assertEqual(self.window.active_state, "idle")

    def test_companion_snapshots_and_reactions_do_not_cancel_explicit_walk(self):
        self.controller._agent_motion.command = {"requestId": "sample-command"}
        self.window.travel_to(QPoint(160, 100), "move")
        self.controller._companion_session = {"id": "session", "revision": 1, "version": 1, "status": "active"}
        with patch.object(self.controller._companion, "accept"):
            self.controller._companion_changed({"roleId": "sample", "session": {
                **self.controller._companion_session, "version": 2}})
        self.controller._companion_reaction(self.reaction())
        self.controller._speech_changed({"status": "playing"})
        self.assertTrue(self.window.travelling)
        self.assertEqual(self.window.active_state, "move")
        finish_walk(self.window)
        self.assertEqual(self.window.active_state, "talking")
        self.controller._agent_motion.command = None

    def test_lower_priority_reaction_is_dropped_without_resetting_speech(self):
        self.controller._companion_session = {"id": "session", "revision": 1}
        self.controller._speech_changed({"status": "playing"})
        self.window._advance_png_frame()
        self.controller._companion_reaction(self.reaction())
        self.assertEqual(self.window.active_state, "talking")
        self.assertEqual(self.window._png_index, 1)
        self.controller._speech_changed({"status": "completed"})
        self.assertEqual(self.window.active_state, "idle")

    def test_drag_and_travel_do_not_restore_an_interrupted_looping_reaction(self):
        self.controller._request_reaction("thinking")
        self.controller._drag_started()
        self.controller._drag_finished()
        self.assertEqual(self.window.active_state, "idle")
        self.controller._request_reaction("thinking")
        self.controller._state_before_travel = "thinking"
        self.window.travel_to(QPoint(160, 100), "move")
        finish_walk(self.window)
        self.assertEqual(self.window.active_state, "idle")

    def test_looping_companion_reaction_expires_and_does_not_count_as_user_activity(self):
        self.controller._companion_session = {"id": "session", "revision": 1}
        previous_activity = self.controller._idle_scheduler._last_activity_at
        self.controller._companion_reaction({**self.reaction(), "state": "thinking", "expiresAt": time.time() * 1000 + 70})
        self.assertEqual(self.window.active_state, "thinking")
        QTest.qWait(130)
        self.assertEqual(self.window.active_state, "idle")
        self.assertEqual(self.controller._idle_scheduler._last_activity_at, previous_activity)

    def test_bad_action_preserves_current_frame_and_clock(self):
        self.window._advance_png_frame()
        old_frame = self.window._label.pixmap().cacheKey()
        bad = replace(self.animations["attention"], assets=(b"bad png",))
        self.assertFalse(self.window.play(self.pack, bad))
        self.assertEqual(self.window.active_state, "idle")
        self.assertEqual(self.window._label.pixmap().cacheKey(), old_frame)
        self.assertTrue(self.window.animation_running)

    def test_transition_retains_old_frame_and_walking_clears_overlay(self):
        self.controller.set_state("talking")
        self.assertFalse(self.window._previous_frame.pixmap().isNull())
        QTest.qWait(180)
        self.assertFalse(self.window._previous_frame.isVisible())
        self.controller.set_state("idle")
        self.window.travel_to(QPoint(160, 100), "move")
        self.assertFalse(self.window._previous_frame.isVisible())
        self.assertEqual(self.window._travel_opacity.opacity(), 1)
        self.assertFalse(self.window._png_timer.isActive())

    def test_gif_obeys_pack_loop_and_next_with_original_frame_durations(self):
        stream = io.BytesIO()
        Image.new("RGBA", (32, 32), "red").save(stream, format="GIF", save_all=True,
            append_images=[Image.new("RGBA", (32, 32), "blue")], duration=[80, 160], loop=0)
        state = replace(self.animations["attention"].state, kind="gif", asset_urls=("/sample.gif",))
        pack = replace(self.pack, pack_id="gif", states={"attention": state})
        self.controller.window.animation_finished.disconnect(self.controller._animation_finished)
        finished = QSignalSpy(self.window.animation_finished)
        self.assertTrue(self.window.play(pack, LoadedDesktopPetAnimation(state, (stream.getvalue(),))))
        self.assertEqual(self.window._png_frame_delays, (80, 160))
        self.window._advance_png_frame()
        self.window._advance_png_frame()
        self.assertEqual(finished.count(), 1)
        self.assertFalse(self.window.animation_running)

    def test_idle_actions_avoid_two_recent_choices_when_pool_allows(self):
        class FirstChoice:
            def choice(self, values): return values[0]
            def uniform(self, start, end): return start
        scheduler = DesktopPetIdleScheduler(random_source=FirstChoice())
        scheduler.configure(DesktopPetIdleBehavior(1, 2, ("a", "b", "c"), 900, "sleep"))
        scheduler.set_active(True)
        chosen = []
        scheduler.animation_requested.connect(chosen.append)
        for _ in range(4):
            scheduler.state_started("idle")
            scheduler._request_random_animation()
        self.assertEqual(chosen, ["a", "b", "c", "a"])
        scheduler.stop()

    def test_size_menu_previews_without_rebuilding_until_entire_menu_closes(self):
        menu = QMenu(self.window)
        scale_menu = self.controller._add_scale_control(menu)
        slider = scale_menu.findChild(QSlider)
        self.assertEqual(scale_menu.title(), "大小：50%")
        self.assertEqual((slider.minimum(), slider.maximum(), slider.singleStep()), (10, 200, 1))
        frames = self.window._png_frames
        cached = self.window._prepared_png_frames.copy()
        self.window._advance_png_frame()
        with patch.object(self.window, "_decode_png_frames", wraps=self.window._decode_png_frames) as decode:
            for value in range(10, 201):
                slider.setValue(value)
            slider.setValue(10)
            self.assertEqual(scale_menu.title(), "大小：10%")
            self.assertTrue(any(label.text() == "当前大小：10%" for label in scale_menu.findChildren(QLabel)))
            self.assertEqual(self.controller._scale, 0.5)
            self.assertEqual(self.window._scale, 0.5)
            self.assertIs(self.window._png_frames, frames)
            self.assertEqual(self.window._prepared_png_frames, cached)
            self.assertEqual(self.window._png_index, 1)
            self.assertEqual(self.window.size(), self.window._preview_size())
            self.assertLessEqual(self.window._label.pixmap().width(), self.window.width())
            self.assertTrue(self.window._png_timer.isActive())
            slider.sliderReleased.emit()
            scale_menu.aboutToHide.emit()
            QTest.qWait(160)
            decode.assert_not_called()
            self.controller._persist.assert_not_called()
            self.controller._enqueue_animation_preloads.assert_not_called()
            menu.aboutToHide.emit()
            self.assertEqual(self.controller._scale, 0.5)
            self.app.processEvents()
            self.assertEqual(self.controller._scale, 0.1)
            self.assertIsNone(self.window._scale_preview)
            decode.assert_called_once()
            self.controller._persist.assert_called_once_with({"scale": 0.1, "placement": self.window.placement()})
            self.controller._enqueue_animation_preloads.assert_called_once()
        menu.deleteLater()

    def test_scale_preview_returning_to_original_does_not_rebuild_or_save(self):
        menu = QMenu(self.window)
        slider = self.controller._add_scale_control(menu).findChild(QSlider)
        original_position = self.window.pos()
        with patch.object(self.window, "play") as play:
            slider.setValue(200)
            slider.setValue(50)
            menu.aboutToHide.emit()
            self.app.processEvents()
            self.assertIsNone(self.window._scale_preview)
            self.assertEqual(self.window.pos(), original_position)
            play.assert_not_called()
            self.controller._persist.assert_not_called()
        menu.deleteLater()

    def test_unedited_menu_does_not_overwrite_new_binding_scale(self):
        menu = QMenu(self.window)
        self.controller._add_scale_control(menu)
        self.controller._scale = 0.75
        menu.aboutToHide.emit()
        self.app.processEvents()
        self.assertEqual(self.controller._scale, 0.75)
        self.controller._persist.assert_not_called()
        menu.deleteLater()

    def test_queued_resize_does_not_apply_after_controller_shutdown(self):
        menu = QMenu(self.window)
        slider = self.controller._add_scale_control(menu).findChild(QSlider)
        slider.setValue(20)
        menu.aboutToHide.emit()
        self.controller._closed = True
        with patch.object(self.controller, "_set_scale") as apply:
            self.app.processEvents()
            apply.assert_not_called()
        menu.deleteLater()

    def test_ten_percent_size_is_not_clamped_to_sixty_four_pixels(self):
        self.controller._set_scale(0.1)
        target = self.window._target_size(replace(self.pack, canvas_width=512, canvas_height=512))
        self.assertEqual((target.width(), target.height()), (51, 51))

    def test_loop_restarts_after_last_frame_without_stopping_timer(self):
        count = len(self.window._png_frames)
        for _ in range(count):
            self.window._advance_png_frame()
        self.assertEqual(self.window._png_index, 0)
        self.assertTrue(self.window._png_timer.isActive())


if __name__ == "__main__":
    unittest.main()
