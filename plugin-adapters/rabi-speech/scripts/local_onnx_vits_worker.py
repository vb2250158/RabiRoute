from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="RabiSpeech loopback worker for split-graph ONNX-VITS.")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8764)
    parser.add_argument("--default-speaker", default="")
    parser.add_argument("--default-speaker-id", type=int)
    parser.add_argument("--providers", default="")
    parser.add_argument("--open-jtalk-dict-dir", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    service_root = Path(__file__).resolve().parents[1]
    deps = service_root / ".deps"
    for path in (service_root, deps):
        if path.is_dir() and str(path) not in sys.path:
            sys.path.insert(0, str(path))

    os.environ["RABISPEECH_ONNX_VITS_MODEL_DIR"] = str(Path(args.model_dir).expanduser().resolve())
    os.environ["RABISPEECH_ONNX_VITS_CONFIG"] = str(Path(args.config).expanduser().resolve())
    os.environ["RABISPEECH_ONNX_VITS_OUTPUT"] = str(Path(args.output_dir).expanduser().resolve())
    os.environ["RABISPEECH_ONNX_VITS_PORT"] = str(args.port)
    if args.default_speaker:
        os.environ["RABISPEECH_ONNX_VITS_DEFAULT_SPEAKER"] = args.default_speaker
    if args.default_speaker_id is not None:
        os.environ["RABISPEECH_ONNX_VITS_DEFAULT_SPEAKER_ID"] = str(args.default_speaker_id)
    if args.providers:
        os.environ["RABISPEECH_ONNX_VITS_PROVIDERS"] = args.providers
    if args.open_jtalk_dict_dir:
        os.environ["OPEN_JTALK_DICT_DIR"] = str(Path(args.open_jtalk_dict_dir).expanduser().resolve())

    import uvicorn

    uvicorn.run(
        "rabispeech.onnx_vits.server:app",
        host=args.host,
        port=args.port,
        reload=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
