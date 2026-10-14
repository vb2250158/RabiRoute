from __future__ import annotations

import random
import time
from collections import deque
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
        self._recent_random_states: deque[str] = deque(maxlen=2)
        self._last_activity_at: float | None = None
        self._sleep_due = False
        self._random_timer = QTimer(self)
        self._random_timer.setSingleShot(True)
        self._random_timer.timeout.connect(self._request_random_animation)
        self._sleep_timer = QTimer(self)
        self._sleep_timer.setSingleShot(True)
        self._sleep_timer.timeout.connect(self._sleep_timeout)

    def configure(self, behavior: DesktopPetIdleBehavior) -> None:
        self._random_timer.stop()
        self._sleep_timer.stop()
        self._behavior = behavior
        self._sleep_due = False
        if self._last_random_state not in behavior.random_states:
            self._last_random_state = ""
        self._recent_random_states = deque(
            (state for state in self._recent_random_states if state in behavior.random_states), maxlen=2)
        if self._active:
            if self._last_activity_at is None:
                self._last_activity_at = self._clock()
            self._rearm_for_current_state()

    def set_active(self, active: bool) -> None:
        if self._active == bool(active):
            return
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
            self._rearm_for_current_state()

    def action_deferred(self, actual_state: str) -> None:
        """Restore the playing state after the controller rejects a passive action."""
        if self._behavior.sleep_state and self._current_state == self._behavior.sleep_state:
            self._sleep_due = True
        self._current_state = actual_state or self._behavior.idle_state
        self._random_timer.stop()
        self._sleep_timer.stop()
        if not self._active:
            return
        if self._sleep_due:
            if self._current_state == self._behavior.idle_state:
                # The signal is handled synchronously. Retrying on a timer avoids
                # recursively emitting while the pointer or a menu still blocks it.
                self._sleep_timer.start(1000)
            return
        self._rearm_for_current_state()

    def state_requested(self, state_name: str) -> None:
        if state_name != self._behavior.idle_state:
            self._current_state = state_name
            self._random_timer.stop()

    def state_started(self, state_name: str) -> None:
        self._current_state = state_name
        self._random_timer.stop()
        if not self._active:
            return
        if state_name == self._behavior.idle_state:
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
        if self._current_state == self._behavior.idle_state and not self._sleep_due:
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
            if self._current_state == self._behavior.idle_state:
                self._request_sleep()
            return
        self._sleep_timer.start(max(1, min(round(remaining * 1000), 2_000_000_000)))

    def _sleep_timeout(self) -> None:
        if self._active:
            # Qt timers may fire early, and activity can replace a pending retry.
            self._arm_sleep_timer()

    def _request_random_animation(self) -> None:
        if not self._active or self._current_state != self._behavior.idle_state:
            return
        candidates = list(self._behavior.random_states)
        # Prefer actions not shown recently, falling back for small action pools.
        fresh = [state for state in candidates if state not in self._recent_random_states]
        candidates = fresh or [state for state in candidates if state != self._last_random_state] or candidates
        if not candidates:
            return
        state_name = self._random.choice(candidates)
        self._last_random_state = state_name
        self._recent_random_states.append(state_name)
        self._current_state = state_name
        self.animation_requested.emit(state_name)

    def _request_sleep(self) -> None:
        state_name = self._behavior.sleep_state
        if not self._active or not state_name:
            return
        if self._current_state != self._behavior.idle_state:
            self._sleep_due = True
            return
        self._sleep_due = False
        self._random_timer.stop()
        self._sleep_timer.stop()
        self._current_state = state_name
        self.animation_requested.emit(state_name)
