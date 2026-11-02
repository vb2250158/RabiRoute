from __future__ import annotations

import asyncio
import socket
import sys
from pathlib import Path

from rabispeech.worker_supervisor import WorkerLaunch, WorkerSupervisor


def test_managed_worker_uses_its_actual_endpoint_when_old_port_is_occupied(tmp_path: Path):
    script = tmp_path / "local_tts_worker.py"
    script.write_text("""
import argparse, json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('--host')
parser.add_argument('--port', type=int)
args = parser.parse_args()
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
    def log_message(self, *args): pass
server = ThreadingHTTPServer((args.host, args.port), Handler)
path = Path(os.environ['RABISPEECH_WORKER_ENDPOINT_FILE'])
tmp = path.with_suffix('.tmp')
tmp.write_text(json.dumps({'port': server.server_port}), encoding='utf-8')
tmp.replace(path)
server.serve_forever()
""", encoding="utf-8")
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen()
    occupied = blocker.getsockname()[1]
    supervisor = WorkerSupervisor()
    launch = WorkerLaunch(command=(sys.executable, str(script), "--host", "127.0.0.1", "--port", str(occupied)), working_directory=tmp_path, startup_timeout_seconds=10)

    async def exercise():
        url = await supervisor.ensure("tts:test", f"http://127.0.0.1:{occupied}", launch)
        assert url != f"http://127.0.0.1:{occupied}"
        assert await supervisor.ensure("tts:test", f"http://127.0.0.1:{occupied}", launch) == url
        assert supervisor._processes["tts:test"].process.poll() is None

    try:
        asyncio.run(exercise())
    finally:
        if managed := supervisor._processes.get("tts:test"):
            supervisor._terminate(managed)
        blocker.close()


def test_managed_command_preserves_external_worker_configuration():
    assert WorkerSupervisor._dynamic_command(("python", "other_worker.py", "--port", "9999")) == ()
    command = WorkerSupervisor._dynamic_command(("python", "local_asr_worker.py", "--port=1234", "--host=localhost"))
    assert "--port=0" in command
    assert "--host=127.0.0.1" in command
