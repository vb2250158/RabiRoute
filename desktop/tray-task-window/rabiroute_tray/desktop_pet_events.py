from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from typing import BinaryIO
from urllib.request import Request, urlopen

from PySide6.QtCore import QObject, Signal


def iter_sse_events(stream: BinaryIO) -> Iterator[tuple[str, object]]:
    event_name = "message"
    data_lines: list[str] = []
    while True:
        raw_line = stream.readline()
        if not raw_line:
            return
        line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
        if not line:
            if data_lines:
                raw_data = "\n".join(data_lines)
                try:
                    data: object = json.loads(raw_data)
                except json.JSONDecodeError:
                    data = raw_data
                yield event_name, data
            event_name = "message"
            data_lines = []
        elif line.startswith("event:"):
            event_name = line[6:].strip() or "message"
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())


class DesktopPetEventStream(QObject):
    """Reconnectable Manager SSE adapter; it never owns work-event policy."""

    work_ended = Signal(object)
    connection_changed = Signal(bool)

    def __init__(self, manager_url: str) -> None:
        super().__init__()
        self._url = f"{manager_url.rstrip('/')}/api/events"
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._response: object | None = None
        self._connected = False

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="rabi-desktop-pet-events", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        response = self._response
        if response is not None:
            try:
                response.close()  # type: ignore[attr-defined]
            except OSError:
                pass
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
        self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                request = Request(self._url, method="GET", headers={"accept": "text/event-stream"})
                with urlopen(request, timeout=65.0) as response:
                    self._response = response
                    if not self._connected:
                        self._connected = True
                        self.connection_changed.emit(True)
                    for event_name, payload in iter_sse_events(response):
                        if self._stop.is_set():
                            return
                        if event_name == "work_ended" and isinstance(payload, dict):
                            self.work_ended.emit(payload)
            except (OSError, TimeoutError, ValueError):
                pass
            finally:
                self._response = None
                if self._connected and not self._stop.is_set():
                    self._connected = False
                    self.connection_changed.emit(False)
            self._stop.wait(3.0)
