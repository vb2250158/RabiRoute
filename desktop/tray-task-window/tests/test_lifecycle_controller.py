from __future__ import annotations

import unittest
from pathlib import Path

from rabiroute_tray.lifecycle_controller import LifecycleController
from rabiroute_tray.manager_client import ManagerSnapshot


class LifecycleControllerTest(unittest.TestCase):
    def test_transient_or_long_manager_disconnect_never_requests_tray_exit(self) -> None:
        lifecycle = LifecycleController(Path("C:/RabiRoute/RabiRoute-Host.exe"), "app-generation")
        connected = ManagerSnapshot(True, "http://127.0.0.1:8790", {}, [])
        disconnected = ManagerSnapshot(False, "http://127.0.0.1:8790", {}, [], "offline")

        self.assertFalse(lifecycle.observe(connected))
        for _ in range(20):
            self.assertFalse(lifecycle.observe(disconnected))

    def test_user_exit_requests_generation_fenced_host_quit(self) -> None:
        commands: list[tuple[str, ...]] = []
        lifecycle = LifecycleController(
            Path("C:/RabiRoute/RabiRoute-Host.exe"),
            "app-generation",
            command_runner=lambda command: commands.append(tuple(command)) is None,
        )

        self.assertTrue(lifecycle.request_exit())
        self.assertEqual(
            commands,
            [(
                "C:\\RabiRoute\\RabiRoute-Host.exe",
                "--command",
                "quit",
                "--application-generation-id",
                "app-generation",
            )],
        )

    def test_user_exit_keeps_surface_open_when_host_rejects_quit(self) -> None:
        lifecycle = LifecycleController(
            Path("C:/RabiRoute/RabiRoute-Host.exe"),
            "stale-generation",
            command_runner=lambda _command: False,
        )

        self.assertFalse(lifecycle.request_exit())


if __name__ == "__main__":
    unittest.main()
