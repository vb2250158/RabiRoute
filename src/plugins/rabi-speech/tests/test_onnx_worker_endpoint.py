from __future__ import annotations

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
import unittest
import urllib.request
from unittest.mock import patch

import uvicorn


WORKER = Path(__file__).resolve().parents[1] / "scripts/local_onnx_vits_worker.py"


class OnnxWorkerEndpointTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.children = []
        self.readers = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait(timeout=10)
            child.stdout.close()
        for reader in self.readers:
            reader.join(2)
            self.assertFalse(reader.is_alive())
        self.directory.cleanup()

    def start_worker(self, *, port=None, fail=False, module=False):
        # Real Uvicorn and sockets, with an ASGI fixture instead of model loading.
        runner = self.root / f"fixture-{len(self.children)}.py"
        runner.write_text("""
import asyncio, importlib.util, json, os, sys, uvicorn
from pathlib import Path
spec=importlib.util.spec_from_file_location('onnx_worker',sys.argv.pop(1))
worker=importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
sys.path.insert(0,str(Path(spec.origin).resolve().parents[1]))
real_config=uvicorn.Config
owned=None
class CaptureServer(uvicorn.Server):
    def run(self, *args, **kwargs):
        global owned
        owned=self
        return super().run(*args,**kwargs)
async def app(scope,receive,send):
    if scope['type']=='lifespan':
        while True:
            message=await receive()
            if message['type']=='lifespan.startup':
                await send({'type':'lifespan.startup.failed','message':'fixture startup failure'} if os.environ.get('FIXTURE_FAIL')=='1' else {'type':'lifespan.startup.complete'})
            elif message['type']=='lifespan.shutdown':
                await send({'type':'lifespan.shutdown.complete'}); return
    else:
        await send({'type':'http.response.start','status':200})
        await send({'type':'http.response.body','body':json.dumps({'port':int(os.environ['RABISPEECH_ONNX_VITS_PORT'])}).encode()})
        if scope['path']=='/stop': owned.should_exit=True
uvicorn.Server=CaptureServer
uvicorn.Config=lambda _target,**kwargs: real_config(app,**kwargs,log_level='error')
if os.environ.get('FIXTURE_MODULE')=='1':
    import runpy
    runpy.run_module('rabispeech.onnx_vits',run_name='__main__')
    raise SystemExit(0)
raise SystemExit(worker.main())
""", encoding="utf-8")
        receipt = self.root / f"endpoint-{len(self.children)}.json"
        environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "RABISPEECH_WORKER_ENDPOINT_FILE": str(receipt),
                       "PYTHONIOENCODING": "utf-8", "PYTHONPATH": str(Path(uvicorn.__file__).resolve().parent.parent)}
        if fail:
            environment["FIXTURE_FAIL"] = "1"
        environment.pop("RABISPEECH_ONNX_VITS_PORT", None)
        if module:
            environment["FIXTURE_MODULE"] = "1"
            if port is not None:
                environment["RABISPEECH_ONNX_VITS_PORT"] = str(port)
        loader = "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_path(sys.argv.pop(1),run_name='__main__')"
        arguments = [sys.executable, "-c", loader, str(Path(uvicorn.__file__).resolve().parent.parent), str(runner), str(WORKER),
                     "--model-dir", str(self.root), "--config", str(self.root / "model.json"), "--output-dir", str(self.root)]
        if port is not None:
            arguments += ["--port", str(port)]
        child = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", env=environment, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.children.append(child)
        output = queue.Queue()

        def read():
            for line in child.stdout:
                output.put(line)
            output.put(None)

        reader = threading.Thread(target=read)
        reader.start(); self.readers.append(reader)
        return child, output, receipt

    def ready(self, output):
        lines = []
        for _ in range(100):
            line = output.get(timeout=10)
            if line is None:
                self.fail("Worker exited before publishing READY: " + "".join(lines))
            lines.append(line)
            if line.startswith("RABISPEECH_WORKER_READY "):
                return json.loads(line.split(" ", 1)[1])
        self.fail("No worker READY receipt")

    @staticmethod
    def request(port, path="/health"):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}{path}", timeout=2) as response:
            return json.load(response)

    def test_default_zero_keeps_concurrent_sockets_and_reports_actual_port_everywhere(self):
        children = []
        for _ in range(2):
            child, output, endpoint = self.start_worker()
            ready = self.ready(output)
            self.assertEqual(ready["pid"], child.pid)
            self.assertGreater(ready["port"], 0)
            self.assertEqual(json.loads(endpoint.read_text())["port"], ready["port"])
            self.assertEqual(self.request(ready["port"])["port"], ready["port"])
            children.append((child, ready["port"]))
        self.assertNotEqual(children[0][1], children[1][1])
        for child, port in children:
            self.request(port, "/stop")
            self.assertEqual(child.wait(timeout=10), 0)
            with socket.socket() as replacement:
                replacement.bind(("127.0.0.1", port))

    def test_explicit_conflict_never_stops_the_existing_listener(self):
        with socket.socket() as blocker:
            blocker.bind(("127.0.0.1", 0)); blocker.listen()
            port = blocker.getsockname()[1]
            child, output, endpoint = self.start_worker(port=port)
            self.assertNotEqual(child.wait(timeout=10), 0)
            self.assertFalse(endpoint.exists())
            self.assertEqual(blocker.getsockname()[1], port)
            lines = []
            while True:
                line = output.get(timeout=2)
                if line is None:
                    break
                lines.append(line)
                self.assertFalse(line.startswith("RABISPEECH_WORKER_READY "))
            self.assertRegex("".join(lines), "10048|EADDRINUSE|Address already in use")

    def test_module_entrypoint_uses_the_same_dynamic_socket_and_ready_contract(self):
        child, output, endpoint = self.start_worker(module=True)
        ready = self.ready(output)
        self.assertEqual(ready["pid"], child.pid)
        self.assertEqual(self.request(ready["port"])["port"], ready["port"])
        self.assertEqual(json.loads(endpoint.read_text())["port"], ready["port"])
        self.request(ready["port"], "/stop")
        self.assertEqual(child.wait(timeout=10), 0)

    def test_startup_failure_publishes_no_endpoint_or_ready(self):
        child, output, endpoint = self.start_worker(fail=True)
        self.assertNotEqual(child.wait(timeout=10), 0)
        self.assertFalse(endpoint.exists())
        lines = []
        while True:
            line = output.get(timeout=2)
            if line is None:
                break
            lines.append(line)
            self.assertFalse(line.startswith("RABISPEECH_WORKER_READY "))
        self.assertIn("fixture startup failure", "".join(lines))

    def test_parser_preserves_an_explicit_port_and_defaults_to_zero(self):
        spec = importlib.util.spec_from_file_location("onnx_worker_parser", WORKER)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        base = [str(WORKER), "--model-dir", ".", "--config", "config.json", "--output-dir", "."]
        with patch.object(sys, "argv", base):
            self.assertEqual(module.parse_args().port, 0)
        with patch.object(sys, "argv", [*base, "--port", "23456"]):
            self.assertEqual(module.parse_args().port, 23456)


if __name__ == "__main__":
    unittest.main()
