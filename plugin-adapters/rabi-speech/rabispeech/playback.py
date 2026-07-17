from __future__ import annotations

import os
import queue
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable


class PlaybackCoordinator:
    """One host-wide FIFO for audio produced by every Route and direct caller."""

    def __init__(self, queue_dir: str | Path, player: Callable[[Path], None] | None = None) -> None:
        self.queue_dir = Path(queue_dir).expanduser().resolve()
        self.queue_dir.mkdir(parents=True, exist_ok=True)
        self._player = player or self._default_player
        self._queue: queue.Queue[str] = queue.Queue()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._current: str | None = None
        threading.Thread(target=self._run, name="rabispeech-playback", daemon=True).start()

    def enqueue(
        self,
        source: Path,
        *,
        provider: str,
        model: str,
        voice: str,
        session_id: str | None = None,
        route_id: str | None = None,
    ) -> dict[str, Any]:
        source = source.expanduser().resolve()
        if source.suffix.lower() != ".wav" or not source.is_file():
            raise ValueError("Host playback queue accepts completed local WAV files only.")
        job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]
        snapshot = self.queue_dir / f"{job_id}.wav"
        shutil.copyfile(source, snapshot)
        job = {
            "id": job_id,
            "status": "queued",
            "provider": provider,
            "model": model,
            "voice": voice,
            "session_id": session_id or None,
            "route_id": route_id or None,
            "created_at": time.time(),
            "updated_at": time.time(),
            "path": str(snapshot),
        }
        with self._lock:
            self._jobs[job_id] = job
        self._queue.put(job_id)
        return self._public(job)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            jobs = [self._public(job) for job in list(self._jobs.values())[-50:]]
            current = self._current
        return {
            "ok": True,
            "mode": "host_fifo",
            "current": current,
            "queued": self._queue.qsize(),
            "jobs": jobs,
        }

    def stop(self, clear_pending: bool = True) -> dict[str, Any]:
        if os.name == "nt":
            try:
                import winsound

                winsound.PlaySound(None, winsound.SND_PURGE)
            except RuntimeError:
                pass
        if clear_pending:
            while True:
                try:
                    job_id = self._queue.get_nowait()
                except queue.Empty:
                    break
                self._update(job_id, status="cancelled")
                self._cleanup(job_id)
                self._queue.task_done()
        return self.snapshot()

    def _run(self) -> None:
        while True:
            job_id = self._queue.get()
            with self._lock:
                self._current = job_id
            try:
                job = self._update(job_id, status="playing", started_at=time.time())
                self._player(Path(str(job["path"])))
                self._update(job_id, status="done", completed_at=time.time())
            except Exception as exc:
                self._update(job_id, status="error", error=f"{type(exc).__name__}: playback failed")
            finally:
                self._cleanup(job_id)
                with self._lock:
                    self._current = None
                self._queue.task_done()

    def _update(self, job_id: str, **updates: Any) -> dict[str, Any]:
        with self._lock:
            job = self._jobs[job_id]
            job.update(updates)
            job["updated_at"] = time.time()
            return dict(job)

    def _cleanup(self, job_id: str) -> None:
        with self._lock:
            job = dict(self._jobs.get(job_id) or {})
        path = Path(str(job.get("path") or ""))
        if path.is_file() and path.is_relative_to(self.queue_dir):
            path.unlink(missing_ok=True)

    @staticmethod
    def _public(job: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in job.items() if key != "path"}

    @staticmethod
    def _default_player(path: Path) -> None:
        if os.name == "nt":
            import winsound

            winsound.PlaySound(str(path), winsound.SND_FILENAME)
            return
        import sounddevice as sd
        import soundfile as sf

        audio, sample_rate = sf.read(str(path), dtype="float32")
        sd.play(audio, sample_rate, blocking=True)
