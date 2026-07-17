from __future__ import annotations

import argparse
import base64
import json
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


LANGUAGE_NAMES = {
    "zh": "Chinese",
    "en": "English",
    "yue": "Cantonese",
    "ja": "Japanese",
    "ko": "Korean",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "pt": "Portuguese",
    "it": "Italian",
    "ru": "Russian",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Loopback worker for an isolated local ASR environment.")
    parser.add_argument("--engine", required=True, choices=["qwen3-asr", "sensevoice", "fireredasr2-aed"])
    parser.add_argument("--model", required=True, help="Local model directory.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--device", default="cuda")
    parser.add_argument(
        "--repository-root",
        default="",
        help="Optional source repository root for engines that are executed from a checkout.",
    )
    parser.add_argument("--max-request-bytes", type=int, default=36 * 1024 * 1024)
    return parser.parse_args()


class ModelRuntime:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.model_path = Path(args.model).expanduser().resolve()
        if not self.model_path.is_dir():
            raise FileNotFoundError(f"Local model directory does not exist: {self.model_path}")
        self.lock = threading.Lock()
        self.loaded_at = ""
        started = time.perf_counter()
        self.model = self._load()
        self.load_seconds = round(time.perf_counter() - started, 3)

    def _load(self) -> Any:
        repository_root = str(self.args.repository_root or "").strip()
        if repository_root:
            resolved_root = Path(repository_root).expanduser().resolve()
            if not resolved_root.is_dir():
                raise FileNotFoundError(f"Engine repository root does not exist: {resolved_root}")
            root_text = str(resolved_root)
            if root_text not in sys.path:
                sys.path.insert(0, root_text)
        if self.args.engine == "qwen3-asr":
            import torch
            from qwen_asr import Qwen3ASRModel

            device_map = "cuda:0" if self.args.device.startswith("cuda") else "cpu"
            dtype = torch.bfloat16 if device_map.startswith("cuda") else torch.float32
            return Qwen3ASRModel.from_pretrained(
                str(self.model_path),
                dtype=dtype,
                device_map=device_map,
                max_inference_batch_size=1,
                max_new_tokens=1024,
            )
        if self.args.engine == "sensevoice":
            from funasr import AutoModel

            device = "cuda:0" if self.args.device.startswith("cuda") else "cpu"
            return AutoModel(model=str(self.model_path), trust_remote_code=True, device=device)
        from fireredasr2s.fireredasr2 import FireRedAsr2, FireRedAsr2Config

        config = FireRedAsr2Config(
            use_gpu=self.args.device.startswith("cuda"),
            use_half=False,
            beam_size=3,
            nbest=1,
            return_timestamp=True,
        )
        return FireRedAsr2.from_pretrained("aed", str(self.model_path), config)

    def transcribe(self, audio_path: Path, language: str | None, word_timestamps: bool) -> dict[str, object]:
        with self.lock:
            started = time.perf_counter()
            if self.args.engine == "qwen3-asr":
                result = self.model.transcribe(
                    audio=str(audio_path),
                    language=LANGUAGE_NAMES.get(str(language or "").lower(), language) or None,
                )[0]
                output = {
                    "text": str(result.text or "").strip(),
                    "language": str(result.language or language or ""),
                    "segments": [],
                }
            elif self.args.engine == "sensevoice":
                from funasr.utils.postprocess_utils import rich_transcription_postprocess

                result = self.model.generate(
                    input=str(audio_path),
                    cache={},
                    language=str(language or "auto").lower(),
                    use_itn=True,
                    batch_size=1,
                )[0]
                output = {
                    "text": rich_transcription_postprocess(str(result.get("text") or "")).strip(),
                    "language": str(result.get("language") or language or ""),
                    "segments": [],
                }
            else:
                _normalize_wav(audio_path, sample_rate=16000)
                raw = self.model.transcribe([audio_path.stem], [str(audio_path)])[0]
                confidence = float(raw.get("confidence") or 0.0)
                words = [
                    {
                        "word": str(item[0]),
                        "start": float(item[1]),
                        "end": float(item[2]),
                        "probability": confidence,
                    }
                    for item in raw.get("timestamp") or []
                    if isinstance(item, (list, tuple)) and len(item) >= 3
                ]
                output = {
                    "text": str(raw.get("text") or "").strip(),
                    "language": str(language or ""),
                    "segments": [
                        {
                            "id": 0,
                            "start": 0.0,
                            "end": float(raw.get("dur_s") or _duration(audio_path)),
                            "text": str(raw.get("text") or "").strip(),
                            "words": words if word_timestamps else [],
                        }
                    ],
                }
            output["duration"] = _duration(audio_path)
            output["inference_seconds"] = round(time.perf_counter() - started, 3)
            return output

    def health(self) -> dict[str, object]:
        return {
            "ok": True,
            "engine": self.args.engine,
            "model": self.model_path.name,
            "device": self.args.device,
            "loaded": True,
            "load_seconds": self.load_seconds,
        }


def make_handler(runtime: ModelRuntime):
    class Handler(BaseHTTPRequestHandler):
        server_version = "RabiSpeechModelWorker/1"

        def do_GET(self) -> None:  # noqa: N802
            if urlparse(self.path).path in {"/health", "/status"}:
                self._json(200, runtime.health())
                return
            self._json(404, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            if urlparse(self.path).path != "/transcribe":
                self._json(404, {"error": "not_found"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > runtime.args.max_request_bytes * 2:
                    raise ValueError("Request body is empty or too large.")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                audio = base64.b64decode(str(payload.get("audio_base64") or ""), validate=True)
                if not audio or len(audio) > runtime.args.max_request_bytes:
                    raise ValueError("Decoded audio is empty or too large.")
                suffix = _safe_suffix(str(payload.get("filename") or "audio.wav"))
                handle = tempfile.NamedTemporaryFile(prefix="rabispeech-worker-", suffix=suffix, delete=False)
                path = Path(handle.name)
                try:
                    handle.write(audio)
                    handle.close()
                    result = runtime.transcribe(
                        path,
                        str(payload.get("language") or "") or None,
                        bool(payload.get("word_timestamps")),
                    )
                    self._json(200, result)
                finally:
                    handle.close()
                    path.unlink(missing_ok=True)
            except Exception as exc:
                self._json(500, {"error": type(exc).__name__, "message": str(exc)})

        def log_message(self, format: str, *args: object) -> None:
            print(f"{self.address_string()} - {format % args}", flush=True)

        def _json(self, status: int, value: object) -> None:
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def _safe_suffix(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    return suffix if suffix in {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".opus", ".webm", ".mp4"} else ".audio"


def _duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as source:
            return source.getnframes() / max(1, source.getframerate())
    except (wave.Error, OSError):
        return 0.0


def _normalize_wav(path: Path, sample_rate: int) -> None:
    import numpy as np
    import soundfile as sf

    audio, source_rate = sf.read(str(path), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if source_rate != sample_rate and len(mono):
        target_size = max(1, round(len(mono) * sample_rate / source_rate))
        source_x = np.linspace(0.0, 1.0, num=len(mono), endpoint=False)
        target_x = np.linspace(0.0, 1.0, num=target_size, endpoint=False)
        mono = np.interp(target_x, source_x, mono).astype("float32")
    sf.write(str(path), mono, sample_rate, subtype="PCM_16", format="WAV")


def main() -> int:
    args = parse_args()
    runtime = ModelRuntime(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(runtime))
    print(json.dumps({"url": f"http://{args.host}:{args.port}", **runtime.health()}, ensure_ascii=False), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
