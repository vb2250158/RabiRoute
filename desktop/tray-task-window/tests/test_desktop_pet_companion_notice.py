import unittest
import os
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import Mock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from rabiroute_tray.desktop_pet_companion_notice import CompanionFailureNotice


class CompanionFailureNoticeTest(unittest.TestCase):
    def test_offscreen_controller_shows_real_bubble_once_per_failure_incident(self):
        from PySide6.QtWidgets import QApplication
        from rabiroute_tray.desktop_pet_controller import DesktopPetController
        from rabiroute_tray.desktop_pet_client import DesktopPetBinding
        from rabiroute_tray.desktop_pet_companion import DesktopPetCompanion
        from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
        from rabiroute_tray.desktop_pet_speech import DesktopPetSpeech
        type(self)._app = QApplication.instance() or QApplication([])
        app = type(self)._app
        with ExitStack() as stack:
            # Concrete functions avoid native signal inspection of MagicMock on QObject classes.
            for cls, name in ((DesktopPetController, "_load_dialogue"), (DesktopPetSpeech, "reconnect"),
                              (DesktopPetCompanion, "reconnect"), (DesktopPetEventStream, "start"),
                              (DesktopPetEventStream, "stop")):
                stack.enter_context(patch.object(cls, name, lambda *args, **kwargs: None))
            pet = DesktopPetController("http://127.0.0.1:1", "fixture", lambda _: None,
                initial_binding=DesktopPetBinding(), event_stream=DesktopPetEventStream("http://127.0.0.1:1"))
            try:
                # The fixture has no configured animation pack; keep its manually shown window.
                pet._binding_snapshot = None
                pet.window.show()
                app.processEvents()
                shown = []
                original = pet.window.show_bubble
                def show(text):
                    shown.append(text)
                    original(text)
                pet.window.show_bubble = show
                failed = {"status": "failed", "error": "fixture read failure", "errorCode": "COMPANION_CONTEXT_FAILED"}
                for version, review in enumerate((failed, None, {"status": "dispatching"}, failed,
                                                 {"status": "replied"}, failed), 1):
                    pet._companion_changed({"roleId": "fixture", "session": {
                        "id": "fixture", "version": version, "status": "active", "review": review}})
                    app.processEvents()
                self.assertEqual(shown, ["陪伴资料读取失败", "陪伴资料读取失败"])
                self.assertTrue(pet.window._bubble.isVisible())
            finally:
                pet.close()
                app.processEvents()

    def test_controller_reports_one_classified_failure_across_review_retries(self):
        from rabiroute_tray.desktop_pet_controller import DesktopPetController
        from rabiroute_tray.desktop_pet_dialogue import DesktopPetDialogue
        controller = SimpleNamespace(persona_id="one", _companion_session={}, _companion=Mock(),
            _binding_snapshot=None, _idle_scheduler=Mock(), _configure_idle_scheduler=Mock(),
            _wander_timer=Mock(), window=Mock(travelling=False, pointer_engaged=False),
            _context_menu=None, _resume_context=Mock(), _arm_wander=Mock(), visible=True,
            _muted_until=0, _companion_failure_notice=CompanionFailureNotice(), _dialogue=DesktopPetDialogue())
        failed = {"status": "failed", "error": "catalog unavailable", "errorCode": "COMPANION_CONTEXT_FAILED"}
        for version, review in enumerate((failed, None, {"status": "dispatching"}, failed,
                                         {"status": "replied"}, failed), 1):
            DesktopPetController._companion_changed(controller, {"roleId": "one", "session": {
                "id": "one", "version": version, "status": "active", "review": review}})
        self.assertEqual([call.args[0] for call in controller.window.show_bubble.call_args_list],
                         ["陪伴资料读取失败", "陪伴资料读取失败"])

    def test_retry_and_empty_review_do_not_clear_incident_but_reply_does(self):
        notice = CompanionFailureNotice()
        failed = {"status": "failed", "error": "catalog cold", "errorCode": "COMPANION_CONTEXT_FAILED"}
        def update(review, session_id="one", visible=True):
            return notice.update({"id": session_id, "review": review}, can_notify=visible)
        self.assertEqual(update(failed), "companionContextFailed")
        for review in (None, {"status": "dispatching"}, {"status": "delivered"}, {"status": "expired"}):
            self.assertIsNone(update(review))
            self.assertIsNone(update(failed))
        update({"status": "replied"})
        self.assertEqual(update(failed), "companionContextFailed")
        self.assertEqual(update(failed, "two"), "companionContextFailed")

    def test_hidden_failure_is_not_marked_shown_and_unknown_errors_are_not_network_errors(self):
        notice = CompanionFailureNotice()
        session = {"id": "one", "review": {"status": "failed", "error": "network-like text"}}
        self.assertIsNone(notice.update(session, can_notify=False))
        self.assertEqual(notice.update(session, can_notify=True), "companionProcessingFailed")
        session["review"]["errorCode"] = "COMPANION_CONTEXT_FAILED"
        self.assertEqual(notice.update(session, can_notify=True), "companionContextFailed")
