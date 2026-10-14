from __future__ import annotations

import os
import time
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication
from PySide6.QtTest import QSignalSpy, QTest

from rabiroute_tray.desktop_pet_client import DesktopPetIdleBehavior
from rabiroute_tray.desktop_pet_idle import DesktopPetIdleScheduler


class _PredictableRandom:
    def uniform(self, start: float, _end: float) -> float:
        return start

    def choice(self, values: list[str]) -> str:
        return values[0]


class DesktopPetIdleDeferralTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self) -> None:
        self.now = [100.0]
        self.scheduler = DesktopPetIdleScheduler(
            random_source=_PredictableRandom(), clock=lambda: self.now[0])
        self.scheduler.configure(DesktopPetIdleBehavior(
            10, 20, ("idle-reading", "idle-wave"), 60, "sleep"))
        self.scheduler.set_active(True)
        self.scheduler.state_started("idle")
        self.addCleanup(self.scheduler.stop)

    def test_deferred_random_action_rearms_and_later_action_can_start(self) -> None:
        requested: list[str] = []
        blocked = [True]

        def receive(state: str) -> None:
            requested.append(state)
            if blocked[0]:
                self.scheduler.action_deferred("idle")
            else:
                self.scheduler.state_started(state)

        self.scheduler.animation_requested.connect(receive)
        self.scheduler._random_timer.stop()
        self.scheduler._request_random_animation()

        self.assertEqual(requested, ["idle-reading"])
        self.assertEqual(self.scheduler._current_state, "idle")
        self.assertTrue(self.scheduler._random_timer.isActive())
        self.assertEqual(self.scheduler._random_timer.interval(), 10000)
        blocked[0] = False
        self.scheduler._random_timer.stop()
        self.scheduler._request_random_animation()
        self.assertEqual(requested, ["idle-reading", "idle-wave"])
        self.assertEqual(self.scheduler._current_state, "idle-wave")
        self.assertFalse(self.scheduler._random_timer.isActive())

    def test_deferred_sleep_retries_without_synchronous_recursion(self) -> None:
        requested: list[str] = []

        def receive(state: str) -> None:
            requested.append(state)
            self.scheduler.action_deferred("idle")

        self.scheduler.animation_requested.connect(receive)
        self.now[0] = 161.0
        self.scheduler._sleep_timeout()

        self.assertEqual(requested, ["sleep"])
        self.assertEqual(self.scheduler._current_state, "idle")
        self.assertTrue(self.scheduler._sleep_due)
        self.assertFalse(self.scheduler._random_timer.isActive())
        self.assertTrue(self.scheduler._sleep_timer.isActive())
        self.assertEqual(self.scheduler._sleep_timer.interval(), 1000)
        self.scheduler._sleep_timeout()
        self.assertEqual(requested, ["sleep", "sleep"])
        self.assertEqual(self.scheduler._sleep_timer.interval(), 1000)

    def test_due_sleep_waits_for_busy_state_to_return_to_idle(self) -> None:
        requested: list[str] = []
        self.scheduler.animation_requested.connect(requested.append)
        self.now[0] = 161.0
        self.scheduler._sleep_timeout()
        self.scheduler.action_deferred("attention")

        self.assertTrue(self.scheduler._sleep_due)
        self.assertEqual(self.scheduler._current_state, "attention")
        self.assertFalse(self.scheduler._sleep_timer.isActive())
        self.assertFalse(self.scheduler._random_timer.isActive())
        self.scheduler.state_started("idle")
        self.assertEqual(requested, ["sleep", "sleep"])

    def test_sleep_retry_runs_through_qt_timer_after_blocker_clears(self) -> None:
        requested: list[str] = []
        blocked = [True]
        timed_out = QSignalSpy(self.scheduler._sleep_timer.timeout)

        def receive(state: str) -> None:
            requested.append(state)
            if blocked[0]:
                self.scheduler.action_deferred("idle")
            else:
                self.scheduler.state_started(state)

        self.scheduler.animation_requested.connect(receive)
        self.now[0] = 161.0
        self.scheduler._sleep_timeout()
        blocked[0] = False
        deadline = time.monotonic() + 3
        while len(requested) < 2 and time.monotonic() < deadline:
            QTest.qWait(20)

        self.assertEqual(requested, ["sleep", "sleep"])
        self.assertEqual(timed_out.count(), 1)
        self.assertEqual(self.scheduler._current_state, "sleep")
        self.assertFalse(self.scheduler._sleep_timer.isActive())

    def test_activity_cancels_sleep_retry_and_restores_random_idle(self) -> None:
        requested: list[str] = []

        def receive(state: str) -> None:
            requested.append(state)
            self.scheduler.action_deferred("idle")

        self.scheduler.animation_requested.connect(receive)
        self.now[0] = 161.0
        self.scheduler._sleep_timeout()
        self.now[0] = 170.0
        self.scheduler.note_activity()

        self.assertFalse(self.scheduler._sleep_due)
        self.assertEqual(self.scheduler._sleep_timer.interval(), 60000)
        self.assertTrue(self.scheduler._random_timer.isActive())
        self.scheduler._sleep_timeout()
        self.assertEqual(requested, ["sleep"])
        self.now[0] = 229.0
        self.scheduler._sleep_timeout()
        self.assertEqual(requested, ["sleep"])
        self.assertEqual(self.scheduler._sleep_timer.interval(), 1000)
        self.now[0] = 230.0
        self.scheduler._sleep_timeout()
        self.assertEqual(requested, ["sleep", "sleep"])

    def test_early_sleep_timeout_rechecks_inactivity_deadline(self) -> None:
        requested: list[str] = []
        self.scheduler.animation_requested.connect(requested.append)
        self.now[0] = 159.0
        self.scheduler._sleep_timeout()

        self.assertEqual(requested, [])
        self.assertEqual(self.scheduler._sleep_timer.interval(), 1000)
        self.assertFalse(self.scheduler._sleep_due)
        self.now[0] = 160.0
        self.scheduler._sleep_timeout()
        self.assertEqual(requested, ["sleep"])

    def test_inactive_deferral_and_timeout_do_not_restart_timers(self) -> None:
        requested: list[str] = []
        self.scheduler.animation_requested.connect(requested.append)
        self.scheduler._request_random_animation()
        self.scheduler.set_active(False)
        self.scheduler.action_deferred("idle")
        self.now[0] = 161.0
        self.scheduler._sleep_timeout()

        self.assertEqual(requested, ["idle-reading"])
        self.assertEqual(self.scheduler._current_state, "idle")
        self.assertFalse(self.scheduler._random_timer.isActive())
        self.assertFalse(self.scheduler._sleep_timer.isActive())

    def test_configure_replaces_deferred_sleep_retry_with_new_deadline(self) -> None:
        self.now[0] = 161.0
        self.scheduler._sleep_timeout()
        self.scheduler.action_deferred("idle")
        self.scheduler.configure(DesktopPetIdleBehavior(
            20, 30, ("idle-wave",), 600, "sleep"))

        self.assertFalse(self.scheduler._sleep_due)
        self.assertEqual(self.scheduler._sleep_timer.interval(), 539000)
        self.assertEqual(self.scheduler._random_timer.interval(), 20000)

    def test_reactivation_keeps_sleep_retry_ahead_of_random_idle(self) -> None:
        requested: list[str] = []

        def receive(state: str) -> None:
            requested.append(state)
            self.scheduler.action_deferred("idle")

        self.scheduler.animation_requested.connect(receive)
        self.scheduler.set_active(False)
        self.now[0] = 161.0
        self.scheduler.set_active(True)

        self.assertEqual(requested, ["sleep"])
        self.assertTrue(self.scheduler._sleep_due)
        self.assertEqual(self.scheduler._sleep_timer.interval(), 1000)
        self.assertFalse(self.scheduler._random_timer.isActive())

    def test_stop_and_disabled_behavior_clear_deferred_timers(self) -> None:
        self.now[0] = 161.0
        self.scheduler._sleep_timeout()
        self.scheduler.action_deferred("idle")
        self.scheduler.stop()
        self.scheduler.action_deferred("idle")
        self.assertFalse(self.scheduler._sleep_timer.isActive())
        self.assertFalse(self.scheduler._random_timer.isActive())

        self.scheduler.configure(DesktopPetIdleBehavior(0, 0, (), 0, ""))
        self.scheduler.set_active(True)
        self.assertFalse(self.scheduler._sleep_due)
        self.assertFalse(self.scheduler._sleep_timer.isActive())
        self.assertFalse(self.scheduler._random_timer.isActive())


if __name__ == "__main__":
    unittest.main()
