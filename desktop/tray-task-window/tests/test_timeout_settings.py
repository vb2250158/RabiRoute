import io
import importlib.util
from pathlib import Path
import json
import os
import unittest
from unittest.mock import patch
from rabiroute_tray.timeout_settings import configure_timeouts, get_timeout_seconds
from rabiroute_tray.manager_client import ManagerClient
from rabiroute_tray.lifecycle_controller import _run_host_command

class TimeoutSettingsTests(unittest.TestCase):
    def tearDown(self):
        configure_timeouts(None)

    def test_verified_identity_publishes_new_request_values(self):
        client = ManagerClient("http://example.test",application_generation_id="generation",manager_instance_id="manager")
        meta = {"applicationGenerationId":"generation","managerInstanceId":"manager","timeoutOverrides":{"desktop.manager.request":250}}
        self.assertEqual(client._identity_error(meta),"")
        calls=[]
        def opened(url,timeout):
            calls.append(timeout)
            return io.BytesIO(b'{}')
        with patch("rabiroute_tray.manager_client.urlopen",opened):
            client._get_json("/test")
        self.assertEqual(calls,[.25])
        self.assertTrue(client._identity_error({**meta,"managerInstanceId":"foreign","timeoutOverrides":{"desktop.manager.request":999}}))
        self.assertEqual(get_timeout_seconds("desktop.manager.request",3),.25)

    def test_host_command_captures_configured_budget_once_and_never_retries(self):
        configure_timeouts({"desktop.host.command":1500})
        import subprocess
        with patch("rabiroute_tray.lifecycle_controller.subprocess.run",side_effect=subprocess.TimeoutExpired("fixture",1.5)) as run:
            self.assertFalse(_run_host_command(["fixture","status"]))
            self.assertEqual(run.call_count,1)
            self.assertEqual(run.call_args.kwargs["timeout"],1.5)

    def test_cold_start_uses_environment_and_clear_restores_defaults(self):
        configure_timeouts(None)
        with patch.dict(os.environ,{"RABIROUTE_TIMEOUT_OVERRIDES":'{"desktop.manager.request":500}'},clear=False):
            self.assertEqual(get_timeout_seconds("desktop.manager.request",3),.5)
            configure_timeouts({})
            self.assertEqual(get_timeout_seconds("desktop.manager.request",3),3)

    def test_bad_snapshot_item_does_not_reject_verified_manager_or_valid_budget(self):
        from rabiroute_tray.timeout_settings import _snapshot
        _snapshot.cache_clear()
        client = ManagerClient("http://example.test", application_generation_id="generation", manager_instance_id="manager")
        meta = {"applicationGenerationId": "generation", "managerInstanceId": "manager", "timeoutOverrides": {
            "desktop.manager.request": 250, "unrelated": 0, "boolean": True, "fraction": 1.5, "not-finite": float("nan")}}
        original = dict(meta["timeoutOverrides"])
        with self.assertLogs("rabiroute_tray.timeout_settings", level="WARNING") as logs:
            self.assertEqual(client._identity_error(meta), "")
            self.assertEqual(client._identity_error(meta), "")
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(get_timeout_seconds("desktop.manager.request", 3), .25)
        for key in ["unrelated", "boolean", "fraction", "not-finite"]:
            self.assertEqual(get_timeout_seconds(key, 3), 3)
        self.assertEqual(meta["timeoutOverrides"], original)
        with patch("rabiroute_tray.manager_client.urlopen", return_value=io.BytesIO(b'{}')) as opened:
            client._get_json("/test")
        self.assertEqual(opened.call_args.kwargs["timeout"], .25)

    def test_bad_environment_is_diagnosed_once_per_snapshot_and_restores_defaults(self):
        from rabiroute_tray.timeout_settings import _snapshot
        configure_timeouts(None)
        for raw in ["{broken", "[]", "null"]:
            _snapshot.cache_clear()
            with patch.dict(os.environ, {"RABIROUTE_TIMEOUT_OVERRIDES": raw}, clear=False):
                with self.assertLogs("rabiroute_tray.timeout_settings", level="WARNING") as logs:
                    self.assertEqual(get_timeout_seconds("desktop.manager.request", 3), 3)
                    self.assertEqual(get_timeout_seconds("desktop.manager.request", 3), 3)
                self.assertEqual(len(logs.records), 1)
                self.assertEqual(os.environ["RABIROUTE_TIMEOUT_OVERRIDES"], raw)
        with self.assertLogs("rabiroute_tray.timeout_settings", level="WARNING"):
            configure_timeouts(["invalid snapshot"])
        self.assertEqual(get_timeout_seconds("desktop.manager.request", 3), 3)

    def test_voice_consumer_isolates_bad_preferences_without_rewriting_environment(self):
        source = Path(__file__).resolve().parents[2] / "rabi-voice-client/rabi_voice_client/timeout_settings.py"
        spec = importlib.util.spec_from_file_location("voice_timeout_fixture", source)
        voice = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(voice)
        raw = '{"voice.request":12000,"bad":0,"boolean":true,"infinite":Infinity}'
        with patch.dict(os.environ, {"RABIROUTE_TIMEOUT_OVERRIDES": raw}, clear=False):
            with self.assertLogs("voice_timeout_fixture", level="WARNING") as logs:
                self.assertEqual(voice.get_timeout_seconds("voice.request", 3), 12)
                for key in ["bad", "boolean", "infinite"]:
                    self.assertEqual(voice.get_timeout_seconds(key, 3), 3)
            self.assertEqual(len(logs.records), 1)
            self.assertEqual(os.environ["RABIROUTE_TIMEOUT_OVERRIDES"], raw)
        with patch.dict(os.environ, {"RABIROUTE_TIMEOUT_OVERRIDES": "{broken"}, clear=False):
            with self.assertLogs("voice_timeout_fixture", level="WARNING"):
                self.assertEqual(voice.get_timeout_seconds("voice.request", 3), 3)
