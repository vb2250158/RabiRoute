"""Manager motion claims rendered through the existing pet window and animations."""
from __future__ import annotations

import json
import math
import time
from urllib.parse import quote
from urllib.request import Request, urlopen

from PySide6.QtCore import QObject, QPoint, QTimer, qInfo
from PySide6.QtWidgets import QApplication

from .desktop_pet_motion import corner_positions, foreground_window, logical_bounds, matches_monitor, travel_kind
from .qt_async import start_qt_task


def resolve_motion_target(target: dict, window):
    origin = QApplication.screenAt(window.frameGeometry().center()) or QApplication.primaryScreen()
    if origin is None:
        raise ValueError("No desktop screen is available.")
    screen = origin
    kind = target.get("kind")
    if kind == "position":
        destination = (target["x"], target["y"])
        screen = QApplication.screenAt(QPoint(*destination))
        if screen is None:
            raise ValueError("Position is outside the desktop screens.")
        area = screen.availableGeometry()
        destination = (max(area.left(), min(destination[0], area.left() + max(0, area.width() - window.width()))),
                       max(area.top(), min(destination[1], area.top() + max(0, area.height() - window.height()))))
    else:
        if kind == "active-window":
            native = foreground_window()
            if native is None:
                raise ValueError("No eligible active window is available.")
            screen = next((s for s in QApplication.screens() if s.name() == native.screen_name or matches_monitor(
                native.monitor_bounds, s.geometry().getRect(), s.devicePixelRatio())), None)
            if screen is None:
                raise ValueError("Active window screen is unavailable.")
            bounds = logical_bounds(native, screen.geometry().getRect())
        elif kind == "screen-corner":
            if target.get("screenName"):
                screen = next((s for s in QApplication.screens() if s.name() == target["screenName"]), None)
                if screen is None:
                    raise ValueError("Requested screen is unavailable.")
            area = screen.availableGeometry()
            bounds = (area.left(), area.top(), area.left() + area.width(), area.top() + area.height())
        else:
            raise ValueError("Unsupported target kind.")
        area = screen.availableGeometry()
        destination = corner_positions(bounds, area.getRect(), (window.width(), window.height()), (target["corner"],))[target["corner"]]
    geometry = origin.geometry()
    return destination, travel_kind(origin is screen, (window.x(), window.y()), destination,
                                     (geometry.width(), geometry.height()))


