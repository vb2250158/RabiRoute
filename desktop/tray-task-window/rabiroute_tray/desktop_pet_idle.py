from __future__ import annotations

import random
import time
from collections.abc import Callable
from typing import Protocol, TypeVar

from PySide6.QtCore import QObject, QTimer, Signal

from .desktop_pet_client import DesktopPetIdleBehavior


_T = TypeVar("_T")


class _RandomSource(Protocol):
    def uniform(self, start: float, end: float) -> float: ...

    def choice(self, values: list[_T]) -> _T: ...


class DesktopPetIdleScheduler(QObject):
    """Owns idle presentation timing; the controller still owns animation state."""

    animation_requested = Signal(str)

    def __init__(
        self,
        parent: QObject | None = None,
        *,
        random_source: _RandomSource | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        super().__init__(parent)
        self._random = random_source or random.Random()
        self._clock = clock
        self._behavior = DesktopPetIdleBehavior()
        self._active = False
        self._current_state = ""
        self._last_random_state = ""
        self._last_activity_at: float | None = None
        self._sleep_due = False
        self._random_timer = QTimer(self)
        self._random_timer.setSingleShot(True)
        self._random_timer.timeout.connect(self._request_random_animation)
        self._sleep_timer = QTimer(self)
        self._sleep_timer.setSingleShot(True)
        self._sleep_timer.timeout.connect(self._request_sleep)

    def configure(self, behavior: DesktopPetIdleBehavior) -> None:
        self._random_timer.stop()
        self._sleep_timer.stop()
        self._behavior = behavior
        self._sleep_due = False
        if self._last_random_state not in behavior.random_states:
            self._last_random_state = ""
        if self._active:
            if self._last_activity_at is None:
                self._last_activity_at = self._clock()
            self._rearm_for_current_state()

    def set_active(self, active: bool) -> None:
        self._active = bool(active)
        if not self._active:
            self._random_timer.stop()
            self._sleep_timer.stop()
            return
        if self._last_activity_at is None:
            self._last_activity_at = self._clock()
        self._rearm_for_current_state()

    def note_activity(self) -> None:
        self._last_activity_at = self._clock()
        self._sleep_due = False
        if self._active:
            self._arm_sleep_timer()

    def state_requested(self, state_name: str) -> None:
        if state_name != "idle":
            self._current_state = state_name
            self._random_timer.stop()

    def state_started(self, state_name: str) -> None:
        self._current_state = state_name
        self._random_timer.stop()
        if not self._active:
            return
        if state_name == "idle":
            if self._sleep_due:
                self._request_sleep()
                return
            self._arm_random_timer()
        self._arm_sleep_timer()

    def stop(self) -> None:
        self._active = False
        self._random_timer.stop()
        self._sleep_timer.stop()

    def _rearm_for_current_state(self) -> None:
        self._arm_sleep_timer()
        if self._current_state == "idle":
            self._arm_random_timer()

    def _arm_random_timer(self) -> None:
        behavior = self._behavior
        if not behavior.random_states or behavior.random_max_seconds <= 0:
            return
        seconds = self._random.uniform(behavior.random_min_seconds, behavior.random_max_seconds)
        self._random_timer.start(max(1, round(seconds * 1000)))

    def _arm_sleep_timer(self) -> None:
        behavior = self._behavior
        if not behavior.sleep_state or behavior.sleep_after_seconds <= 0 or self._last_activity_at is None:
            self._sleep_timer.stop()
            return
        remaining = self._last_activity_at + behavior.sleep_after_seconds - self._clock()
        if remaining <= 0:
            self._sleep_timer.stop()
            self._sleep_due = True
            if self._current_state == "idle":
                self._request_sleep()
            return
        self._sleep_timer.start(max(1, min(round(remaining * 1000), 2_000_000_000)))

    def _request_random_animation(self) -> None:
        if not self._active or self._current_state != "idle":
            return
        candidates = list(self._behavior.random_states)
        if len(candidates) > 1 and self._last_random_state in candidates:
            candidates.remove(self._last_random_state)
        if not candidates:
            return
        state_name = self._random.choice(candidates)
        self._last_random_state = state_name
        self._current_state = state_name
        self.animation_requested.emit(state_name)

    def _request_sleep(self) -> None:
        state_name = self._behavior.sleep_state
        if not self._active or not state_name:
            return
        if self._current_state != "idle":
            self._sleep_due = True
            return
        self._sleep_due = False
        self._random_timer.stop()
        self._sleep_timer.stop()
        self._current_state = state_name
        self.animation_requested.emit(state_name)
