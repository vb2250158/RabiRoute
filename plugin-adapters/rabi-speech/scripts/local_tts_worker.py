from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


LANGUAGE_CODES = {
    "chinese": "zh",
    "zh": "zh",
    "english": "en",
    "en": "en",
    "japanese": "ja",
    "ja": "ja",
    "cantonese": "yue",
    "yue": "yue",
    "korean": "ko",
    "ko": "ko",
}

QWEN_LANGUAGE_NAMES = {
    "zh": "Chinese",
    "chinese": "Chinese",
    "en": "English",
    "english": "English",
    "ja": "Japanese",
    "japanese": "Japanese",
    "ko": "Korean",
    "korean": "Korean",
    "de": "German",
    "fr": "French",
    "ru": "Russian",
    "pt": "Portuguese",
    "es": "Spanish",
    "it": "Italian",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rabi persona-aware worker for local TTS model runtimes.")
    parser.add_argument("--engine", required=True, choices=["cosyvoice3", "gpt-sovits", "qwen3-tts", "indextts2"])
    parser.add_argument("--repository-root", required=True)
    parser.add_argument("--model", help="Local model directory (required for CosyVoice).")
    parser.add_argument("--config", help="Local inference config (required for GPT-SoVITS).")
    parser.add_argument("--roles-root", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--prompt-audio", required=True)
    parser.add_argument("--prompt-text", default="")
    parser.add_argument("--prompt-language", default="zh")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--no-fp16", action="store_true")
    parser.add_argument("--max-new-tokens", type=int, default=256)
    parser.add_argument("--emotion-alpha", type=float, default=0.55)
    parser.add_argument("--min-prompt-duration", type=float)
    parser.add_argument("--target-prompt-duration", type=float)
    parser.add_argument("--max-prompt-duration", type=float)
    return parser.parse_args()


class LocalTtsWorker:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.repository_root = Path(args.repository_root).expanduser().resolve()
        self.roles_root = Path(args.roles_root).expanduser().resolve()
        self.output_dir = Path(args.output_dir).expanduser().resolve()
        self.cache_dir = Path(args.cache_dir).expanduser().resolve()
        self.prompt_audio = Path(args.prompt_audio).expanduser().resolve()
        for path in (self.repository_root, self.roles_root):
            if not path.is_dir():
                raise FileNotFoundError(f"Required local directory does not exist: {path}")
        if not self.prompt_audio.is_file():
            raise FileNotFoundError(f"Default prompt audio does not exist: {self.prompt_audio}")
        if args.engine == "cosyvoice3" and not Path(str(args.model or "")).expanduser().is_dir():
            raise FileNotFoundError(f"CosyVoice model directory does not exist: {args.model}")
        if args.engine == "gpt-sovits" and not Path(str(args.config or "")).expanduser().is_file():
            raise FileNotFoundError(f"GPT-SoVITS config does not exist: {args.config}")
        if args.engine == "qwen3-tts" and not Path(str(args.model or "")).expanduser().is_dir():
            raise FileNotFoundError(f"Qwen3-TTS model directory does not exist: {args.model}")
        if args.engine == "indextts2" and not Path(str(args.config or "")).expanduser().is_file():
            raise FileNotFoundError(f"IndexTTS2 config does not exist: {args.config}")

        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        service_root = Path(__file__).resolve().parents[1]
        sys.path.insert(0, str(service_root))
        from rabispeech.persona_voice import PersonaVoiceResolver

        prompt_defaults = {
            "gpt-sovits": (3.0, 8.0, 10.0),
            "qwen3-tts": (3.0, 8.0, 15.0),
            "indextts2": (3.0, 8.0, 15.0),
            "cosyvoice3": (3.0, 8.0, 30.0),
        }[args.engine]
        self.voice_refs = PersonaVoiceResolver(
            roles_root=self.roles_root,
            fallback_cache_dir=self.cache_dir / "reference-audio",
            default_prompt_audio=self.prompt_audio,
            min_prompt_duration=args.min_prompt_duration if args.min_prompt_duration is not None else prompt_defaults[0],
            target_prompt_duration=args.target_prompt_duration if args.target_prompt_duration is not None else prompt_defaults[1],
            max_prompt_duration=args.max_prompt_duration if args.max_prompt_duration is not None else prompt_defaults[2],
        )
        self.jobs: dict[str, dict[str, Any]] = {}
        self.jobs_lock = threading.Lock()
        self.inference_lock = threading.Lock()
        self.job_queue: queue.Queue[str] = queue.Queue()
        self.model: Any = None
        self.voice_prompt_cache: dict[tuple[str, str], Any] = {}
        self.model_load_seconds: float | None = None
        self.started_at = time.time()
        threading.Thread(target=self._generator_loop, name=f"{args.engine}-generator", daemon=True).start()

    def submit(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = str(payload.get("text") or "").strip()
        if not text:
            raise ValueError("text is required")
        character_folder = self.voice_refs.resolve_persona_voice_dir(
            payload.get("character_id"), payload.get("character_folder")
        )
        prompt_files = self.voice_refs.resolve_prompt_files(
            prompt_audio=payload.get("prompt_audio"),
            prompt_audios=payload.get("prompt_audios"),
            text=text,
            persona_voice_dir=character_folder,
            emotion_tags=payload.get("emotion_tags"),
            emotion_vector=payload.get("emotion_vector"),
            match_patterns=payload.get("match_patterns"),
        )
        prompt_audio, source_files, augmented = self.voice_refs.prepare_prompt_audio(prompt_files, character_folder)
        job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]
        output = self.output_dir / f"{job_id}.wav"
        job = {
            "id": job_id,
            "status": "queued",
            "text": text,
            "output": str(output),
            "created_at": time.time(),
            "updated_at": time.time(),
            "engine": self.args.engine,
            "character_id": payload.get("character_id"),
            "language": str(payload.get("language") or "auto"),
            "speed": float(payload.get("speed") or 1.0),
            "instructions": str(payload.get("instructions") or ""),
            "emotion_vector": payload.get("emotion_vector"),
            "ref_text": str(payload.get("ref_text") or self.voice_refs.reference_text(character_folder, source_files) or self.args.prompt_text or ""),
            "prompt_language": str(payload.get("prompt_language") or self.args.prompt_language or "zh"),
            "prompt_audio": str(prompt_audio),
            "prompt_audio_files": [str(path) for path in source_files],
            "prompt_audio_augmented": augmented,
            "error": None,
        }
        with self.jobs_lock:
            self.jobs[job_id] = job
        self.job_queue.put(job_id)
        return self._public_job(job)

    def snapshot(self, job_id: str | None = None) -> dict[str, Any]:
        with self.jobs_lock:
            if job_id:
                return self._public_job(self.jobs[job_id])
            jobs = [self._public_job(job) for job in list(self.jobs.values())[-20:]]
        return {
            "ok": True,
            "ready": True,
            "loaded": self.model is not None,
            "engine": self.args.engine,
            "model": Path(str(self.args.model or self.args.config)).name,
            "device": self._device(),
            "load_seconds": self.model_load_seconds,
            "uptime_seconds": round(time.time() - self.started_at, 3),
            "queued": self.job_queue.qsize(),
            "jobs": jobs,
        }

    def _generator_loop(self) -> None:
        while True:
            job_id = self.job_queue.get()
            try:
                self._run_job(job_id)
            except Exception as exc:
                details = traceback.format_exc()
                print(details, flush=True)
                with (self.cache_dir / "worker-errors.log").open("a", encoding="utf-8") as output:
                    output.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] job={job_id}\n{details}\n")
                self._set_job(job_id, status="error", error=f"{type(exc).__name__}: local model inference failed")
            finally:
                self.job_queue.task_done()

    def _run_job(self, job_id: str) -> None:
        with self.inference_lock:
            self._load_model()
            job = self._set_job(job_id, status="running", inference_started_at=time.time())
            started = time.perf_counter()
            output = Path(job["output"])
            if self.args.engine == "cosyvoice3":
                sample_rate, audio = self._run_cosyvoice(job)
            elif self.args.engine == "gpt-sovits":
                sample_rate, audio = self._run_gpt_sovits(job)
            elif self.args.engine == "qwen3-tts":
                sample_rate, audio = self._run_qwen3_tts(job)
            else:
                sample_rate, audio = self._run_indextts2(job)
            import soundfile as sf

            output.parent.mkdir(parents=True, exist_ok=True)
            sf.write(str(output), audio, sample_rate, subtype="PCM_16")
            self._set_job(
                job_id,
                status="done",
                sample_rate=sample_rate,
                inference_seconds=round(time.perf_counter() - started, 3),
                completed_at=time.time(),
            )

    def _load_model(self) -> None:
        if self.model is not None:
            return
        started = time.perf_counter()
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        if self.args.engine == "cosyvoice3":
            # lightning/pkg_resources eagerly scans every sys.path entry.
            # The Rabi workspace may be a mapped NAS drive; keep that transient
            # source path out of package discovery after PersonaVoiceResolver is loaded.
            sys.path[:] = [
                item
                for item in sys.path
                if "rabiroute\\plugin-adapters\\rabi-speech" not in str(item).replace("/", "\\").lower()
            ]
            matcha = self.repository_root / "third_party" / "Matcha-TTS"
            sys.path.insert(0, str(matcha))
            sys.path.insert(0, str(self.repository_root))
            from cosyvoice.cli.cosyvoice import AutoModel

            self.model = AutoModel(model_dir=str(Path(self.args.model).expanduser().resolve()))
        elif self.args.engine == "gpt-sovits":
            sys.path.insert(0, str(self.repository_root / "GPT_SoVITS"))
            sys.path.insert(0, str(self.repository_root))
            nltk_data = self.repository_root / "GPT_SoVITS" / "pretrained_models" / "nltk_data"
            os.environ.setdefault("NLTK_DATA", str(nltk_data))
            self._install_local_audio_loader()
            from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

            config = TTS_Config(str(Path(self.args.config).expanduser().resolve()))
            if self.args.no_fp16:
                config.is_half = False
            self.model = TTS(config)
        elif self.args.engine == "qwen3-tts":
            import torch
            from qwen_tts import Qwen3TTSModel

            dtype = torch.float32 if self.args.no_fp16 or not torch.cuda.is_available() else torch.bfloat16
            self.model = Qwen3TTSModel.from_pretrained(
                str(Path(self.args.model).expanduser().resolve()),
                device_map="cuda:0" if torch.cuda.is_available() else "cpu",
                dtype=dtype,
                attn_implementation="sdpa",
                local_files_only=True,
            )
        else:
            os.chdir(self.repository_root)
            sys.path.insert(0, str(self.repository_root))
            from indextts.infer_v2 import IndexTTS2

            config_path = Path(self.args.config).expanduser().resolve()
            self.model = IndexTTS2(
                cfg_path=str(config_path),
                model_dir=str(Path(self.args.model).expanduser().resolve()) if self.args.model else str(config_path.parent),
                use_fp16=not self.args.no_fp16,
                use_cuda_kernel=False,
                use_deepspeed=False,
            )
        self.model_load_seconds = round(time.perf_counter() - started, 3)

    @staticmethod
    def _install_local_audio_loader() -> None:
        """Keep GPT-SoVITS local WAV input independent of TorchCodec/FFmpeg DLLs."""
        import os

        import soundfile as sf
        import torch
        import torchaudio

        original_load = torchaudio.load

        def load_local_audio(uri: Any, *args: Any, **kwargs: Any) -> Any:
            if not isinstance(uri, (str, os.PathLike)):
                return original_load(uri, *args, **kwargs)
            frame_offset = int(kwargs.get("frame_offset", 0))
            num_frames = int(kwargs.get("num_frames", -1))
            data, sample_rate = sf.read(
                os.fspath(uri),
                start=max(0, frame_offset),
                frames=num_frames,
                dtype="float32",
                always_2d=True,
            )
            waveform = torch.from_numpy(data.T.copy())
            if not bool(kwargs.get("channels_first", True)):
                waveform = waveform.T
            return waveform, sample_rate

        torchaudio.load = load_local_audio

    def _run_cosyvoice(self, job: dict[str, Any]) -> tuple[int, Any]:
        import torch

        text = str(job["text"])
        prompt_text = str(job["ref_text"])
        prompt_audio = str(job["prompt_audio"])
        instructions = str(job["instructions"]).strip()
        speed = max(0.5, min(2.0, float(job["speed"])))
        if instructions:
            instruction = f"You are a helpful assistant. {instructions}<|endofprompt|>"
            results = self.model.inference_instruct2(text, instruction, prompt_audio, stream=False, speed=speed)
        elif prompt_text:
            prompt = prompt_text
            if not prompt.startswith("You are a helpful assistant."):
                prompt = f"You are a helpful assistant.<|endofprompt|>{prompt}"
            results = self.model.inference_zero_shot(text, prompt, prompt_audio, stream=False, speed=speed)
        else:
            target = text
            if not target.startswith("You are a helpful assistant."):
                target = f"You are a helpful assistant.<|endofprompt|>{target}"
            results = self.model.inference_cross_lingual(target, prompt_audio, stream=False, speed=speed)
        chunks = [item["tts_speech"].detach().cpu().reshape(-1) for item in results]
        if not chunks:
            raise RuntimeError("CosyVoice returned no audio chunks.")
        return int(self.model.sample_rate), torch.cat(chunks).numpy()

    def _run_gpt_sovits(self, job: dict[str, Any]) -> tuple[int, Any]:
        import numpy as np

        language = LANGUAGE_CODES.get(str(job["language"]).strip().lower(), "auto")
        prompt_language = LANGUAGE_CODES.get(str(job["prompt_language"]).strip().lower(), "zh")
        request = {
            "text": str(job["text"]),
            "text_lang": language,
            "ref_audio_path": str(job["prompt_audio"]),
            "aux_ref_audio_paths": [],
            "prompt_text": str(job["ref_text"]),
            "prompt_lang": prompt_language,
            "top_k": 15,
            "top_p": 1.0,
            "temperature": 1.0,
            "text_split_method": "cut5",
            "batch_size": 1,
            "speed_factor": max(0.5, min(2.0, float(job["speed"]))),
            "parallel_infer": True,
            "streaming_mode": False,
        }
        results = list(self.model.run(request))
        if not results:
            raise RuntimeError("GPT-SoVITS returned no audio chunks.")
        rates = {int(rate) for rate, _ in results}
        if len(rates) != 1:
            raise RuntimeError(f"GPT-SoVITS returned inconsistent sample rates: {sorted(rates)}")
        return rates.pop(), np.concatenate([np.asarray(audio).reshape(-1) for _, audio in results])

    def _run_qwen3_tts(self, job: dict[str, Any]) -> tuple[int, Any]:
        import numpy as np

        prompt_audio = str(job["prompt_audio"])
        ref_text = str(job["ref_text"] or "").strip()
        prompt_key = (prompt_audio, ref_text)
        if prompt_key not in self.voice_prompt_cache:
            self.voice_prompt_cache[prompt_key] = self.model.create_voice_clone_prompt(
                ref_audio=prompt_audio,
                ref_text=ref_text or None,
                x_vector_only_mode=not bool(ref_text),
            )
        language = QWEN_LANGUAGE_NAMES.get(str(job["language"]).strip().lower(), "Auto")
        wavs, sample_rate = self.model.generate_voice_clone(
            text=str(job["text"]),
            language=language,
            voice_clone_prompt=self.voice_prompt_cache[prompt_key],
            max_new_tokens=int(self.args.max_new_tokens),
        )
        if not wavs:
            raise RuntimeError("Qwen3-TTS returned no audio.")
        return int(sample_rate), np.asarray(wavs[0], dtype="float32").reshape(-1)

    @staticmethod
    def _default_index_emotion(text: str) -> list[float]:
        vector = [0.12, 0.0, 0.0, 0.0, 0.0, 0.0, 0.04, 0.2]
        if any(mark in text for mark in ("！", "!")):
            vector = [0.22, 0.0, 0.0, 0.0, 0.0, 0.0, 0.12, 0.1]
        elif any(mark in text for mark in ("？", "?")):
            vector = [0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.14, 0.16]
        return vector

    def _run_indextts2(self, job: dict[str, Any]) -> tuple[int, Any]:
        import soundfile as sf

        raw_vector = job.get("emotion_vector")
        vector = raw_vector if isinstance(raw_vector, list) and len(raw_vector) == 8 else self._default_index_emotion(str(job["text"]))
        vector = self.model.normalize_emo_vec([float(value) for value in vector], apply_bias=True)
        instructions = str(job.get("instructions") or "").strip()
        temp_output = self.cache_dir / f"{job['id']}-indextts2.wav"
        self.model.infer(
            spk_audio_prompt=str(job["prompt_audio"]),
            text=str(job["text"]),
            output_path=str(temp_output),
            emo_alpha=max(0.0, min(1.0, float(self.args.emotion_alpha))),
            emo_vector=None if instructions else vector,
            use_emo_text=bool(instructions),
            emo_text=instructions or None,
            use_random=False,
            verbose=False,
            max_text_tokens_per_segment=80,
            do_sample=True,
            top_p=0.8,
            top_k=20,
            temperature=0.8,
            length_penalty=0.0,
            num_beams=3,
            repetition_penalty=10.0,
            max_mel_tokens=700,
        )
        audio, sample_rate = sf.read(str(temp_output), dtype="float32")
        temp_output.unlink(missing_ok=True)
        if getattr(audio, "ndim", 1) > 1:
            audio = audio.mean(axis=1)
        return int(sample_rate), audio

    def _set_job(self, job_id: str, **updates: Any) -> dict[str, Any]:
        with self.jobs_lock:
            job = self.jobs[job_id]
            job.update(updates)
            job["updated_at"] = time.time()
            return dict(job)

    @staticmethod
    def _public_job(job: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "id",
            "status",
            "output",
            "engine",
            "character_id",
            "language",
            "sample_rate",
            "inference_seconds",
            "created_at",
            "updated_at",
            "completed_at",
            "error",
        }
        return {key: value for key, value in job.items() if key in allowed}

    @staticmethod
    def _device() -> str:
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            return "unknown"


def make_handler(worker: LocalTtsWorker):
    class Handler(BaseHTTPRequestHandler):
        server_version = "RabiSpeechTtsWorker/1"

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path in {"/health", "/status"}:
                self._json(200, worker.snapshot())
                return
            if path.startswith("/status/"):
                try:
                    self._json(200, worker.snapshot(path.rsplit("/", 1)[-1]))
                except KeyError:
                    self._json(404, {"status": "missing", "error": "Unknown job id."})
                return
            self._json(404, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            if urlparse(self.path).path != "/speak":
                self._json(404, {"error": "not_found"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > 1024 * 1024:
                    raise ValueError("Request body is empty or too large.")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                self._json(202, worker.submit(payload))
            except Exception as exc:
                self._json(400, {"error": type(exc).__name__, "message": str(exc)})

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


def main() -> int:
    args = parse_args()
    worker = LocalTtsWorker(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(worker))
    print(json.dumps({"url": f"http://{args.host}:{args.port}", **worker.snapshot()}, ensure_ascii=False), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
