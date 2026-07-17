from __future__ import annotations

import os
import queue
import threading
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from rabispeech.onnx_vits.engine import OnnxVitsEngine, write_pcm16_wav


SERVICE_DIR = Path(__file__).resolve().parents[2]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def optional_path(name: str) -> Path | None:
    value = os.environ.get(name, "").strip()
    return Path(value).expanduser().resolve() if value else None


def optional_int(name: str) -> int | None:
    value = os.environ.get(name, "").strip()
    return int(value) if value else None


@dataclass(frozen=True)
class WorkerSettings:
    model_dir: Path | None
    config_path: Path | None
    output_root: Path
    providers: list[str] | None = None
    default_speaker: str | None = None
    default_speaker_id: int | None = None
    default_speed: float = 1.0
    max_seconds: float = 120.0

    @classmethod
    def from_env(cls) -> WorkerSettings:
        raw_providers = [
            item.strip()
            for item in os.environ.get("RABISPEECH_ONNX_VITS_PROVIDERS", "").split(",")
            if item.strip()
        ]
        output = optional_path("RABISPEECH_ONNX_VITS_OUTPUT") or (SERVICE_DIR / "output" / "onnx-vits").resolve()
        return cls(
            model_dir=optional_path("RABISPEECH_ONNX_VITS_MODEL_DIR"),
            config_path=optional_path("RABISPEECH_ONNX_VITS_CONFIG"),
            output_root=output,
            providers=raw_providers or None,
            default_speaker=os.environ.get("RABISPEECH_ONNX_VITS_DEFAULT_SPEAKER", "").strip() or None,
            default_speaker_id=optional_int("RABISPEECH_ONNX_VITS_DEFAULT_SPEAKER_ID"),
            default_speed=float(os.environ.get("RABISPEECH_ONNX_VITS_DEFAULT_SPEED", "1")),
            max_seconds=float(os.environ.get("RABISPEECH_ONNX_VITS_MAX_SECONDS", "120")),
        )


