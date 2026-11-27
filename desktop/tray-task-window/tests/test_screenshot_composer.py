from __future__ import annotations

import os
import sys
import time
import unittest
import io
from urllib.error import HTTPError
from array import array
from types import SimpleNamespace
from pathlib import Path
from threading import Event
from unittest.mock import patch
from PySide6.QtCore import QBuffer, QObject, Qt, Signal
from PySide6.QtGui import QCursor, QInputMethodEvent, QPixmap
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QDialogButtonBox

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rabiroute_tray.screenshot_composer import ScreenshotComposer
from rabiroute_tray.manager_client import ManagerClient
from rabiroute_tray.system_selection import SelectionDeliveryTarget
from rabiroute_tray.screenshot_voice import ScreenshotVoiceInput


class FakeVoice(QObject):
    text_ready = Signal(int, str)
    failed = Signal(str)
    state_changed = Signal(int, str)

    def __init__(self, _manager, parent):
        super().__init__(parent)
        self.revision = 0
        self.active = False

    def start(self, model):
        self.revision += 1
        self.active = True

    def stop(self):
        self.revision += 1
        self.active = False

    def is_current(self, revision):
        return self.active and revision == self.revision


class FakeManager:
    manager_url = "http://localhost:12345"

    def __init__(self):
        self.preferences = {"voiceInputEnabled": False, "lastTarget": None}
        self.voice_error = None
        self.queries = []

    def screenshot_preferences(self):
        return dict(self.preferences)

    def save_screenshot_preferences(self, update):
        self.preferences.update(update)
        return dict(self.preferences)

    def screenshot_agents(self):
        return [{"provider": provider, "label": label}
                for provider, label in (("workbuddy", "WorkBuddy"), ("codex", "Codex"), ("dsh", "DSH"))]

    def screenshot_threads(self, provider, query, offset):
        self.queries.append((provider, query, offset))
        return {"code": 0, "threads": [{"id": f"{provider}-full-id-{offset}", "title": "同名对话", "cwd": f"C:/{provider}"}],
                "nextOffset": 100 if offset == 0 else None}

    def screenshot_projects(self, provider):
        return [f"C:/{provider}/one", f"C:/{provider}/two"]

    def screenshot_asr_model(self):
        if self.voice_error:
            raise ValueError(self.voice_error)
        return "api/model"

    def screenshot_voice_settings(self):
        return {"model": self.screenshot_asr_model(), "config": {}}


class ScreenshotComposerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.voice_patch = patch("rabiroute_tray.screenshot_composer.ScreenshotVoiceInput", FakeVoice)
        self.voice_patch.start()
        self.manager = FakeManager()
        self.composer = None
        self.cursor_at_start = QCursor.pos()

    def tearDown(self):
        if self.composer:
            self.composer.set_sending(False)
            self.composer.close()
        self.voice_patch.stop()
        QCursor.setPos(self.cursor_at_start)
        self.app.processEvents()

    def wait_for(self, predicate):
        end = time.monotonic() + 3
        while not predicate() and time.monotonic() < end:
            self.app.processEvents()
            time.sleep(.005)
        self.assertTrue(predicate())

    def open(self):
        self.composer = ScreenshotComposer(Path("missing.png"), [SelectionDeliveryTarget("role-route", "角色")], manager=self.manager)
        self.composer.show()
        self.wait_for(lambda: self.composer._preferences_loaded)
        return self.composer

    def click_item(self, view, row):
        QTest.mouseClick(view.viewport(), Qt.MouseButton.LeftButton, pos=view.visualItemRect(view.item(row)).center())

    def test_remembers_exact_agent_conversation_and_supports_paging_and_search(self):
        c = self.open()
        picker = c._target
        emitted = []
        c.send_requested.connect(lambda key, text: emitted.append((key, text)))
        QTest.mouseClick(picker, Qt.MouseButton.LeftButton)
        channels, threads = picker._channels, picker._threads
        icon_keys = set()
        for row, provider in enumerate(("workbuddy", "codex", "dsh"), start=1):
            item = channels.item(row)
            self.assertEqual(item.data(Qt.ItemDataRole.UserRole), provider)
            self.assertFalse(item.icon().isNull())
            icon_keys.add(item.icon().cacheKey())
        self.assertEqual(len(icon_keys), 3)
        QTest.mouseMove(channels.viewport(), channels.visualItemRect(channels.item(2)).center())
        self.wait_for(lambda: ("codex", "", 0) in self.manager.queries)
        self.assertIsNone(c.delivery_selection)
        QTest.mouseMove(channels.viewport(), channels.visualItemRect(channels.item(1)).center())
        self.wait_for(lambda: threads.count() == 3 and ("workbuddy", "", 0) in self.manager.queries)
        QTest.mouseMove(threads.viewport(), threads.visualItemRect(threads.item(1)).center())
        self.assertTrue(picker._panel.isVisible())
        self.click_item(threads, 1)
        self.wait_for(lambda: threads.count() == 3 and isinstance(threads.item(1).data(Qt.ItemDataRole.UserRole), dict))
        self.click_item(threads, 1)
        self.assertFalse(picker._panel.isVisible())
        self.assertEqual(c.delivery_selection["threadId"], "workbuddy-full-id-0")
        c._text.setPlainText("请检查")
        c._send()
        self.assertEqual(emitted, [("agent:workbuddy:workbuddy-full-id-0", "请检查")])
        self.wait_for(lambda: (self.manager.preferences.get("lastTarget") or {}).get("threadId") == "workbuddy-full-id-0")
        c.close()
        c = self.open()
        self.wait_for(lambda: c.delivery_selection is not None)
        self.assertEqual(c.delivery_selection["threadId"], "workbuddy-full-id-0")
        self.assertEqual(c.delivery_selection["provider"], "workbuddy")
        QTest.mouseClick(c._target, Qt.MouseButton.LeftButton)
        QTest.keyClicks(c._target, "old")
        self.wait_for(lambda: ("workbuddy", "old", 0) in self.manager.queries)
        QTest.keyClick(c._target, Qt.Key.Key_Escape)
        self.assertFalse(c._target._panel.isVisible())
        self.assertEqual(c.delivery_selection["threadId"], "workbuddy-full-id-0")

    def test_focus_search_and_keyboard_confirm_without_sending(self):
        c = self.open()
        picker = c._target
        emitted = []
        c.send_requested.connect(lambda *args: emitted.append(args))
        QTest.mouseClick(picker, Qt.MouseButton.LeftButton)
        QTest.keyClicks(picker, "C:/workbuddy")
        self.wait_for(lambda: picker._threads.count() == 3)
        self.assertEqual(self.manager.queries, [("workbuddy", "C:/workbuddy", 0)])
        QTest.keyClick(picker, Qt.Key.Key_Return)
        self.assertIsNone(c.delivery_selection)
        # Down lands on 新建会话 first; a second Down reaches the real task below it.
        QTest.keyClick(picker, Qt.Key.Key_Down)
        self.assertEqual(picker._threads.currentRow(), 0)
        QTest.keyClick(picker._threads, Qt.Key.Key_Down)
        QTest.keyClick(picker._threads, Qt.Key.Key_Return)
        self.assertEqual(c.delivery_selection["threadId"], "workbuddy-full-id-0")
        self.assertEqual(emitted, [])

    def test_switching_channel_ignores_a_late_reply_and_keeps_search(self):
        started, release, replied = Event(), Event(), Event()
        request_threads = self.manager.screenshot_threads

        def screenshot_threads(provider, query, offset):
            if provider == "workbuddy":
                started.set()
                release.wait(3)
                replied.set()
            return request_threads(provider, query, offset)
        self.manager.screenshot_threads = screenshot_threads
        picker = self.open()._target
        QTest.mouseClick(picker, Qt.MouseButton.LeftButton)
        QTest.keyClicks(picker, "history")
        try:
            self.wait_for(started.is_set)
            channels = picker._channels
            QTest.mouseMove(channels.viewport(), channels.visualItemRect(channels.item(1)).center())
            self.wait_for(lambda: picker._threads.count() == 3)
            self.assertIn(("codex", "history", 0), self.manager.queries)
        finally:
            release.set()
        self.wait_for(replied.is_set)
        QTest.qWait(40)
        self.click_item(picker._threads, 1)
        self.assertEqual(picker.selection["threadId"], "codex-full-id-0")

    def test_input_method_text_filters_roles_and_selects_a_role(self):
        picker = self.open()._target
        QTest.mouseClick(picker, Qt.MouseButton.LeftButton)
        event = QInputMethodEvent()
        event.setCommitString("角色")
        QApplication.sendEvent(picker, event)
        self.assertEqual(picker.text(), "角色")
        self.click_item(picker._channels, 0)
        self.assertEqual(picker.selection, {"kind": "role", "gatewayId": "role-route"})

    def test_missing_speech_opens_setup_without_enabling_or_saving_on(self):
        self.manager.voice_error = "没有可用模型"
        c = self.open()
        self.assertFalse(c._voice_toggle.isChecked())
        with patch("rabiroute_tray.screenshot_composer.QDesktopServices.openUrl") as opened:
            c._voice_toggle.setChecked(True)
            self.wait_for(lambda: opened.called)
            self.assertFalse(c._voice_toggle.isChecked())
            self.assertFalse(c._voice.active)
            self.assertEqual(opened.call_args.args[0].toString(), self.manager.manager_url + "/#/speech")
        self.assertFalse(self.manager.preferences["voiceInputEnabled"])

    def test_ready_speech_appends_draft_and_stale_or_closed_input_is_ignored(self):
        c = self.open()
        c._voice_toggle.setChecked(True)
        self.wait_for(lambda: c._voice.active)
        self.wait_for(lambda: self.manager.preferences["voiceInputEnabled"])
        revision = c._voice.revision
        c._voice.text_ready.emit(revision, "语音文字")
        self.assertEqual(c._text.toPlainText(), "语音文字")
        c._voice_toggle.setChecked(False)
        c._voice.text_ready.emit(revision, "过期")
        self.assertEqual(c._text.toPlainText(), "语音文字")
        c._voice_toggle.setChecked(True)
        self.wait_for(lambda: c._voice.active)
        c.close()
        self.assertFalse(c._voice.active)
        c._voice.text_ready.emit(c._voice.revision, "关闭后")
        self.assertEqual(c._text.toPlainText(), "语音文字")

    def test_role_target_shows_the_persona_avatar_instead_of_a_folder(self):
        png = QPixmap(24, 24)
        png.fill(Qt.GlobalColor.magenta)
        buffer = QBuffer()
        buffer.open(QBuffer.OpenModeFlag.WriteOnly)
        png.save(buffer, "PNG")

        class AvatarManager(FakeManager):
            def role_avatar(self, role_id):
                return bytes(buffer.data())

        buffered = AvatarManager()
        with patch("rabiroute_tray.screenshot_composer.ScreenshotVoiceInput", FakeVoice):
            composer = ScreenshotComposer(Path("missing.png"), [SelectionDeliveryTarget("role-route", "星海建造师", "XinghaI")],
                                          manager=buffered)
            composer.show()
            self.wait_for(lambda: composer._preferences_loaded)
            picker = composer._target
            QTest.mouseClick(picker, Qt.MouseButton.LeftButton)
            item = picker._channels.item(0)
            self.assertEqual(item.text(), "星海建造师")
            self.assertFalse(item.icon().isNull())
            self.wait_for(lambda: bool(picker._avatars.get("XinghaI")))
            self.assertFalse(picker._channels.item(0).icon().isNull())
            composer.close()

    def test_every_agent_end_offers_a_new_session_that_carries_the_image(self):
        c = self.open()
        picker = c._target
        QTest.mouseClick(picker, Qt.MouseButton.LeftButton)
        for row in (1, 2, 3):
            QTest.mouseMove(picker._channels.viewport(), picker._channels.visualItemRect(picker._channels.item(row)).center())
            self.wait_for(lambda: picker._threads.count() == 3)
            self.assertEqual(picker._threads.item(0).data(Qt.ItemDataRole.UserRole), "__new_session__",
                             f"row {row} ({picker._provider}) must offer 新建会话")

    def test_new_session_stage_selects_agent_and_project_without_touching_an_existing_task(self):
        c = self.open()
        picker = c._target
        emitted = []
        c.send_requested.connect(lambda key, text: emitted.append((key, text)))
        QTest.mouseClick(picker, Qt.MouseButton.LeftButton)
        QTest.mouseMove(picker._channels.viewport(), picker._channels.visualItemRect(picker._channels.item(2)).center())
        self.wait_for(lambda: picker._threads.count() == 3)
        self.click_item(picker._threads, 0)
        self.wait_for(lambda: picker._projects_view.count() == 2)
        self.assertTrue(picker._projects_view.isVisible())
        self.assertEqual(picker._projects_view.item(0).text(), "one · C:/codex/one")
        self.assertIsNone(c.delivery_selection)
        self.click_item(picker._projects_view, 1)
        self.assertFalse(picker._panel.isVisible())
        self.assertEqual(c.delivery_selection, {"kind": "new", "provider": "codex", "cwd": "C:/codex/two"})
        self.assertEqual(picker.text(), "Codex · 新建会话 · two")
        c._text.setPlainText("看图")
        c._send()
        self.assertEqual(emitted, [("agent:codex:", "看图")])

    def test_uncertain_delivery_only_reconciles_original_intent(self):
        c = self.open()
        QTest.mouseClick(c._target, Qt.MouseButton.LeftButton)
        self.click_item(c._target._channels, 0)
        emitted, reconciled = [], []
        c.send_requested.connect(lambda *args: emitted.append(args))
        c.set_delivery_uncertain(lambda: reconciled.append(True))
        c._send()
        c._reconcile.click()
        self.assertEqual(emitted, [])
        self.assertEqual(reconciled, [True])
        self.assertFalse(c._buttons.button(QDialogButtonBox.StandardButton.Ok).isEnabled())

    def test_microphone_worker_transcribes_one_segment_and_releases_the_device_on_stop(self):
        class Stream:
            count, closed = 0, False
            def __enter__(self): return self
            def __exit__(self, *_): self.closed = True
            def read(self, size, **_):
                time.sleep(.005)
                self.count += 1
                return array("h", [2000 if self.count <= 2 else 0] * size).tobytes()
            def stop_stream(self): pass
            def start_stream(self): pass
        stream = Stream()
        class AudioOwner:
            closed = False
            def __enter__(self): return self
            def __exit__(self, *_): self.closed = True
            def get_default_input_device_info(self): return {"defaultSampleRate": 16000, "index": 1}
            def open(self, **_): return stream
        owner = AudioOwner()
        inputs = []
        manager = SimpleNamespace(transcribe_screenshot_audio=lambda pcm, model, rate: inputs.append((len(pcm), model, rate)) or "识别结果")
        parent = QObject()
        voice = ScreenshotVoiceInput(manager, parent)
        texts = []
        voice.text_ready.connect(lambda revision, text: (texts.append(text), voice.stop()))
        settings = {"model": "api/model", "config": {"device": None, "chunkMs": 50, "silenceMs": 50,
                    "maxUtteranceMs": 1000, "minUtteranceMs": 50, "preRollMs": 0, "recordThreshold": .01}}
        with patch.dict(sys.modules, {"pyaudiowpatch": SimpleNamespace(PyAudio=lambda: owner, paInt16=8)}):
            voice.start(settings)
            self.wait_for(lambda: voice._task is None)
        self.assertEqual(texts, ["识别结果"])
        self.assertTrue(owner.closed and stream.closed)
        self.assertEqual(inputs[0][1:], ("api/model", 16000))


