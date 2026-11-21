import os
import time
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication
from PySide6.QtTest import QTest
from rabiroute_tray.desktop_pet_window import DesktopPetWindow
from rabiroute_tray.desktop_pet_assistant import speech_bubble_segment, AssistantPresentation


class BubbleStackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_new_sentences_push_old_bubbles_up_and_expire_independently(self):
        window = DesktopPetWindow()
        window.show()
        window.set_bubble_style({"maxVisible": 3, "displaySeconds": 12})
        try:
            for index in range(4):
                window.show_speech_bubble(f"第{index}句。", playing=True, key=str(index))
            self.assertEqual(len(window._previous_bubbles), 2)
            self.assertEqual([bubble._text.text() for bubble, _ in window._previous_bubbles], ["第1句。", "第2句。"])
            previous = window._previous_bubbles[0][0]
            window.show_speech_bubble("第3句更新。", playing=True, key="3")
            self.assertEqual(len(window._previous_bubbles), 2)
            self.assertIs(window._previous_bubbles[0][0], previous)
            bubble, _ = window._previous_bubbles[0]
            window._previous_bubbles[0] = (bubble, time.monotonic() - 1)
            window._expire_bubbles()
            self.assertEqual(len(window._previous_bubbles), 1)
            self.assertTrue(window._bubble.isVisible())
            window.show_speech_bubble("第3句更新。", playing=False, key="3")
            deadline = window._bubble_deadline
            window.show_speech_bubble("第3句更新。", playing=False, key="3")
            self.assertEqual(window._bubble_deadline, deadline)
            window.set_bubble_style({"maxVisible": 1})
            self.assertFalse(window._previous_bubbles)
            window.hide_bubble()
            self.assertFalse(window._bubble_timer.isActive())
        finally:
            window.close()

    def test_assistant_projects_only_the_current_spoken_segment_with_persona_fence(self):
        self.assertEqual(speech_bubble_segment("第一句。第二句。", 6), (4, "第二句。"))
        state = AssistantPresentation("test")
        value = dict(personaId="test", ownerId="owner", ownerStartedAt=1, revision=1,
                     responseId="response", playbackId="audio", text="旧文字。第一句。第二句。",
                     speechText="第一句。第二句。", textOffset=4, spokenEnd=10, speechStatus="playing")
        job = state.accept(value, {})
        self.assertEqual(job["text"], "第二句。")
        self.assertTrue(job["bubbleKey"].endswith(":4"))
        self.assertIsNone(state.accept(dict(value, personaId="other", revision=2), job))

    def test_live_transcript_and_reply_use_separate_windows_inside_the_work_area(self):
        window = DesktopPetWindow()
        area = QApplication.primaryScreen().availableGeometry()
        window.move(area.right() - window.width() + 1, area.bottom() - window.height() + 1)
        window.show()
        try:
            window.show_speech_bubble("这是桌宠的回复。", playing=True, key="reply")
            window.set_transcript_preview(("", False))
            bubble = window._transcript_bubble
            self.assertTrue(bubble.isVisible())
            self.assertEqual(bubble.status.text(), "你 · 正在转写")
            window.set_transcript_preview(("这是语音转", False))
            window.set_transcript_preview(("这是语音转写的最终稿。", True))
            self.assertEqual(bubble.status.text(), "你 · 转写完成")
            self.assertEqual(bubble.text.text(), "这是语音转写的最终稿。")
            self.assertTrue(bubble.windowFlags() & Qt.WindowType.WindowTransparentForInput)
            self.assertTrue(window._bubble.isVisible())
            self.assertEqual(window._bubble._text.text(), "这是桌宠的回复。")
            self.assertFalse(window._previous_bubbles)
            for _ in range(2):
                self.assertTrue(area.contains(bubble.frameGeometry()))
                self.assertFalse(bubble.frameGeometry().intersects(window._visible_sprite_rect()))
                self.assertFalse(bubble.frameGeometry().intersects(window._bubble.placement_bounds()))
                window.move(area.topLeft())
            window.set_transcript_preview(None)
            self.assertFalse(bubble.isVisible())
            self.assertEqual(bubble.text.text(), "")
            self.assertTrue(window._bubble.isVisible())
        finally:
            window.close()

    def test_old_tail_retracts_and_repeated_updates_do_not_restart_motion_or_erase_text(self):
        window = DesktopPetWindow()
        window.move(300, 500)
        window.show()
        try:
            window.show_speech_bubble("第一句。", playing=True, key="first")
            QTest.qWait(300)
            first = window._bubble
            window.show_speech_bubble("第二句。", playing=True, key="second")
            target = first._motion_target
            for _ in range(8):
                window.set_bubble_style({})
                window.show_speech_bubble("第二句。", playing=True, key="second")
            QTest.qWait(320)
            self.assertAlmostEqual(first._tail_progress, 0)
            self.assertAlmostEqual(window._bubble._tail_progress, 1)
            self.assertEqual(first.pos(), target)
            self.assertEqual(first._text.text(), "第一句。")
            window.finish_speech_bubble()
            self.assertTrue(window._bubble.isVisible())
            self.assertEqual(len(window._previous_bubbles), 1)
            deadline = window._bubble_deadline
            window.finish_speech_bubble()
            self.assertEqual(window._bubble_deadline, deadline)
        finally:
            window.hide_bubble()
            window.close()