class DesktopPetAgentMotion(QObject):
    def __init__(self, controller, manager_url, events):
        super().__init__(controller)
        self.controller = controller
        self.url = f"{manager_url.rstrip('/')}/api/desktop-pet/roles/{quote(controller.persona_id, safe='')}/motion/runtime"
        self.events = events
        self.command = None
        self.destination = None
        self.kind = ""
        self.fetching = False
        self.pending = False
        self.started = False
        self.closed = False
        self.wait_started = 0.0
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.timeout.connect(self._run)
        self.events.motion_requested.connect(self._requested)
        self.events.connection_changed.connect(self._connected)
        self.controller.window.travel_result.connect(self._finished)
        self.progress_timer = QTimer(self.controller.window)
        # event-driven-allow: transport heartbeat keepalive
        # Claim liveness only while rendered position changes; never polls work.
        self.progress_timer.setInterval(5000)
        self.progress_timer.timeout.connect(self._progress)
        self.progress_position = None
        self.progress_pending = False

    def close(self):
        self.closed = True
        self.timer.stop()
        self.progress_timer.stop()
        self.events.motion_requested.disconnect(self._requested)
        self.events.connection_changed.disconnect(self._connected)
        if self.command:
            self._report("cancelled", "Desktop pet controller closed.")

    def _post(self, value):
        request = Request(self.url, data=json.dumps(value).encode("utf-8"), method="POST",
                          headers={"content-type": "application/json"})
        with urlopen(request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("code") != 0:
            raise ValueError("Manager rejected motion runtime request.")
        return payload.get("data")

    def _requested(self, payload):
        if isinstance(payload, dict) and payload.get("personaId") == self.controller.persona_id:
            self.drain()

    def _connected(self, connected):
        if connected:
            self.drain()

    def drain(self):
        if self.closed or self.command:
            return
        if self.fetching:
            self.pending = True
            return
        self.pending = False
        self.fetching = True

        def completed(_task, result):
            self.fetching = False
            if isinstance(result, dict):
                self.command = result
                self.wait_started = time.monotonic()
                if self.closed:
                    self._report("cancelled", "Desktop pet controller closed.")
                else:
                    self._run()
            elif not self.closed and (isinstance(result, Exception) or self.pending):
                self.timer.start(1000)

        start_qt_task(lambda: self._post({}), completed, on_error=lambda error: error)

    def _run(self):
        if self.closed:
            return
        if not self.command:
            self.drain()
            return
        controller, window = self.controller, self.controller.window
        if not controller.visible or controller._locked or window.pointer_engaged or controller._context_menu is not None:
            self._report("failed", "Pet is hidden, locked or under user interaction.")
            return
        # An explicit Agent move wakes sleep, while user drag/hide and an existing
        # travel retain precedence. Do not change the persistent wander setting.
        if window.travelling:
            self._report("failed", "Pet is already travelling.")
            return
        try:
            destination, kind = resolve_motion_target(self.command["target"], window)
            mode = self.command["mode"]
            kind = {"walk": "move", "teleport": "teleport"}.get(mode, kind)
            self.destination, self.kind = destination, kind
            required = ("move",) if kind == "move" else ("teleport-out", "teleport-in")
            if controller._pack is None or not all(controller._is_action_ready(state) for state in required):
                if controller._pack is not None and any(state not in controller._pack.states for state in required):
                    raise ValueError("Active pet pack does not provide the required travel animations.")
                if time.monotonic() - self.wait_started > 10:
                    raise ValueError("Travel animations are not ready.")
                self.timer.start(200)
                return
            controller._wander_timer.stop()
            controller._idle_scheduler.note_activity()
            controller._state_before_travel = "idle" if controller._requested_state == "sleep" else controller._requested_state
            if math.dist((window.x(), window.y()), destination) < 8:
                self._report("succeeded", "Already at destination.")
                controller._arm_wander()
                return
            self.started = True
            if not window.travel_to(QPoint(*destination), kind):
                raise ValueError("Desktop window refused travel.")
            self.progress_position = (window.x(), window.y())
            self.progress_timer.start()
            qInfo(f"rabiroute.desktop-pet.motion agent_motion_started requestId={self.command['requestId']} kind={kind}")
        except (ValueError, KeyError) as error:
            self._report("failed", str(error))

    def _finished(self, completed):
        if self.command and self.started:
            self._report("succeeded" if completed else "cancelled",
                         "Arrived." if completed else "Travel interrupted by desktop interaction.")

    def _progress(self):
        window = self.controller.window
        if not self.command or not self.started or not window.travelling or self.progress_pending:
            return
        position = (window.x(), window.y())
        if position == self.progress_position:
            return
        self.progress_position = position
        self.progress_pending = True
        command = self.command
        payload = {"requestId": command["requestId"], "token": command["token"],
                   "status": "running", "position": {"x": position[0], "y": position[1]}}

        def completed(_task, _result):
            self.progress_pending = False

        start_qt_task(lambda: self._post(payload), completed, on_error=lambda error: error)

    def _report(self, status, reason):
        self.progress_timer.stop()
        command = self.command
        if not command:
            return
        window = self.controller.window
        payload = {"requestId": command["requestId"], "token": command["token"], "status": status,
                   "position": {"x": window.x(), "y": window.y()}, "reason": reason, "travelKind": self.kind}
        if self.destination is not None:
            payload["destination"] = {"x": self.destination[0], "y": self.destination[1]}
        self.command = None
        self.started = False
        self.destination = None
        self.timer.stop()
        qInfo(f"rabiroute.desktop-pet.motion agent_motion_result requestId={command['requestId']} status={status}")

        def deliver():
            # Replays only the same result/token; never executes another movement.
            for attempt in range(3):
                try:
                    return self._post(payload)
                except (OSError, ValueError):
                    if attempt == 2:
                        raise
                    time.sleep(0.25 * (attempt + 1))

        start_qt_task(deliver, lambda _task, _result: None, on_error=lambda error: error)
