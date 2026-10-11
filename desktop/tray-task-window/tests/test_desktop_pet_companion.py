import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
import unittest
import time
from unittest.mock import patch
from PySide6.QtCore import QPoint
from PySide6.QtWidgets import QApplication
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_client import DesktopPetBinding, DesktopPetPack, DesktopPetState
from rabiroute_tray.desktop_pet_companion import DesktopPetCompanion
from urllib.error import URLError, HTTPError

class CompanionMenuTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_new_controller_reconciles_companion_even_when_shared_stream_connected_earlier(self):
        with patch.object(DesktopPetCompanion, "reconnect") as reconnect:
            controller = DesktopPetController("http://127.0.0.1:1", "one", lambda _: None,
                initial_binding=DesktopPetBinding(), event_stream=DesktopPetEventStream("http://127.0.0.1:1"))
            try:
                reconnect.assert_called_once_with()
            finally:
                controller.close()

    def test_right_click_has_one_checkable_companion_entry_without_picker(self):
        controller = DesktopPetController("http://127.0.0.1:1", "one", lambda _: None,
            initial_binding=DesktopPetBinding(), event_stream=DesktopPetEventStream("http://127.0.0.1:1"))
        try:
            controller._show_context_menu(QPoint(20, 20))
            entries = [a for a in controller._context_menu.actions() if a.text() == "陪伴模式"]
            self.assertEqual(len(entries), 1)
            self.assertTrue(entries[0].isCheckable())
            self.assertFalse(entries[0].isChecked())
            self.assertNotIn("选择窗口", [a.text() for a in controller._context_menu.actions()])
            with patch.object(controller._companion, "_work") as work:
                entries[0].trigger()
                self.assertEqual(work.call_count, 1)
        finally:
            controller._context_menu.close()
            controller.close()

    def test_old_revision_does_not_replace_active_companion_and_stopping_restores_binding(self):
        controller = DesktopPetController("http://127.0.0.1:1", "one", lambda _: None,
            initial_binding=DesktopPetBinding(), event_stream=DesktopPetEventStream("http://127.0.0.1:1"))
        try:
            active = {"id": "activity", "revision": 3, "version": 5, "status": "active", "observationOwner": "desktop"}
            controller._companion_changed({"roleId": "one", "session": active})
            self.assertFalse(controller._hide_on_fullscreen)
            self.assertFalse(controller._companion._timer.isActive() and controller._companion.busy)
            controller._companion_changed({"roleId": "one", "session": {**active, "revision": 2, "version": 4}})
            self.assertEqual(controller._companion_session["revision"], 3)
            controller._companion_changed({"roleId": "one", "session": {**active, "revision": 4, "version": 6, "status": "ended"}})
            self.assertEqual(controller._companion_session, {})
            self.assertTrue(controller._hide_on_fullscreen)
            self.assertFalse(controller._companion._timer.isActive())
        finally:
            controller.close()

    def test_capture_loss_recovers_but_manual_pause_stays_quiet(self):
        companion = DesktopPetCompanion("http://127.0.0.1:1", "one", self.app)
        try:
            base = {"id": "activity", "revision": 2, "version": 3, "status": "paused", "observationOwner": "desktop"}
            companion.accept({**base, "pauseReason": "capture_lost"})
            self.assertTrue(companion._enabled())
            self.assertTrue(companion._timer.isActive())
            companion.accept({**base, "version": 4, "pauseReason": "user"})
            self.assertFalse(companion._enabled())
            self.assertFalse(companion._timer.isActive())
        finally:
            companion.close()

    def test_manager_restart_restores_explicit_intent_but_not_a_manual_pause(self):
        companion = DesktopPetCompanion("http://127.0.0.1:1", "one", self.app)
        intent = {"gatewayId": "route", "presetId": "adaptive", "title": "", "autoReview": True,
                  "voice": True, "saveSummary": False, "observationOwner": "desktop"}
        try:
            with patch.object(companion, "_work") as work:
                companion.reconnect()
                operation = work.call_args.args[0]
                with patch.object(companion, "_request", side_effect=[{"session": None, "resumeIntent": intent}, {"session": {"status": "active"}}]) as request:
                    operation()
                    self.assertEqual(request.call_args.args[0], "start")
                    self.assertEqual(request.call_args.args[1]["gatewayId"], "route")
                with patch.object(companion, "_request", return_value={"session": {"status": "paused", "pauseReason": "user"}, "resumeIntent": intent}) as request:
                    operation()
                    request.assert_called_once_with()
                companion._epoch += 1
                with patch.object(companion, "_request", return_value={"session": None, "resumeIntent": intent}) as request:
                    operation()
                    request.assert_called_once_with()
        finally:
            companion.close()

    def test_reconnect_notification_during_inflight_work_is_not_lost(self):
        companion = DesktopPetCompanion("http://127.0.0.1:1", "one", self.app)
        callback = []
        try:
            with patch("rabiroute_tray.desktop_pet_companion.start_qt_task", side_effect=lambda op, done: callback.append(done)):
                companion._work(lambda: None)
                companion.reconnect()
                self.assertTrue(companion._reconnect_requested)
                with patch.object(companion, "reconnect") as reconnect:
                    callback[0](None, URLError("offline"))
                    reconnect.assert_called_once_with()
                    self.assertFalse(companion._reconnect_requested)
        finally:
            companion.close()

    def test_transient_error_reconciles_state_before_sampling_again(self):
        companion = DesktopPetCompanion("http://127.0.0.1:1", "one", self.app)
        companion.accept({"id": "activity", "revision": 1, "status": "active", "observationOwner": "desktop"})
        try:
            def task(operation, finished):
                finished(None, URLError("temporarily offline"))
            with patch("rabiroute_tray.desktop_pet_companion.start_qt_task", side_effect=task):
                companion._work(lambda: None)
            self.assertTrue(companion._needs_reconnect)
            self.assertTrue(companion._timer.isActive())
            with patch.object(companion, "_work") as work:
                companion._acquire()
                self.assertEqual(work.call_count, 1)
                with patch.object(companion, "_request", return_value={"session": companion.session}) as request:
                    work.call_args.args[0]()
                    request.assert_called_once_with()
        finally:
            companion.close()

    def test_page_switch_posts_current_frame_without_a_speech_cancel_roundtrip(self):
        companion = DesktopPetCompanion("http://127.0.0.1:1", "one", self.app)
        active = {"id": "activity", "revision": 1, "status": "active", "observationOwner": "desktop"}
        companion.accept(active)
        observation = {"sequence": 1, "window": {"id": "browser", "title": "Episode 2", "processName": "chrome.exe"}}
        try:
            companion._window_key = "browser:Episode 1"
            with patch.object(companion, "_work") as work:
                companion._acquire()
                with patch("rabiroute_tray.desktop_pet_companion.foreground_observation", return_value=observation), \
                        patch.object(companion, "_request", return_value={"session": active}) as request:
                    work.call_args.args[0]()
                    self.assertEqual([call.args[0] for call in request.call_args_list], ["observation"])
        finally:
            companion.close()

    def test_expired_frame_reconciles_instead_of_stopping_capture(self):
        companion = DesktopPetCompanion("http://127.0.0.1:1", "one", self.app)
        companion.accept({"id": "activity", "revision": 1, "status": "active", "observationOwner": "desktop"})
        try:
            with patch("rabiroute_tray.desktop_pet_companion.start_qt_task", side_effect=lambda op, done: done(None,
                    HTTPError("http://127.0.0.1:1", 409, "Frame expired", {}, None))), \
                    patch.object(companion, "reconnect") as reconnect:
                companion._work(lambda: None)
                reconnect.assert_called_once_with()
        finally:
            companion.close()

    def test_scene_switch_speech_and_exit_keep_the_correct_context(self):
        controller = DesktopPetController("http://127.0.0.1:1", "one", lambda _: None,
            initial_binding=DesktopPetBinding(), event_stream=DesktopPetEventStream("http://127.0.0.1:1"))
        states = {key: DesktopPetState(key, "png-sequence", (), 12, True)
                  for key in ("idle", "talking", "companion-watch", "companion-play")}
        controller._pack = DesktopPetPack("test", "test", "one", 512, 512, .5, states,
            companion_states={"watch": "companion-watch", "play": "companion-play"})
        controller.window.show_on_desktop()
        active = {"id": "activity", "revision": 1, "version": 1, "status": "active",
                  "observationOwner": "desktop", "activityKind": "watch"}
        try:
            with patch.object(controller, "set_state") as state, patch.object(controller, "_apply_binding"):
                controller._companion_changed({"roleId": "one", "session": active})
                state.assert_called_with("companion-watch")
                controller._speech_changed({"status": "playing", "text": "comment"})
                state.assert_called_with("companion-watch")
                controller._companion_changed({"roleId": "one", "session": {**active, "version": 2, "activityKind": "play"}})
                state.assert_called_with("companion-play")
                state.reset_mock()
                controller._idle_action("sleep")
                state.assert_not_called()
                controller._speech_changed({"status": "finished"})
                controller._requested_state = "companion-play"
                controller._idle_scheduler._last_activity_at = time.monotonic() - 3600
                controller._companion_changed({"roleId": "one", "session": {**active, "version": 3, "status": "ended"}})
                state.assert_called_with("idle")
                self.assertLess(time.monotonic() - controller._idle_scheduler._last_activity_at, 1)
                controller._resume_context("companion-play")
                state.assert_called_with("idle")
        finally:
            controller.close()

if __name__ == "__main__":
    unittest.main()
