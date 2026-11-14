from __future__ import annotations

import os

from ..worker_http import run_http_worker


if __name__ == "__main__":
    raise SystemExit(run_http_worker(
        "rabispeech.onnx_vits.server:app",
        host="127.0.0.1",
        port=int(os.environ.get("RABISPEECH_ONNX_VITS_PORT", "0")),
        port_environment="RABISPEECH_ONNX_VITS_PORT",
    ))
