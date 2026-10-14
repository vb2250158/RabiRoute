from __future__ import annotations

import os
import unittest
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QPoint
from PySide6.QtWidgets import QApplication

from rabiroute_tray.desktop_pet_client import DesktopPetBinding, DesktopPetPack, DesktopPetState
from rabiroute_tray.desktop_pet_companion import DesktopPetCompanion
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_speech import DesktopPetSpeech


class CompanionModesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def make_companion(self) -> DesktopPetCompanion:
        companion = DesktopPetCompanion("http://127.0.0.1:1", "persona", self.app)
        self.addCleanup(companion.close)
        return companion

    def make_controller(self) -> DesktopPetController:
        with patch.object(DesktopPetCompanion, "reconnect"), patch.object(DesktopPetSpeech, "reconnect"), \
                patch.object(DesktopPetEventStream, "start"):
            controller = DesktopPetController("http://127.0.0.1:1", "persona", lambda _: None,
                initial_binding=DesktopPetBinding(), event_stream=DesktopPetEventStream("http://127.0.0.1:1"))
        self.addCleanup(controller.close)
        return controller

    def test_fresh_directory_populates_modes_without_a_fixed_client_catalog(self) -> None:
        companion = self.make_companion()
        directory = [{"id": "adaptive", "label": "自动陪伴"}, {"id": "custom-focus", "label": "自定义专注"}]
        callback = []
        with patch("rabiroute_tray.desktop_pet_companion.start_qt_task",
                   side_effect=lambda op, done: callback.append(done)):
            companion._work(lambda: None)
        callback[0](None, {"presets": directory, "session": None})

        self.assertEqual(companion.presets, directory)
        self.assertEqual(companion.session, {})

    def test_select_mode_starts_the_requested_mode_when_no_activity_exists(self) -> None:
        companion = self.make_companion()
        with patch.object(companion, "_work") as work:
            companion.select_mode("work")
        operation = work.call_args.args[0]
        with patch.object(companion, "_request", side_effect=[{"session": None}, {"session": {}}]) as request:
            operation()

        self.assertEqual(request.call_args_list[0].args, ())
        self.assertEqual(request.call_args_list[1].args[0], "start")
        body = request.call_args_list[1].args[1]
        self.assertEqual(body["presetId"], "work")
        self.assertEqual(body["observationOwner"], "desktop")
        self.assertTrue(body["requestId"])
        self.assertTrue(work.call_args.kwargs["control"])

    def test_switch_uses_fresh_revision_without_replacing_or_stopping_the_activity(self) -> None:
        companion = self.make_companion()
        companion.session = {"id": "activity", "revision": 3, "presetId": "watch", "status": "active"}
        fresh = {**companion.session, "revision": 8}
        with patch.object(companion, "_work") as work:
            companion.select_mode("work")
        with patch.object(companion, "_request", side_effect=[{"session": fresh}, {"session": fresh}]) as request:
            work.call_args.args[0]()

        self.assertEqual(request.call_args_list[1].args, ("command", {
            "sessionId": "activity", "revision": 8, "action": "set-mode", "presetId": "work"}))
        self.assertEqual(len(request.call_args_list), 2)
        self.assertEqual(companion.session["presetId"], "watch")

    def test_current_mode_is_a_read_only_noop_even_when_manually_paused(self) -> None:
        companion = self.make_companion()
        paused = {"id": "activity", "revision": 2, "presetId": "work", "status": "paused", "pauseReason": "user"}
        with patch.object(companion, "_work") as work:
            companion.select_mode("work")
        with patch.object(companion, "_request", return_value={"session": paused}) as request:
            result = work.call_args.args[0]()

        request.assert_called_once_with()
        self.assertEqual(result["session"], paused)

    def test_mode_command_readback_preserves_session_and_notes_and_resets_frame_sequence(self) -> None:
        companion = self.make_companion()
        original = {"id": "activity", "revision": 2, "version": 4, "status": "active", "presetId": "watch",
                    "observationOwner": "desktop", "notes": [{"text": "earlier discussion"}]}
        companion.accept(original)
        companion._sequence = 9
        callback = []
        with patch("rabiroute_tray.desktop_pet_companion.start_qt_task",
                   side_effect=lambda op, done: callback.append(done)):
            companion.select_mode("work")
        changed = {**original, "revision": 3, "version": 5, "presetId": "work", "activityKind": "work"}
        callback[0](None, {"session": changed, "presets": [{"id": "work", "label": "工作陪伴"}]})

        self.assertEqual(companion.session["id"], original["id"])
        self.assertEqual(companion.session["notes"], original["notes"])
        self.assertEqual(companion.session["presetId"], "work")
        self.assertEqual(companion._sequence, 0)
        self.assertFalse(companion.control_busy)

    def test_busy_or_closed_companion_does_not_issue_mode_commands(self) -> None:
        companion = self.make_companion()
        with patch.object(companion, "_work") as work:
            companion.control_busy = True
            companion.select_mode("work")
            companion.control_busy = False
            companion.closed = True
            companion.select_mode("work")
        work.assert_not_called()

    def test_menu_uses_manager_labels_ids_and_current_selection(self) -> None:
        controller = self.make_controller()
        controller._companion.presets = [
            {"id": "work", "label": "工作陪伴"}, {"id": "custom-focus", "label": "自定义专注"}]
        controller._companion_session = {"id": "activity", "presetId": "work", "status": "active", "activityKind": "work"}
        with patch("rabiroute_tray.desktop_pet_controller.QMenu.popup"):
            controller._show_context_menu(QPoint(20, 20))
        menu = next(action.menu() for action in controller._context_menu.actions() if action.text() == "陪伴方式")
        self.assertEqual([action.text() for action in menu.actions()], ["工作陪伴", "自定义专注"])
        self.assertEqual([action.isChecked() for action in menu.actions()], [True, False])
        with patch.object(controller._companion, "select_mode") as select:
            menu.actions()[1].trigger()
        select.assert_called_once_with("custom-focus")

    def test_work_pose_uses_declared_loop_then_thinking_then_idle(self) -> None:
        controller = self.make_controller()
        states = {name: DesktopPetState(name, "png-sequence", (), 12, True)
                  for name in ("idle", "thinking", "desk")}
        controller._pack = DesktopPetPack("pack", "Pack", "persona", 512, 512, .5, states,
                                        companion_states={"work": "desk"})
        controller._companion_session = {"status": "active", "activityKind": "work"}
        self.assertEqual(controller._companion_state(), "desk")
        states["desk"] = DesktopPetState("desk", "png-sequence", (), 12, False, "idle")
        self.assertEqual(controller._companion_state(), "thinking")
        states.pop("thinking")
        self.assertEqual(controller._companion_state(), "idle")
        controller._companion_session["status"] = "paused"
        self.assertEqual(controller._companion_state(), "")

    def test_work_speech_keeps_work_pose_and_exit_restores_ordinary_context(self) -> None:
        controller = self.make_controller()
        states = {name: DesktopPetState(name, "png-sequence", (), 12, True) for name in ("idle", "thinking", "talking")}
        controller._pack = DesktopPetPack("pack", "Pack", "persona", 512, 512, .5, states)
        controller.window.show()
        work = {"id": "activity", "revision": 2, "version": 3, "status": "active", "presetId": "work",
                "activityKind": "work", "observationOwner": "desktop"}
        with patch.object(controller, "set_state") as state, patch.object(controller, "_apply_binding"):
            controller._companion_changed({"roleId": "persona", "session": work})
            state.assert_called_with("thinking")
            controller._speech_changed({"status": "playing", "text": "requested help"})
            state.assert_called_with("thinking")
            self.assertFalse(controller._idle_scheduler._active)
            controller._speech_changed({"status": "finished"})
            controller._companion_changed({"roleId": "persona", "session": {
                **work, "revision": 3, "version": 4, "status": "ended"}})
            state.assert_called_with("idle")
            self.assertTrue(controller._idle_scheduler._active)


if __name__ == "__main__":
    unittest.main()
