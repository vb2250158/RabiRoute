from __future__ import annotations

import os
import asyncio
import socket
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from rabispeech.config import _worker_launch
from rabispeech.worker_supervisor import WorkerSupervisor


class WorkerPathsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.active = self.root / "active" / "rabi-speech"
        self.legacy = self.state / "plugin-adapters" / "rabi-speech"
        self.scripts = ("local_onnx_vits_worker.py", "local_tts_worker.py", "local_asr_worker.py")
        for name in self.scripts:
            path = self.active / "scripts" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# current builtin", encoding="utf-8")
        self.environment = patch.dict(os.environ, {"RABIROUTE_STATE_ROOT": str(self.state)})
        self.environment.start(); self.addCleanup(self.environment.stop)
        self.service_root = patch("rabispeech.config.SERVICE_ROOT", self.active)
        self.service_root.start(); self.addCleanup(self.service_root.stop)

    def row(self, name):
        return {"command": ["python.exe", "-u", str(self.legacy / "scripts" / name),
                            "--model-dir", "E:/Model/tts/existing", "--output-dir", "private/output"],
                "working_directory": str(self.legacy), "startup_timeout_seconds": 60,
                "environment": {"MODEL_PRIVATE_SETTING": "kept"}, "exclusive_group": "gpu"}

    def test_owned_builtin_entries_follow_the_current_program_without_rewriting_configuration(self):
        for name in self.scripts:
            with self.subTest(name=name):
                row = self.row(name)
                original = list(row["command"])
                launch = _worker_launch(self.root, row)
                self.assertEqual(launch.command, (*original[:2], str(self.active / "scripts" / name), *original[3:]))
                self.assertEqual(row["command"], original)
                self.assertEqual(launch.working_directory, self.legacy)
                self.assertEqual(launch.environment, (("MODEL_PRIVATE_SETTING", "kept"),))
                self.assertEqual(launch.startup_timeout_seconds, 60)
                self.assertEqual(launch.exclusive_group, "gpu")

    def test_unowned_commands_and_custom_same_name_scripts_are_unchanged(self):
        row = self.row(self.scripts[0])
        for command in (["python.exe", str(self.root / "custom" / self.scripts[0])],
                        ["other.exe", row["command"][2]],
                        ["python.exe", "-c", row["command"][2]],
                        ["python.exe", "-m", row["command"][2]],
                        ["python.exe", "scripts/" + self.scripts[0]]):
            with self.subTest(command=command):
                self.assertEqual(_worker_launch(self.root, {**row, "command": command}).command, tuple(command))

    def test_absent_host_identity_does_not_relocate_any_user_command(self):
        row = self.row(self.scripts[0])
        with patch.dict(os.environ, {"RABIROUTE_STATE_ROOT": ""}):
            self.assertEqual(_worker_launch(self.root, row).command, tuple(row["command"]))

    def test_owned_entry_missing_from_current_package_fails_instead_of_running_legacy(self):
        row = self.row(self.scripts[0])
        (self.active / "scripts" / self.scripts[0]).unlink()
        with self.assertRaisesRegex(RuntimeError, "built-in worker entry"):
            _worker_launch(self.root, row)

    def test_relocated_builtin_uses_the_actual_endpoint_without_running_the_stale_script(self):
        name = self.scripts[0]
        old = self.legacy / "scripts" / name
        old.parent.mkdir(parents=True)
        old.write_text("raise RuntimeError('stale entry executed')", encoding="utf-8")
        (self.active / "scripts" / name).write_text('''
import argparse, json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('--host'); parser.add_argument('--port', type=int)
args = parser.parse_args()
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
    def log_message(self, *args): pass
server = ThreadingHTTPServer((args.host, args.port), Handler)
path = Path(os.environ['RABISPEECH_WORKER_ENDPOINT_FILE'])
temporary = path.with_suffix('.tmp')
temporary.write_text(json.dumps({'port':server.server_port}), encoding='utf-8')
temporary.replace(path)
server.serve_forever()
''', encoding="utf-8")
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0)); occupied.listen()
            port = occupied.getsockname()[1]
            row = self.row(name)
            row["command"] = [sys.executable, str(old), "--host", "127.0.0.1", "--port", str(port)]
            row["startup_timeout_seconds"] = 10
            launch = _worker_launch(self.root, row)
            supervisor = WorkerSupervisor()

            async def exercise():
                try:
                    endpoint = await supervisor.ensure("tts:migration", f"http://127.0.0.1:{port}", launch)
                    self.assertNotEqual(endpoint, f"http://127.0.0.1:{port}")
                    self.assertTrue(await supervisor._healthy(endpoint))
                finally:
                    await supervisor.close()

            asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
