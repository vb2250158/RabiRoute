from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DEPENDENCY_ROOT = PLUGIN_ROOT / ".deps"


def bootstrap_runtime() -> None:
    """Load the same private dependency roots regardless of the caller's cwd."""
    for path in (DEPENDENCY_ROOT, PLUGIN_ROOT):
        value = str(path)
        if path.is_dir() and value not in sys.path:
            sys.path.insert(0, value)
    nvidia_root = DEPENDENCY_ROOT / "nvidia"
    if nvidia_root.is_dir():
        bins = [str(candidate) for candidate in sorted(nvidia_root.glob("*/bin")) if candidate.is_dir()]
        if bins:
            os.environ["PATH"] = os.pathsep.join([*bins, os.environ.get("PATH", "")])


bootstrap_runtime()

import numpy as np


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe one ONNX Runtime speaker embedding model in an isolated process.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--model", help="Speaker ONNX model path.")
    source.add_argument("--config", help="RabiSpeech config.json; resolves its speaker model exactly like the service.")
    parser.add_argument("--provider")
    parser.add_argument("--num-threads", type=int)
    args = parser.parse_args()

    model_id = ""
    if args.config:
        from rabispeech.config import load_settings

        settings = load_settings(Path(args.config))
        model = settings.speaker_recognition.model_path
        model_id = settings.speaker_recognition.model_id
        provider = str(args.provider or settings.speaker_recognition.provider)
        num_threads = int(args.num_threads or settings.speaker_recognition.num_threads)
    else:
        model = Path(str(args.model)).expanduser().resolve()
        provider = str(args.provider or "cpu")
        num_threads = int(args.num_threads or 2)
    if not model.is_file():
        raise SystemExit(f"Speaker model does not exist: {model}")

    from types import SimpleNamespace
    from rabispeech.speaker_recognition import OnnxRuntimeSpeakerEmbeddingExtractor

    extractor = OnnxRuntimeSpeakerEmbeddingExtractor(SimpleNamespace(
        model_path=model,
        num_threads=max(1, num_threads),
        provider=provider,
    ))
    sample_rate = 16_000
    time = np.arange(sample_rate * 2, dtype=np.float32) / sample_rate
    waveform = (0.1 * np.sin(2 * np.pi * 220 * time)).astype(np.float32)
    embedding = extractor.compute(waveform, sample_rate)
    print(json.dumps({
        "ok": True,
        "dimension": int(embedding.size),
        "backend": "onnxruntime",
        "model_id": model_id or None,
        "provider": provider,
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
