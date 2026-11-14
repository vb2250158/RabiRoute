from __future__ import annotations

import json
import os
from pathlib import Path
import socket


def run_http_worker(application: str, host: str, port: int, *, port_environment: str) -> int:
    """Both ONNX entrypoints run the same original server over its continuously held socket."""
    import uvicorn

    address_host = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    listener = socket.socket(socket.AF_INET6 if ":" in address_host else socket.AF_INET, socket.SOCK_STREAM)
    try:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        listener.bind((address_host, port))
        listener.listen(128)
        actual_port = listener.getsockname()[1]
        os.environ[port_environment] = str(actual_port)

        class WorkerServer(uvicorn.Server):
            async def startup(self, sockets=None):
                await super().startup(sockets=sockets)
                if not self.started:
                    return
                receipt = {"schemaVersion": 1, "pid": os.getpid(), "host": host, "port": actual_port}
                endpoint_file = os.environ.get("RABISPEECH_WORKER_ENDPOINT_FILE")
                if endpoint_file:
                    endpoint = Path(endpoint_file)
                    temporary = endpoint.with_suffix(".tmp")
                    temporary.write_text(json.dumps(receipt), encoding="utf-8")
                    temporary.replace(endpoint)
                print("RABISPEECH_WORKER_READY " + json.dumps(receipt), flush=True)

        server = WorkerServer(uvicorn.Config(application, host=host, port=actual_port))
        server.run(sockets=[listener])
        return 0 if server.started else 1
    finally:
        listener.close()
