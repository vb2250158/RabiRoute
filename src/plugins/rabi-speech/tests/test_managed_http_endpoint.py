from __future__ import annotations

import ctypes
import importlib.util
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import types
import time
import unittest
from unittest import mock
import urllib.request
import uuid


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "windows_host.py"


@unittest.skipUnless(importlib.util.find_spec("uvicorn"), "Uvicorn runtime dependency is required")
class ManagedHttpEndpointTests(unittest.TestCase):
    def test_new_config_is_dynamic_and_explicit_ports_are_preserved(self):
        config_file = SCRIPT.parents[1] / "rabispeech" / "config.py"
        package_name = "speech_config_port_fixture"
        package = types.ModuleType(package_name)
        package.__path__ = [str(config_file.parent)]
        sys.modules[package_name] = package
        self.addCleanup(lambda: [sys.modules.pop(name, None) for name in list(sys.modules) if name == package_name or name.startswith(package_name + ".")])
        spec = importlib.util.spec_from_file_location(package_name + ".config", config_file)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        self.addCleanup(lambda: sys.modules.pop(spec.name, None))
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ):
            os.environ.pop("RABISPEECH_PORT", None)
            config = Path(temporary) / "config.json"
            config.write_text('{"server": {}}', encoding="utf-8")
            self.assertEqual(module.load_settings(config).server.port, 0)
            config.write_text('{"server": {"port": 31415}}', encoding="utf-8")
            self.assertEqual(module.load_settings(config).server.port, 31415)

    def host_module(self):
        spec = importlib.util.spec_from_file_location("speech_managed_host_fixture", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_rejected_browser_ports_are_closed_and_success_keeps_its_socket(self):
        module = self.host_module()
        allocated = []
        class Listener:
            def __init__(self, port): self.port, self.closed = port, False
            def setsockopt(self, *_): pass
            def bind(self, address): self_address.assertEqual(address, ("127.0.0.1", 0))
            def set_inheritable(self, inherited): self_address.assertTrue(inherited)
            def getsockname(self): return ("127.0.0.1", self.port)
            def close(self): self.closed = True
        self_address = self
        def allocate(*_):
            listener = Listener(6000 if not allocated else 31415)
            allocated.append(listener)
            return listener
        with mock.patch.object(module.socket, "socket", side_effect=allocate):
            selected = module._bind_automatic_socket("127.0.0.1")
        self.assertTrue(allocated[0].closed)
        self.assertIs(selected, allocated[1])
        self.assertFalse(selected.closed)
        selected.close()

    def test_browser_port_exhaustion_closes_every_rejected_socket(self):
        module = self.host_module()
        allocated = []
        def allocate(*_):
            listener = mock.Mock()
            listener.getsockname.return_value = ("127.0.0.1", 6000)
            allocated.append(listener)
            return listener
        with mock.patch.object(module.socket, "socket", side_effect=allocate):
            with self.assertRaisesRegex(RuntimeError, "browser-compatible"):
                module._bind_automatic_socket("127.0.0.1")
        self.assertEqual(len(allocated), 128)
        for listener in allocated:
            listener.close.assert_called_once()

    def launch(self, *, reload=False, fail=False, hang_shutdown=False):
        import uvicorn
        temporary = tempfile.TemporaryDirectory(prefix="speech-http-fixture-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        package = root / "rabispeech"
        package.mkdir()
        (package / "__init__.py").write_text("", encoding="utf-8")
        (root / "config.json").write_text('{"server": {"port": 0}}', encoding="utf-8")
        (root / "fixture_state.py").write_text("server = None\n", encoding="utf-8")
        (package / "config.py").write_text('''
from types import SimpleNamespace
import uvicorn, fixture_state
original = uvicorn.Server.__init__
def initialize(self, *args, **kwargs):
    original(self, *args, **kwargs)
    fixture_state.server = self
uvicorn.Server.__init__ = initialize
def load_settings():
    return SimpleNamespace(server=SimpleNamespace(host="127.0.0.1", port=0))
''', encoding="utf-8")
        application = '''
import json, fixture_state
def create_app():
    async def app(scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                event = await receive()
                if event["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.failed", "message": "fixture startup refused"})
                    return
                if event["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        else:
            body = json.dumps({"ok": True, "service": "RabiSpeech"}).encode()
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": body})
            if scope["path"] == "/shutdown":
                fixture_state.server.should_exit = True
    return app
'''
        if not fail:
            application = application.replace('await send({"type": "lifespan.startup.failed", "message": "fixture startup refused"})\n                    return', 'await send({"type": "lifespan.startup.complete"})')
        if hang_shutdown:
            application = application.replace('await send({"type": "lifespan.shutdown.complete"})', 'import asyncio\n                    await asyncio.Event().wait()')
        app_file = package / "app.py"
        app_file.write_text(application, encoding="utf-8")
        nonce = str(uuid.uuid4())
        dependencies = str(Path(uvicorn.__file__).resolve().parent.parent)
        environment = {**os.environ, "RABISPEECH_ROOT": str(root), "RABISPEECH_CONFIG": str(root / "config.json"),
                       "RABISPEECH_DEPS_ROOT": dependencies, "RABISPEECH_ENDPOINT_NONCE": nonce,
                       "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1"}
        bootstrap = "import json,runpy,sys; sys.path[:0]=json.loads(sys.argv.pop(1)); runpy.run_path(sys.argv.pop(1),run_name='__main__')"
        command = [sys.executable, "-c", bootstrap, json.dumps([dependencies]), str(SCRIPT)]
        if reload:
            command.append("--reload")
        process = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        stdout, errors, records = [], [], queue.Queue()
        def consume(stream, output):
            for line in stream:
                output.append(line)
                if line.startswith("RABISPEECH_READY:"):
                    records.put(json.loads(line.split(":", 1)[1]))
        readers = [threading.Thread(target=consume, args=(process.stdout, stdout), daemon=True), threading.Thread(target=consume, args=(process.stderr, errors), daemon=True)]
        for thread in readers:
            thread.start()
        def cleanup():
            if process.poll() is None:
                if os.name == "nt":
                    subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=10)
                else:
                    process.kill()
                process.wait(timeout=10)
            for thread in readers:
                thread.join(timeout=10)
                self.assertFalse(thread.is_alive(), "output readers join actual child pipe closure")
            process.stdout.close(); process.stderr.close()
        self.addCleanup(cleanup)
        return process, records, errors, stdout, nonce, app_file

    def ready(self, records, errors):
        try:
            return records.get(timeout=15)
        except queue.Empty:
            self.fail("No post-startup READY record: " + "".join(errors))

    def test_real_socket_allocation_readiness_and_graceful_exit(self):
        occupied = socket.socket()
        try:
            occupied.bind(("127.0.0.1", 8781)); occupied.listen()
        except OSError as error:
            if error.errno not in (48, 98, 10048) and getattr(error, "winerror", None) != 10048:
                raise
        self.addCleanup(occupied.close)
        process, records, errors, _, nonce, _ = self.launch()
        record = self.ready(records, errors)
        self.assertEqual(record["pid"], process.pid)
        self.assertEqual(record["nonce"], nonce)
        self.assertNotEqual(record["port"], 8781)
        base = f'http://127.0.0.1:{record["port"]}'
        with urllib.request.urlopen(base + "/health", timeout=5) as response:
            self.assertTrue(json.load(response)["ok"])
        with urllib.request.urlopen(base + "/shutdown", timeout=5) as response:
            response.read()
        self.assertEqual(process.wait(timeout=10), 0)
        with socket.socket() as probe:
            probe.settimeout(1)
            self.assertNotEqual(probe.connect_ex(("127.0.0.1", record["port"])), 0)

    def test_failed_lifespan_never_publishes_readiness(self):
        process, records, errors, _, _, _ = self.launch(fail=True)
        self.assertNotEqual(process.wait(timeout=15), 0)
        self.assertTrue(records.empty())
        self.assertIn("fixture startup refused", "".join(errors))

    @unittest.skipUnless(os.name == "nt", "Windows reload uses spawn and Job-compatible process inheritance")
    def test_reload_keeps_the_bound_socket_and_child_exit_is_verified(self):
        process, records, errors, _, nonce, app_file = self.launch(reload=True)
        first = self.ready(records, errors)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handles = []
        def retain(pid):
            handle = kernel.OpenProcess(0x00100000, False, pid)
            self.assertTrue(handle, "retain the actual worker process identity")
            handles.append(handle)
        try:
            retain(first["pid"])
            # StatReload must have sampled the file before changing its mtime.
            time.sleep(1)
            app_file.write_text(app_file.read_text(encoding="utf-8") + "\n# reload fixture\n", encoding="utf-8")
            os.utime(app_file, (time.time() + 2, time.time() + 2))
            second = self.ready(records, errors)
            retain(second["pid"])
            self.assertNotEqual(first["pid"], second["pid"])
            self.assertEqual(first["port"], second["port"])
            self.assertEqual(second["nonce"], nonce)
            self.assertEqual(kernel.WaitForSingleObject(handles[0], 10000), 0)
            result = subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0)
            process.wait(timeout=10)
            for handle in handles:
                self.assertEqual(kernel.WaitForSingleObject(handle, 10000), 0, "actual original and reloaded workers must exit")
            with socket.socket() as probe:
                probe.settimeout(1)
                self.assertNotEqual(probe.connect_ex(("127.0.0.1", second["port"])), 0)
        finally:
            for handle in handles:
                kernel.CloseHandle(handle)

    @unittest.skipUnless(os.name == "nt", "Windows retirement uses a retained native worker handle")
    def test_reload_timeout_retains_original_worker_without_replacement(self):
        process, records, errors, _, _, app_file = self.launch(reload=True, hang_shutdown=True)
        first = self.ready(records, errors)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x00100000, False, first["pid"])
        self.assertTrue(handle)
        try:
            time.sleep(1)
            app_file.write_text(app_file.read_text(encoding="utf-8") + "\n# pending retirement fixture\n", encoding="utf-8")
            os.utime(app_file, (time.time() + 2, time.time() + 2))
            deadline = time.monotonic() + 15
            while not any("retirement remains unconfirmed" in line for line in errors) and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(any("retirement remains unconfirmed" in line for line in errors), "explicitly report the pending original worker")
            self.assertIsNone(process.poll(), "original supervisor stays alive with its process ownership")
            self.assertTrue(records.empty(), "no replacement worker may acquire the listener")
            self.assertEqual(kernel.WaitForSingleObject(handle, 0), 258)
        finally:
            if process.poll() is None:
                subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=10)
                process.wait(timeout=10)
            self.assertEqual(kernel.WaitForSingleObject(handle, 10000), 0)
            kernel.CloseHandle(handle)


if __name__ == "__main__":
    unittest.main()