class SpeakPayload(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    play: bool = False
    language: str | None = None
    character_id: str | None = None
    speaker: str | None = None
    speaker_id: int | None = Field(default=None, ge=0)
    speed: float | None = Field(default=None, ge=0.25, le=4.0)
    noise_scale: float = Field(default=0.667, ge=0.0, le=2.0)
    seed: int | None = None

    class Config:
        extra = "ignore"


EngineFactory = Callable[[WorkerSettings], OnnxVitsEngine]


def default_engine_factory(settings: WorkerSettings) -> OnnxVitsEngine:
    if settings.model_dir is None or settings.config_path is None:
        raise RuntimeError("RABISPEECH_ONNX_VITS_MODEL_DIR and RABISPEECH_ONNX_VITS_CONFIG are required.")
    return OnnxVitsEngine(
        settings.model_dir,
        settings.config_path,
        providers=settings.providers,
        max_seconds=settings.max_seconds,
    )


class OnnxVitsWorker:
    def __init__(
        self,
        settings: WorkerSettings,
        *,
        engine_factory: EngineFactory = default_engine_factory,
    ) -> None:
        self.settings = settings
        self.engine_factory = engine_factory
        self.engine: OnnxVitsEngine | None = None
        self.configuration_error: str | None = None
        self.jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._thread: threading.Thread | None = None

    @property
    def ready(self) -> bool:
        return self.engine is not None and self.configuration_error is None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        try:
            self.engine = self.engine_factory(self.settings)
            self.configuration_error = None
        except Exception as exc:
            self.engine = None
            self.configuration_error = str(exc)
            return
        self._thread = threading.Thread(target=self._run_jobs, name="rabispeech-onnx-vits", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if not self._thread:
            return
        self._queue.put(None)
        self._thread.join(timeout=5.0)
        self._thread = None

    def submit(self, payload: SpeakPayload) -> dict[str, Any]:
        if not self.ready:
            raise RuntimeError(self.configuration_error or "ONNX-VITS worker is not ready.")
        job_id = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
        output = (
            self.settings.output_root
            / datetime.now().strftime("%Y-%m-%d")
            / job_id
            / "final.wav"
        ).resolve()
        request_data = payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()
        job = {
            "id": job_id,
            "status": "queued",
            "output": str(output),
            "play": payload.play,
            "character_id": payload.character_id,
            "queued_at": utc_now(),
            "started_at": None,
            "completed_at": None,
            "error": None,
            "metadata": None,
            "request": request_data,
        }
        with self._lock:
            self.jobs[job_id] = job
        self._queue.put(job_id)
        return self.public_job(job_id)

    def public_job(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            if job_id not in self.jobs:
                return {"id": job_id, "status": "missing"}
            job = dict(self.jobs[job_id])
        job.pop("request", None)
        return job

    def status(self) -> dict[str, Any]:
        with self._lock:
            completed = sum(job["status"] == "done" for job in self.jobs.values())
            failed = sum(job["status"] == "error" for job in self.jobs.values())
        return {
            "engine": "ONNX-VITS",
            "ready": self.ready,
            "configuration_error": self.configuration_error,
            "queued": self._queue.qsize(),
            "jobs": len(self.jobs),
            "completed": completed,
            "failed": failed,
            "providers": list(self.engine.providers) if self.engine else [],
            "sample_rate": self.engine.sample_rate if self.engine else None,
            "speaker_count": len(self.engine.speakers) if self.engine else 0,
            "playback_host": "RabiSpeech global FIFO",
            "playback_enabled": False,
        }

    def speakers(self) -> list[dict[str, Any]]:
        if not self.engine:
            return []
        return [
            {"name": name, "speaker_id": speaker_id}
            for name, speaker_id in sorted(self.engine.speakers.items(), key=lambda item: (item[1], item[0]))
        ]

    def _run_jobs(self) -> None:
        while True:
            job_id = self._queue.get()
            try:
                if job_id is None:
                    return
                self._run_job(job_id)
            finally:
                self._queue.task_done()

    def _run_job(self, job_id: str) -> None:
        assert self.engine is not None
        with self._lock:
            job = self.jobs[job_id]
            job.update(status="processing", started_at=utc_now())
            request = dict(job["request"])
        try:
            result = self.engine.synthesize(
                str(request["text"]),
                speaker=request.get("speaker") or self.settings.default_speaker,
                speaker_id=request.get("speaker_id")
                if request.get("speaker_id") is not None
                else self.settings.default_speaker_id,
                language=request.get("language"),
                speed=request.get("speed") or self.settings.default_speed,
                noise_scale=request.get("noise_scale", 0.667),
                seed=request.get("seed"),
            )
            output = write_pcm16_wav(job["output"], result.audio, result.sample_rate)
            metadata = {
                **result.metadata,
                "playback_delegated_to_rabispeech": True,
                "output_bytes": output.stat().st_size,
            }
            with self._lock:
                job.update(status="done", output=str(output), metadata=metadata, completed_at=utc_now())
        except Exception as exc:
            with self._lock:
                job.update(status="error", error=str(exc), completed_at=utc_now())


def create_app(service: OnnxVitsWorker | None = None) -> FastAPI:
    worker = service or OnnxVitsWorker(WorkerSettings.from_env())

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        worker.start()
        try:
            yield
        finally:
            worker.stop()

    api = FastAPI(title="RabiSpeech ONNX-VITS Worker", lifespan=lifespan)

    @api.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": worker.ready, **worker.status()}

    @api.get("/status")
    async def status() -> dict[str, Any]:
        return worker.status()

    @api.get("/status/{job_id}")
    async def job_status(job_id: str) -> dict[str, Any]:
        return worker.public_job(job_id)

    @api.get("/speakers")
    async def speakers() -> dict[str, Any]:
        return {"engine": "ONNX-VITS", "speakers": worker.speakers()}

    @api.post("/speak")
    async def speak(payload: SpeakPayload) -> dict[str, Any]:
        try:
            return worker.submit(payload)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    api.state.onnx_vits_worker = worker
    return api


app = create_app()
