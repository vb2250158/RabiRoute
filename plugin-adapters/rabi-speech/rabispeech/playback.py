from __future__ import annotations

import json
import os
import queue
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable


PlaybackPlayer = Callable[[Path, int, threading.Event], None]


def _validated_volume(value: object) -> int:
    if type(value) is not int or not 0 <= value <= 100:
        raise ValueError("Playback volume must be an integer from 0 to 100.")
    return value


def _apply_volume(audio: Any, volume: int) -> Any:
    gain = _validated_volume(volume) / 100.0
    return audio if gain == 1.0 else audio * gain


class PlaybackSettingsStore:
    """Persist the one host-wide speaker volume independently from Routes and personas."""

    def __init__(self, path: str | Path, default_volume: int = 100) -> None:
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._volume = self._load(_validated_volume(default_volume))
        self._write(self._volume)

    @property
    def volume(self) -> int:
        with self._lock:
            return self._volume

    def set_volume(self, value: object) -> int:
        volume = _validated_volume(value)
        with self._lock:
            self._write(volume)
            self._volume = volume
        return volume

    def _load(self, fallback: int) -> int:
        if not self.path.is_file():
            return fallback
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
            return _validated_volume(value.get("volume") if isinstance(value, dict) else None)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return fallback

    def _write(self, volume: int) -> None:
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(
                json.dumps({"version": 1, "volume": volume}, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)


class PlaybackCoordinator:
    """One host-wide FIFO for audio produced by every Route and direct caller."""

    def __init__(
        self,
        queue_dir: str | Path,
        player: PlaybackPlayer | None = None,
        *,
        state_path: str | Path | None = None,
        stopper: Callable[[], None] | None = None,
    ) -> None:
        self.queue_dir = Path(queue_dir).expanduser().resolve()
        self.queue_dir.mkdir(parents=True, exist_ok=True)
        self.settings = PlaybackSettingsStore(state_path or self.queue_dir.parent / "playback-settings.json")
        self._player = player or self._default_player
        self._stopper = stopper or self._default_stopper
        self._queue: queue.Queue[str] = queue.Queue()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._current: str | None = None
        self._current_cancel: threading.Event | None = None
        self._stop_generation = 0
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
        now = time.time()
        with self._lock:
            job = {
                "id": job_id,
                "status": "queued",
                "provider": provider,
                "model": model,
                "voice": voice,
                "session_id": session_id or None,
                "route_id": route_id or None,
                "created_at": now,
                "updated_at": now,
                "path": str(snapshot),
                "_stop_generation": self._stop_generation,
            }
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
            "volume": self.settings.volume,
            "current": current,
            "queued": self._queue.qsize(),
            "jobs": jobs,
        }

    def set_volume(self, volume: object) -> dict[str, Any]:
        self.settings.set_volume(volume)
        return self.snapshot()

    def stop(self, clear_pending: bool = True) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            self._stop_generation += 1
            current = self._current
            cancel = self._current_cancel
            if cancel is not None:
                cancel.set()
            if current and current in self._jobs:
                self._jobs[current].update(status="cancelled", completed_at=now, updated_at=now)
        try:
            self._stopper()
        except Exception:
            pass
        if clear_pending:
            while True:
                try:
                    job_id = self._queue.get_nowait()
                except queue.Empty:
                    break
                self._update(job_id, status="cancelled", completed_at=time.time())
                self._cleanup(job_id)
                self._queue.task_done()
        return self.snapshot()

    def _run(self) -> None:
        while True:
            job_id = self._queue.get()
            cancel = threading.Event()
            volume = self.settings.volume
            with self._lock:
                job = self._jobs[job_id]
                cancelled_before_start = int(job.get("_stop_generation") or 0) < self._stop_generation
                if cancelled_before_start:
                    job.update(status="cancelled", completed_at=time.time(), updated_at=time.time())
                    job_snapshot = dict(job)
                else:
                    self._current = job_id
                    self._current_cancel = cancel
                    job.update(status="playing", volume=volume, started_at=time.time(), updated_at=time.time())
                    job_snapshot = dict(job)
            if cancelled_before_start:
                self._cleanup(job_id)
                self._queue.task_done()
                continue
            try:
                self._player(Path(str(job_snapshot["path"])), volume, cancel)
                if cancel.is_set():
                    self._update(job_id, status="cancelled", completed_at=time.time())
                else:
                    self._update(job_id, status="done", completed_at=time.time())
            except Exception as exc:
                if cancel.is_set():
                    self._update(job_id, status="cancelled", completed_at=time.time())
                else:
                    self._update(job_id, status="error", error=f"{type(exc).__name__}: playback failed")
            finally:
                self._cleanup(job_id)
                with self._lock:
                    if self._current == job_id:
                        self._current = None
                        self._current_cancel = None
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
        return {key: value for key, value in job.items() if key != "path" and not key.startswith("_")}

    @staticmethod
    def _default_player(path: Path, volume: int, cancel: threading.Event) -> None:
        import sounddevice as sd
        import soundfile as sf

        from .windows_audio_session import windows_audio_session_identity

        if cancel.is_set():
            return
        audio, sample_rate = sf.read(str(path), dtype="float32")
        audio = _apply_volume(audio, volume)
        if cancel.is_set():
            return
        with windows_audio_session_identity():
            sd.play(audio, sample_rate, blocking=False)
            if cancel.is_set():
                sd.stop()
                return
            sd.wait()

    @staticmethod
    def _default_stopper() -> None:
        import sounddevice as sd

        sd.stop()
