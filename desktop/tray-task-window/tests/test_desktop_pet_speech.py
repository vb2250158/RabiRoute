import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
import unittest
from unittest.mock import patch
from PySide6.QtCore import QObject, QPoint, QRect, QSize, Qt
from PySide6.QtGui import QPixmap
from PySide6.QtTest import QSignalSpy, QTest
from PySide6.QtWidgets import QApplication, QPushButton
from rabiroute_tray.desktop_pet_bubble import nine_slice_rects, place_dialogue_bubble
from rabiroute_tray.desktop_pet_bubble_settings import DesktopPetBubbleSettings
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_speech import DesktopPetSpeech
from rabiroute_tray.desktop_pet_client import DesktopPetClient
from rabiroute_tray.qt_async import wait_for_qt_tasks
from rabiroute_tray.desktop_pet_window import DesktopPetWindow


class PetSpeechTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        # These are presentation tests; do not send transcript persistence to a real endpoint.
        recorder = patch.object(DesktopPetClient, "record_speech", return_value={})
        recorder.start()
        self.addCleanup(recorder.stop)

    def tearDown(self):
        # Match the Qt host's shutdown ownership before QApplication is destroyed.
        self.assertTrue(wait_for_qt_tasks(5000))
        self.app.processEvents()

    def test_voice_isolation_completion_and_stale_snapshot(self):
        parent = QObject()
        events = DesktopPetEventStream("http://127.0.0.1:1")
        speech = DesktopPetSpeech("http://127.0.0.1:1", "persona-one", events, parent)
        changed = QSignalSpy(speech.changed)
        job = dict(id="one", voice="persona-one", text="hello", status="playing", started_at=1, updated_at=1)
        speech.accept(dict(current="other", jobs=[dict(job, id="other", voice="persona-two")]))
        self.assertEqual(changed.count(), 0)
        speech.accept(dict(current="one", jobs=[job]))
        speech.accept(dict(current=None, jobs=[dict(job, status="done", updated_at=2)]))
        speech.accept(dict(current="one", jobs=[job]), current_only=True)
        self.assertEqual(changed.count(), 2)
        self.assertEqual(speech._job["status"], "done")
        speech.close()
        events.playback_changed.emit(dict(current="one", jobs=[job]))
        self.assertEqual(changed.count(), 2)

    def test_reconnect_does_not_show_completed_history(self):
        parent = QObject()
        speech = DesktopPetSpeech("http://127.0.0.1:1", "persona-one", DesktopPetEventStream("http://127.0.0.1:1"), parent)
        changed = QSignalSpy(speech.changed)
        speech.accept(dict(current=None, jobs=[dict(id="old", voice="persona-one", text="old", status="done")]), current_only=True)
        self.assertEqual(changed.count(), 0)
        speech.close()


    def test_bubble_scrollbar_keeps_custom_text_skin_opacity_and_tracks_style_updates(self):
        from rabiroute_tray.desktop_pet_bubble import DesktopPetBubble
        from rabiroute_tray.theme import apply_rabi_application_theme
        from PySide6.QtGui import QPalette
        bubble = DesktopPetBubble(Qt.WindowType.Tool)
        original_palette, original_stylesheet = self.app.palette(), self.app.styleSheet()
        try:
            bubble.apply_style(dict(skin="plain", maxWidth=320, textColor="#123456", backgroundColor="#abcdef", borderColor="#654321", opacity=.7))
            bubble.set_content("Long bubble content. " * 160)
            bubble.show()
            self.app.processEvents()
            vertical = bubble._scroll.verticalScrollBar()
            self.assertTrue(vertical.isVisible())
            self.assertEqual(vertical.width(), 6)
            self.assertEqual(bubble._scroll.horizontalScrollBarPolicy(), Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
            for theme in ("light", "dark"):
                apply_rabi_application_theme(self.app, theme)
                self.app.processEvents()
                self.assertEqual(vertical.width(), 6)
                self.assertEqual(bubble._text.palette().color(QPalette.ColorRole.WindowText).name(), "#123456")
                self.assertIn("rgba(18, 52, 86, 122)", bubble._scroll.styleSheet())
                self.assertEqual(bubble._style["skin"], "plain")
                self.assertEqual(bubble._style["backgroundColor"], "#abcdef")
                self.assertEqual(bubble._style["borderColor"], "#654321")
                self.assertAlmostEqual(bubble.windowOpacity(), .7, delta=.01)
            bubble.apply_style(dict(textColor="#abcdef", opacity=.8))
            self.assertIn("rgba(171, 205, 239, 122)", bubble._scroll.styleSheet())
            self.assertEqual(bubble._text.palette().color(QPalette.ColorRole.WindowText).name(), "#abcdef")
        finally:
            bubble.close()
            bubble.deleteLater()
            self.app.setPalette(original_palette)
            self.app.setStyleSheet(original_stylesheet)

    def test_bubble_long_plain_text_lifetime_and_click_through(self):
        window = DesktopPetWindow()
        try:
            window.show()
            text = "<b>不是 HTML</b>\n" + "一段较长的语音。" * 80
            window.show_speech_bubble(text, playing=True)
            self.assertEqual(window._bubble._text.text(), text)
            self.assertEqual(window._bubble._text.textFormat(), Qt.TextFormat.PlainText)
            self.assertLessEqual(window._bubble._scroll.height(), 180)
            self.assertFalse(window._bubble_timer.isActive())
            self.assertEqual(window._bubble.findChildren(QPushButton), [])
            window.set_bubble_style(dict(fontSize=20, maxWidth=400, displaySeconds=12, textColor="#123456"))
            window.show_speech_bubble(text, playing=False)
            self.assertEqual(window._bubble.width(), 400)
            self.assertEqual(window._bubble._text.font().pixelSize(), 20)
            self.assertEqual(window._bubble_timer.interval(), 12000)
            self.assertTrue(window._bubble_timer.isActive())
            window.set_click_through(True)
            self.assertTrue(window._bubble.windowFlags() & Qt.WindowType.WindowTransparentForInput)
            window.hide()
            self.assertFalse(window._bubble.isVisible())
        finally:
            window.close()

    def test_nine_slice_preserves_corner_dimensions_and_covers_canvas(self):
        short = list(nine_slice_rects(1254, 1254, 220, 104))
        long = list(nine_slice_rects(1254, 1254, 480, 256))
        self.assertEqual(len(short), 9)
        self.assertEqual(short[-1][0].size(), long[-1][0].size())
        self.assertEqual(short[-1][1], long[-1][1])
        self.assertEqual(sum(d.width() * d.height() for d, _ in short), 220 * 104)
        dialog = DesktopPetBubbleSettings(dict(maxWidth=280, fontSize=18))
        try:
            dialog._change("maxWidth", 400)
            self.assertEqual(dialog.preview.width(), 400)
            self.assertFalse(dialog.preview._skin.isNull())
        finally:
            dialog.close()

    def test_pointer_tracks_pet_after_frame_is_clamped_at_screen_edges(self):
        area = QRect(-1920, 0, 1920, 1080)
        for anchor in (QRect(-1800, 500, 140, 200), QRect(-1910, 500, 60, 200),
                       QRect(-80, 500, 60, 200)):
            position, tip, upward = place_dialogue_bubble(anchor, QSize(320, 104), area)
            self.assertEqual(position.x() + tip, anchor.center().x())
            self.assertGreaterEqual(position.x(), area.left())
            self.assertLessEqual(position.x() + 319, area.right())
            self.assertEqual(position.y() + 104 + 8, anchor.top())
            self.assertFalse(upward)
        anchor = QRect(-900, 10, 140, 200)
        position, tip, upward = place_dialogue_bubble(anchor, QSize(320, 104), area)
        self.assertTrue(upward)
        self.assertEqual(position.y(), anchor.bottom() + 9)
        self.assertEqual(position.x() + tip, anchor.center().x())

    def test_visible_anchor_excludes_transparent_padding_and_follows_facing(self):
        window = DesktopPetWindow()
        try:
            window.resize(300, 300)
            window._label.setGeometry(window.rect())
            pixmap = QPixmap(300, 300)
            pixmap.fill(Qt.GlobalColor.transparent)
            window._label.setPixmap(pixmap)
            window._sprite_bounds = QRect(40, 70, 90, 160)
            window._sprite_canvas = QSize(300, 300)
            window._facing_left = False
            origin = window._label.mapToGlobal(QPoint(0, 0))
            self.assertEqual(window._visible_sprite_rect(), QRect(40, 70, 90, 160).translated(origin))
            window._facing_left = True
            self.assertEqual(window._visible_sprite_rect(), QRect(170, 70, 90, 160).translated(origin))
            window._bubble.set_tail_anchor(50, True)
            self.assertTrue(window._bubble._tail_up)
            self.assertEqual(window._bubble._tail_x, 50)
            self.assertEqual(window._bubble._layout.contentsMargins().top(), 32)
        finally:
            window.close()


if __name__ == "__main__":
    unittest.main()
