from __future__ import annotations

import unittest

from rabiroute_tray.lifecycle_controller import LifecycleController
from rabiroute_tray.manager_client import ManagerSnapshot


class _Manager:
    def shutdown(self) -> bool:
        return True


class LifecycleControllerTest(unittest.TestCase):
    def test_transient_or_long_manager_disconnect_never_requests_tray_exit(self) -> None:
        lifecycle = LifecycleController(manager=_Manager())  # type: ignore[arg-type]
        connected = ManagerSnapshot(True, "http://127.0.0.1:8790", {}, [])
        disconnected = ManagerSnapshot(False, "http://127.0.0.1:8790", {}, [], "offline")

        self.assertFalse(lifecycle.observe(connected))
        for _ in range(20):
            self.assertFalse(lifecycle.observe(disconnected))

    def test_user_exit_still_requests_manager_shutdown(self) -> None:
        lifecycle = LifecycleController(manager=_Manager())  # type: ignore[arg-type]

        self.assertTrue(lifecycle.request_exit())


if __name__ == "__main__":
    unittest.main()
