from __future__ import annotations

import json
from urllib.request import Request, urlopen

from PySide6.QtCore import QObject, Signal

from .desktop_pet_events import DesktopPetEventStream
from .qt_async import QtAsyncTask, start_qt_task


class DesktopPetSpeech(QObject):
    """Render the speech owner's job, without synthesizing or playing audio in Qt."""

    changed = Signal(object)

    def __init__(self, manager_url: str, persona_id: str, events: DesktopPetEventStream, parent: QObject) -> None:
        super().__init__(parent)
        self._url = manager_url.rstrip("/")
        self._persona_id = persona_id
        self._events = events
        self._job: dict = {}
        self._last_started = 0.0
        self._task: QtAsyncTask | None = None
        self._closed = False
        events.playback_changed.connect(self.accept)
        events.connection_changed.connect(self._connection_changed)

    def close(self) -> None:
        self._closed = True
        self._events.playback_changed.disconnect(self.accept)
        self._events.connection_changed.disconnect(self._connection_changed)

    def _request(self, path: str) -> dict:
        request = Request(self._url + path, method="GET", headers={"accept": "application/json"})
        with urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return payload.get("data", payload)

    def accept(self, payload: object, *, current_only: bool = False) -> None:
        if self._closed or not isinstance(payload, dict):
            return
        jobs = {str(job.get("id")): job for job in payload.get("jobs", []) if isinstance(job, dict)}
        current = jobs.get(str(payload.get("current") or ""))
        if current and current.get("voice") == self._persona_id and current.get("status") == "playing":
            candidate = current
        elif not current_only:
            candidate = jobs.get(str(self._job.get("id") or ""))
        else:
            candidate = None
        if not candidate or candidate.get("voice") != self._persona_id or not candidate.get("text"):
            return
        candidate = dict(candidate)
        started = float(candidate.get("started_at", candidate.get("startedAt", 0)) or 0)
        if started < self._last_started:
            return
        if candidate.get("id") == self._job.get("id"):
            updated = float(candidate.get("updated_at", candidate.get("updatedAt", 0)) or 0)
            previous = float(self._job.get("updated_at", self._job.get("updatedAt", 0)) or 0)
            if updated < previous:
                return
        self._last_started = started
        if candidate == self._job:
            return
        self._job = candidate
        self.changed.emit(candidate)

    def reconnect(self) -> None:
        if self._closed or self._task is not None:
            return
        def completed(task: QtAsyncTask, result: object) -> None:
            if self._task is task:
                self._task = None
            if not self._closed and isinstance(result, dict):
                self.accept(result, current_only=True)
        self._task = start_qt_task(lambda: self._request("/api/speech/playback/status"), completed,
                                   on_error=lambda error: error)

    def _connection_changed(self, connected: bool) -> None:
        if connected:
            self.reconnect()
        elif self._job.get("status") == "playing":
            self._job = {}
            self.changed.emit({})
