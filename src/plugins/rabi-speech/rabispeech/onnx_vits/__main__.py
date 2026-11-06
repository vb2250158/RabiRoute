from __future__ import annotations

import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "rabispeech.onnx_vits.server:app",
        host="127.0.0.1",
        port=int(os.environ.get("RABISPEECH_ONNX_VITS_PORT", "8764")),
        reload=False,
    )
