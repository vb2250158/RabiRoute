import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
import unittest
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_client import DesktopPetBinding
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream


class PetMessagesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.events = DesktopPetEventStream("http://127.0.0.1:1")
        with patch.object(DesktopPetController, "_load_dialogue", lambda self: None), \
             patch("rabiroute_tray.desktop_pet_controller.DesktopPetSpeech.reconnect", lambda self: None), \
             patch("rabiroute_tray.desktop_pet_controller.DesktopPetCompanion.reconnect", lambda self: None):
            self.pet = DesktopPetController("http://127.0.0.1:1", "one", lambda _: None,
                initial_binding=DesktopPetBinding(), event_stream=self.events, speech_event_stream=self.events)
        self.pet.window.show()
        self.addCleanup(lambda: self.pet.close() if not self.pet._closed else None)

    def send(self, id="a", **kwargs):
        self.events.role_panel_message.emit(dict(roleId="one", messageId=id, text="Delivered\nmessage", **kwargs))

    def test_exact_text_isolation_duplicate_and_close(self):
        self.events.role_panel_message.emit(dict(roleId="two", messageId="a", text="Other"))
        self.assertFalse(self.pet.window._bubble.isVisible())
        self.send()
        self.assertEqual(self.pet.window._bubble._text.text(), "Delivered\nmessage")
        self.send()
        self.assertEqual(len(self.pet._pending_panel_messages), 0)
        self.pet.close()
        self.send("after-close")
        self.assertFalse(self.pet.window._bubble.isVisible())

    def test_live_sse_delivery_reaches_bubble(self):
        payload = dict(roleId="one", messageId="live", text="Live delivery")

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(("event: role_panel_message\ndata: " + json.dumps(payload) + "\n\n").encode())
                self.wfile.flush()

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        stream = DesktopPetEventStream(f"http://127.0.0.1:{server.server_port}")
        stream.role_panel_message.connect(self.pet._role_panel_message)
        try:
            stream.start()
            deadline = time.monotonic() + 3
            while not self.pet.window._bubble.isVisible() and time.monotonic() < deadline:
                QTest.qWait(20)
            self.assertEqual(self.pet.window._bubble._text.text(), "Live delivery")
        finally:
            stream.stop()
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_disabled_hidden_and_muted_are_not_replayed(self):
        self.pet._bubble_enabled = False
        self.send()
        self.pet._bubble_enabled = True
        self.pet.window.hide()
        self.send("hidden")
        self.pet.window.show()
        self.pet._muted_until = float("inf")
        self.send("muted")
        self.assertEqual(len(self.pet._pending_panel_messages), 0)
        self.assertFalse(self.pet.window._bubble.isVisible())

    def test_speech_defers_and_multiple_messages_display_in_order(self):
        self.pet._speech_job = dict(status="playing")
        self.send()
        self.events.role_panel_message.emit(dict(roleId="one", messageId="b", text="Second"))
        self.assertFalse(self.pet.window._bubble.isVisible())
        self.pet._speech_changed(dict(status="done", text="Finished speech"))
        self.assertEqual(self.pet.window._bubble._text.text(), "Delivered\nmessage")
        self.pet._panel_message_timer.stop()
        self.pet._show_next_panel_message()
        self.assertEqual(self.pet.window._bubble._text.text(), "Second")
