import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
import unittest
from unittest.mock import patch, MagicMock, PropertyMock

from PySide6.QtWidgets import QApplication
from rabiroute_tray.desktop_pet_dialogue import DesktopPetDialogue, parse_desktop_pet_dialogue
from rabiroute_tray.desktop_pet_client import DesktopPetBinding, DesktopPetClient
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_companion import DesktopPetCompanion
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_speech import DesktopPetSpeech


class PetDialogueTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self._original_loader = DesktopPetController._load_dialogue
        for target in ((DesktopPetController, "_load_dialogue"), (DesktopPetSpeech, "reconnect"),
                       (DesktopPetCompanion, "reconnect"), (DesktopPetEventStream, "start"),
                       (DesktopPetEventStream, "stop")):
            mocked = patch.object(*target)
            mocked.start()
            self.addCleanup(mocked.stop)

    def controller(self, persona):
        controller = DesktopPetController("http://127.0.0.1:1", persona, lambda _: None,
            initial_binding=DesktopPetBinding(), event_stream=DesktopPetEventStream("http://127.0.0.1:1"))
        self.addCleanup(controller.close)
        controller._hidden = False
        controller.window.show()
        return controller

    def test_missing_config_is_neutral_and_configured_lines_do_not_cross_personas(self):
        visible = patch.object(DesktopPetController, "visible", new_callable=PropertyMock, return_value=True)
        visible.start()
        self.addCleanup(visible.stop)
        cat = self.controller("cat-persona")
        other = self.controller("other-persona")
        cat._dialogue = parse_desktop_pet_dialogue({"data": {"personaId": "cat-persona", "dialogue": {
            "openers": {"watch": "一起看，喵。"}, "fallbacks": {"managerInterrupted": "断线了喵。"}
        }}}, "cat-persona")
        for controller in (cat, other):
            with patch.object(controller.window, "show_bubble") as bubble:
                for kind in ("watch", "play", "work"):
                    controller._companion_changed({"roleId": controller.persona_id, "session": {
                        "id": "session", "version": 1, "status": "active", "activityKind": kind}})
                controller._event_connection_changed(False)
                texts = [call.args[0] for call in bubble.call_args_list]
                self.assertGreaterEqual(len(texts), 4)
                if controller is other:
                    self.assertTrue(all("喵" not in text and "cat-persona" not in text for text in texts))
                else:
                    self.assertIn("一起看，喵。", texts)
                    self.assertIn("断线了喵。", texts)
        other._dialogue = DesktopPetDialogue(openers={"work": "一起看星星。"})
        self.assertEqual(other._dialogue.line("openers", "work"), "一起看星星。")
        self.assertEqual(cat._dialogue.line("openers", "watch"), "一起看，喵。")

    def test_wrong_persona_payload_rejected_and_bad_fields_use_neutral_fallback(self):
        with self.assertRaises(ValueError):
            parse_desktop_pet_dialogue({"data": {"personaId": "cat-persona"}}, "other-persona")
        parsed = parse_desktop_pet_dialogue({"data": {"personaId": "other-persona", "dialogue": {
            "openers": {"work": 123, "watch": " "}, "fallbacks": []}}}, "other-persona")
        self.assertEqual(parsed, DesktopPetDialogue())
        self.assertNotIn("喵", parsed.line("openers", "watch"))

    def test_speech_persists_only_matching_playing_job_and_deduplicates_pending_events(self):
        parent = self.app
        speech = DesktopPetSpeech("http://127.0.0.1:1", "other-persona", DesktopPetEventStream("http://127.0.0.1:1"), parent)
        self.addCleanup(speech.close)
        job = dict(id="job", voice="other-persona", text="你好", started_at=1, status="playing")
        with patch("rabiroute_tray.desktop_pet_speech.start_qt_task") as start:
            speech.accept(dict(current="job", jobs=[dict(job, voice="cat-persona", text="喵")]))
            self.assertEqual(start.call_count, 0)
            speech.accept(dict(current="job", jobs=[job]))
            speech.accept(dict(current="job", jobs=[job]))
            self.assertEqual(start.call_count, 1)
            speech.accept(dict(current="stale", jobs=[dict(job, id="stale", started_at=0.5)]))
            self.assertEqual(start.call_count, 1)
            operation, completed = start.call_args.args
            with patch.object(speech._client, "record_speech") as persist:
                operation()
                persist.assert_called_once_with(job)
            completed(MagicMock(), None)
            speech.accept(dict(current="job", jobs=[job]))
            self.assertEqual(start.call_count, 1)

    def test_client_rejects_foreign_voice_before_any_request(self):
        with self.assertRaises(ValueError), patch("rabiroute_tray.desktop_pet_client.urlopen") as opened:
            DesktopPetClient("http://127.0.0.1:1", "other-persona").record_speech(dict(voice="cat-persona"))
        opened.assert_not_called()

    def test_persistence_retries_are_bounded_and_closed_pet_does_not_retry(self):
        speech = DesktopPetSpeech("http://127.0.0.1:1", "other-persona", DesktopPetEventStream("http://127.0.0.1:1"), self.app)
        self.addCleanup(speech.close)
        job = dict(id="job", voice="other-persona", text="你好", started_at=1, status="playing")
        with patch("rabiroute_tray.desktop_pet_speech.start_qt_task") as start, \
                patch("rabiroute_tray.desktop_pet_speech.QTimer.singleShot") as timer, \
                self.assertLogs("rabiroute_tray.desktop_pet_speech", level="WARNING"):
            speech.accept(dict(current="job", jobs=[job]))
            for attempt in range(3):
                completed = start.call_args.args[1]
                completed(None, OSError("unavailable"))
                speech.accept(dict(current="job", jobs=[job]))
                self.assertEqual(start.call_count, attempt + 1)
                if attempt < 2:
                    timer.call_args.args[2]()
            self.assertEqual(start.call_count, 3)
            self.assertEqual(timer.call_count, 2)
        with patch("rabiroute_tray.desktop_pet_speech.start_qt_task") as start:
            speech.close()
            speech._record_transcript(dict(job, id="later"))
            start.assert_not_called()

    def test_reload_ignores_inflight_stale_configuration_and_failure_remains_neutral(self):
        controller = self.controller("other-persona")
        controller._dialogue = DesktopPetDialogue(openers={"watch": "旧配置"})
        original_loader = self._original_loader
        with patch("rabiroute_tray.desktop_pet_controller.start_qt_task", side_effect=[object(), object()]) as start:
            original_loader(controller)
            task = controller._dialogue_task
            original_loader(controller)
            self.assertEqual(controller._dialogue, DesktopPetDialogue())
            with patch.object(controller, "_load_dialogue", side_effect=lambda: original_loader(controller)):
                start.call_args.args[1](task, DesktopPetDialogue(openers={"watch": "过时结果"}))
            self.assertEqual(start.call_count, 2)
            self.assertEqual(controller._dialogue, DesktopPetDialogue())
            start.call_args.args[1](controller._dialogue_task, OSError("unavailable"))
            self.assertEqual(controller._dialogue, DesktopPetDialogue())
            self.assertIsNone(controller._dialogue_task)


if __name__ == "__main__":
    unittest.main()
