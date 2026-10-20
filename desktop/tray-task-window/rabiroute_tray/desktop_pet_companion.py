"""Explicit pet-menu companionship; bounded acquisition through desktop capture.

Manager owns activity state. No player/game input, screenshots on disk, or browser picker.
"""
from __future__ import annotations

import base64
import ctypes
import io
import json
import os
import time
import uuid
from ctypes import wintypes
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from PySide6.QtCore import QObject, QTimer, Signal

from .desktop_capture import capture_desktop_pixels
from .desktop_pet_motion import foreground_window
from .desktop_pet_media import foreground_media_evidence
from .qt_async import start_qt_task
from .companion_observation_buffer import CompanionRecorder


def foreground_observation(sequence: int) -> dict | None:
    window = foreground_window()
    if window is None:
        return None
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    title = ctypes.create_unicode_buffer(201)
    user32.GetWindowTextW(window.handle, title, len(title))
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(window.handle, ctypes.byref(pid))
    process_name = ""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    handle = kernel32.OpenProcess(0x1000, False, pid.value)
    if handle:
        try:
            name = ctypes.create_unicode_buffer(32768)
            size = wintypes.DWORD(len(name))
            if kernel32.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(size)):
                process_name = os.path.basename(name.value)[:120]
        finally:
            kernel32.CloseHandle(handle)
    # The recording/F1 acquisition owner provides native all-monitor pixels. Crop
    # to foreground physical bounds, preserving negative-origin monitor layouts.
    pixels = capture_desktop_pixels()
    user32.GetSystemMetrics.argtypes = [ctypes.c_int]
    origin_x, origin_y = user32.GetSystemMetrics(76), user32.GetSystemMetrics(77)
    left, top, right, bottom = window.bounds
    bounds = (max(0, left-origin_x), max(0, top-origin_y),
              min(pixels.width, right-origin_x), min(pixels.height, bottom-origin_y))
    if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
        return None
    pixels = pixels.crop(bounds).convert("RGB")
    pixels.thumbnail((960, 960))
    media = foreground_media_evidence(title.value)
    current = foreground_window()
    if current is None or current.handle != window.handle:
        return None  # discard frames acquired during a window switch
    buffer = io.BytesIO()
    pixels.save(buffer, format="JPEG", quality=72)
    return {"sequence": sequence, "capturedAt": int(time.time()*1000), "source": "window",
            "jpeg": base64.b64encode(buffer.getvalue()).decode("ascii"),
            **({"media": media} if media else {}),
            "window": {"id": f"{window.handle}:{pid.value}", "title": title.value[:200], "processName": process_name}}


