from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe one sherpa-onnx speaker embedding model in an isolated process.")
    parser.add_argument("--model", required=True)
    parser.add_argument("--provider", default="cpu")
    parser.add_argument("--num-threads", type=int, default=2)
    args = parser.parse_args()

    model = Path(args.model).expanduser().resolve()
    if not model.is_file():
        raise SystemExit(f"Speaker model does not exist: {model}")

    import sherpa_onnx

    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(model),
        num_threads=max(1, args.num_threads),
        debug=False,
        provider=args.provider,
    )
    if not config.validate():
        raise SystemExit("Invalid sherpa-onnx speaker embedding configuration.")
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
    print(json.dumps({"ok": True, "dimension": int(extractor.dim)}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