class ScreenshotManagerClientTest(unittest.TestCase):
    def client(self):
        return ManagerClient("http://localhost:12345", application_generation_id="generation", manager_instance_id="manager")

    def test_local_and_api_models_are_accepted_but_unavailable_selected_model_is_rejected(self):
        for provider in ("local", "api"):
            model = {"id": provider + "/model", "provider": provider, "model": "model", "capability": "asr",
                     "installed": True, "enabled": True, "available": True}
            c = self.client()
            def read(path, **_kwargs):
                if path.endswith("/models"):
                    return {"data": {"models": [model]}}
                if path.endswith("microphone/status"):
                    return {"data": {"config": {"asrModel": model["id"]}}}
                return {"data": {"state": "online"}}
            with patch.object(c, "_get_json", side_effect=read):
                self.assertEqual(c.screenshot_asr_model(), model["id"])
                model["available"] = False
                with self.assertRaises(ValueError):
                    c.screenshot_asr_model()

    def test_screenshot_is_addressed_to_exact_provider_and_thread_with_original_receipt_id(self):
        c = self.client()
        with patch.object(c, "_post_json", return_value={"code": 0, "ok": True, "status": "delivered"}) as post:
            result = c.send_screenshot_to_thread({"provider": "workbuddy", "threadId": "full-id", "cwd": "C:/work"}, "说明", "C:/capture.png", "delivery-original")
            self.assertTrue(result.ok)
            body = post.call_args.args[1]
            self.assertEqual((body["agentTargetId"], body["threadId"], body["imagePaths"], body["deliveryId"]),
                             ("local:workbuddy", "full-id", ["C:/capture.png"], "delivery-original"))
            self.assertFalse(body["createIfMissing"])
        with patch.object(c, "_post_json", side_effect=TimeoutError("lost response")):
            self.assertTrue(c.send_screenshot_to_thread({"provider": "codex", "threadId": "id"}, "", "image", "original").uncertain)
        rejection = HTTPError("http://localhost", 400, "uncertain owner acknowledgement", {}, io.BytesIO(b'{"uncertain":true,"message":"original receipt pending"}'))
        with patch.object(c, "_post_json", side_effect=rejection):
            self.assertTrue(c.send_screenshot_to_thread({"provider": "dsh", "threadId": "id"}, "", "image", "original").uncertain)


if __name__ == "__main__":
    unittest.main()