class DesktopPetCompanion(QObject):
    changed = Signal(object)
    failed = Signal(str)

    def __init__(self, manager_url: str, persona_id: str, parent: QObject) -> None:
        super().__init__(parent)
        self._base = f"{manager_url.rstrip('/')}/api/roles/{quote(persona_id, safe='')}/companion"
        self._persona_id = persona_id
        self.session: dict = {}
        self.presets: list[dict] = []
        self.busy = False
        self.control_busy = False
        self._epoch = 0
        self._pause_pending = False
        self.closed = False
        self._sequence = 0
        self._needs_reconnect = False
        self._reconnect_requested = False
        self._retry_delay = 5000
        self._observation_policy = None
        self._recorder = CompanionRecorder(foreground_observation)
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self._acquire)

    def _request(self, action: str = "", body: dict | None = None) -> dict:
        request = Request(self._base + (f"/{action}" if action else ""),
                          data=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None,
                          headers={"content-type": "application/json", "accept": "application/json"})
        with urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("code") != 0:
            raise RuntimeError(payload.get("message") or "陪伴请求失败")
        return payload["data"]

    def accept(self, session: dict) -> None:
        old = self.session
        if old.get("id") == session.get("id") and int(session.get("version", 0)) < int(old.get("version", 0)):
            return
        if old.get("id") == session.get("id") and int(session.get("revision", 0)) < int(old.get("revision", 0)):
            return
        self.session = session if session.get("status") in ("active", "paused") else {}
        if old.get("id") != session.get("id") or old.get("revision") != session.get("revision"):
            self._sequence = 0
        if not self._enabled():
            self._timer.stop()
            self._recorder.stop()
        elif not self.busy and not self.control_busy and not self._timer.isActive():
            self._timer.start(350)
        if self._enabled() and self._observation_policy:
            self._recorder.configure((session["id"], session["revision"]), self._observation_policy)

    def _enabled(self) -> bool:
        running = self.session.get("status") == "active" or (self.session.get("status") == "paused" and self.session.get("pauseReason") == "capture_lost")
        return not self.closed and running and self.session.get("observationOwner") == "desktop"

    def set_playback_active(self, playing: bool) -> None:
        with self._recorder.lock:
            self._recorder.suppressed = playing

    def toggle(self) -> None:
        if self.control_busy or self.closed:
            return
        self._epoch += 1
        self._timer.stop()
        self._recorder.stop()
        def operation():
            snapshot = self._request()
            session = snapshot.get("session") or {}
            if session.get("status") in ("active", "paused"):
                return self._request("command", {"sessionId": session["id"], "revision": session["revision"], "action": "stop"})
            return self._request("start", {"requestId": str(uuid.uuid4()), "presetId": "adaptive", "title": "",
                                          "autoReview": True, "voice": True, "observationOwner": "desktop"})
        self._work(operation, control=True)

    def select_mode(self, preset_id: str) -> None:
        if self.control_busy or self.closed or not preset_id:
            return
        self._epoch += 1
        self._timer.stop()

        def operation():
            snapshot = self._request()
            session = snapshot.get("session") or {}
            if session.get("status") in ("active", "paused"):
                if session.get("presetId") == preset_id:
                    return snapshot
                return self._request("command", {
                    "sessionId": session["id"], "revision": session["revision"],
                    "action": "set-mode", "presetId": preset_id})
            return self._request("start", {
                "requestId": str(uuid.uuid4()), "presetId": preset_id, "title": "",
                "autoReview": True, "voice": True, "observationOwner": "desktop"})

        self._work(operation, control=True)

    def reconnect(self) -> None:
        if not self.closed and (self.busy or self.control_busy):
            self._reconnect_requested = True
            return
        if not self.busy and not self.control_busy and not self.closed:
            epoch = self._epoch
            def operation():
                snapshot = self._request()
                current = snapshot.get("session") or {}
                intent = snapshot.get("resumeIntent")
                if (not self.closed and epoch == self._epoch and not self.control_busy
                        and current.get("status") not in ("active", "paused")
                        and isinstance(intent, dict) and intent.get("observationOwner") == "desktop"):
                    return self._request("start", {**intent, "requestId": str(uuid.uuid4())})
                return snapshot
            self._work(operation)

    def pause(self) -> None:
        self._timer.stop()
        self._recorder.stop()
        if self.closed:
            return
        if self.control_busy:
            self._pause_pending = True
            return
        if not self.session:
            return
        self._epoch += 1
        def operation():
            snapshot = self._request()
            s = snapshot.get("session") or {}
            if s.get("status") == "active":
                return self._request("command", {"sessionId": s["id"], "revision": s["revision"], "action": "pause"})
            return snapshot
        self._work(operation, control=True)

    def _work(self, operation, *, control: bool = False) -> None:
        if control:
            self.control_busy = True
        else:
            self.busy = True
        epoch = self._epoch
        def finished(_task, result):
            if control:
                self.control_busy = False
            else:
                self.busy = False
            if self.closed:
                return
            if epoch != self._epoch:
                if self._reconnect_requested and not self.control_busy:
                    self._reconnect_requested = False
                    self.reconnect()
                    return
                if self._enabled() and not self.control_busy:
                    self._timer.start(350)
                return
            if isinstance(result, Exception):
                self._timer.stop()
                if self._reconnect_requested and not self.control_busy:
                    self._reconnect_requested = False
                    self.reconnect()
                    return
                if isinstance(result, HTTPError) and result.code == 409:
                    self.reconnect()
                    return
                self.failed.emit(str(result))
                if self._enabled() and (isinstance(result, (URLError, TimeoutError, OSError))
                                        and (not isinstance(result, HTTPError) or result.code >= 500)):
                    self._needs_reconnect = True
                    self._timer.start(self._retry_delay)
                    self._retry_delay = min(30000, self._retry_delay * 2)
                return
            self._needs_reconnect = False
            self._retry_delay = 5000
            if isinstance(result.get("presets"), list):
                self.presets = [preset for preset in result["presets"]
                                if isinstance(preset, dict) and isinstance(preset.get("id"), str)]
            if isinstance(result.get("observationPolicy"), dict):
                self._observation_policy = result["observationPolicy"]
            session = result.get("session") or {}
            self.accept(session)
            self.changed.emit({"roleId": self._persona_id, "session": session})
            if self._pause_pending and not self.control_busy:
                self._pause_pending = False
                self.pause()
                return
            if self._reconnect_requested and not self.control_busy:
                self._reconnect_requested = False
                self.reconnect()
                return
            if self._enabled() and not self.busy and not self.control_busy:
                self._timer.start(int((self._observation_policy or {}).get("uploadSeconds", 5) * 1000))
        start_qt_task(operation, finished)

    def _acquire(self) -> None:
        if not self._enabled() or self.busy or self.control_busy:
            return
        if self._needs_reconnect:
            self.reconnect()  # reconcile uncertain writes; never replay them
            return
        captured = dict(self.session)
        self._sequence += 1
        sequence = self._sequence
        def operation():
            observation = self._recorder.snapshot(captured, sequence) if self._observation_policy else foreground_observation(sequence)
            if observation is None:
                return {"session": captured}
            session = captured
            if session.get("status") == "paused" and session.get("pauseReason") == "capture_lost":
                session = self._request("command", {"sessionId": session["id"], "revision": session["revision"], "action": "resume"})["session"]
                # A resume has a new boundary; acquire it on the next recorder cycle.
                if self._observation_policy:
                    return {"session": session}
                observation = foreground_observation(1)
                if observation is None:
                    return {"session": session}
                observation["sequence"] = 1
            # Manager atomically fences a page switch and accepts this frame.
            return self._request("observation", {"sessionId": session["id"], "revision": session["revision"], "observation": observation})
        self._work(operation)

    def disconnect(self) -> None:
        self._timer.stop()
        self._recorder.stop()
        self.session = {}
        self._needs_reconnect = True

    def close(self) -> None:
        self.closed = True
        self._timer.stop()
        self._recorder.stop()
        # Manager's bounded liveness lease pauses an interrupted producer.
