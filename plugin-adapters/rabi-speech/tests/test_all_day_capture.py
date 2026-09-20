from dataclasses import dataclass, replace
from unittest.mock import patch
import unittest
import importlib.util
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
spec = importlib.util.spec_from_file_location("all_day_capture", Path(__file__).parents[1] / "rabispeech" / "all_day_capture.py")
capture_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = capture_module
spec.loader.exec_module(capture_module)
register_all_day_capture = capture_module.register_all_day_capture
capture_sources = capture_module.capture_sources


@dataclass
class Config:
    session_id: str = "resident"


class Microphone:
    def __init__(self):
        self.config = Config()
        self.running = False
        self.remote = False
        self.persisted = []

    def snapshot(self):
        return {"running": self.running, "audio_stream": {"source": "remote" if self.remote else "local"}}

    async def start(self, body, persist=True):
        self.persisted.append(persist)
        self.config = replace(self.config, session_id=body["session_id"])
        self.running = True

    async def stop(self, persist=True):
        self.persisted.append(persist)
        self.running = False


class AllDayCaptureTests(unittest.TestCase):
    def setUp(self):
        self.microphone = Microphone()
        api = FastAPI()
        register_all_day_capture(api, self.microphone, lambda request: None)
        self.client = TestClient(api)
        self.session = "11111111-1111-1111-1111-111111111111"

    def test_defaults_never_open_hardware(self):
        self.assertEqual(capture_sources({}, 0), [])

    def test_screen_uses_desktop_capture_without_loading_qt(self):
        from PIL import Image
        import base64
        import io
        qt_loaded_before = "PySide6" in sys.modules
        with patch("PIL.ImageGrab.grab", return_value=Image.new("RGB", (2560, 1440))) as grab:
            samples = capture_sources({"screen": True}, 0)
        grab.assert_called_once_with(all_screens=True)
        self.assertIn("rabiroute_tray.desktop_capture", sys.modules)
        self.assertEqual("PySide6" in sys.modules, qt_loaded_before)
        decoded = Image.open(io.BytesIO(base64.b64decode(samples[0]["jpeg"])))
        self.assertEqual(decoded.size, (1920, 1080))

    def test_shared_capture_failure_is_an_event_error(self):
        with patch("PIL.ImageGrab.grab", side_effect=RuntimeError("capture unavailable")):
            self.assertEqual(capture_sources({"screen": True}, 0),
                             [{"source": "screen", "error": "capture unavailable"}])

    def test_lease_never_persists_capture_or_stops_another_session(self):
        with self.client as client:
            self.assertEqual(client.post("/v1/all-day/microphone/start", json={"sessionId": self.session}).status_code, 200)
            self.assertTrue(self.microphone.running)
            client.post("/v1/all-day/microphone/stop", json={"sessionId": "other"})
            self.assertTrue(self.microphone.running)
            client.post("/v1/all-day/microphone/stop", json={"sessionId": self.session})
            self.assertFalse(self.microphone.running)
            self.assertEqual(self.microphone.config.session_id, "resident")
            self.assertEqual(self.microphone.persisted, [False, False])

    def test_running_microphone_is_shared_and_survives_stop(self):
        with self.client as client, patch("all_day_capture.bounded_capture", return_value=[]):
            self.microphone.running = True
            result = client.post("/v1/all-day/microphone/start", json={"sessionId": self.session})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["audioSessionId"], "resident")
            self.assertTrue(result.json()["shared"])
            self.assertEqual(client.post("/v1/all-day/capture", json={"sessionId": self.session, "sources": {"microphone": True}}).status_code, 200)
            client.post("/v1/all-day/microphone/stop", json={"sessionId": self.session})
            self.assertTrue(self.microphone.running)
            self.assertEqual(self.microphone.persisted, [])
            self.assertEqual(self.microphone.config.session_id, "resident")

    def test_remote_input_and_changed_shared_session_fail_closed(self):
        with self.client as client:
            self.microphone.remote = True
            self.assertEqual(client.post("/v1/all-day/microphone/start", json={"sessionId": self.session}).status_code, 409)
            self.microphone.remote = False
            self.microphone.running = True
            client.post("/v1/all-day/microphone/start", json={"sessionId": self.session})
            self.microphone.config.session_id = "changed"
            self.assertEqual(client.post("/v1/all-day/capture", json={"sessionId": self.session, "sources": {"microphone": True}}).status_code, 409)
            client.post("/v1/all-day/microphone/stop", json={"sessionId": self.session})
            self.assertTrue(self.microphone.running)
            self.assertEqual(self.microphone.persisted, [])

    def test_tunnel_cannot_turn_on_camera_or_microphone(self):
        with self.client as client:
            headers = {"x-rabilink-tunnel-local": "generation"}
            self.assertEqual(client.post("/v1/all-day/capture", headers=headers, json={"sources": {"camera": True}}).status_code, 403)
            self.assertEqual(client.post("/v1/all-day/microphone/start", headers=headers, json={"sessionId": self.session}).status_code, 403)

    def test_snapshot_options_are_validated_before_worker(self):
        with self.client as client, patch("all_day_capture.bounded_capture", return_value=[]) as worker:
            self.assertEqual(client.post("/v1/all-day/capture", json={"sources": {"screen": "yes"}}).status_code, 422)
            worker.assert_not_called()
            response = client.post("/v1/all-day/capture", json={"sources": {"screen": True}, "cameraIndex": 0})
            self.assertEqual(response.json(), {"samples": []})


if __name__ == "__main__":
    unittest.main()
