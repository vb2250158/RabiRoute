from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

TRAY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAY_ROOT))

from unittest.mock import patch

from rabiroute_tray.windows_app_identity import _shortcut_target, _startup_shortcut_ownership


class WindowsShortcutTargetTest(unittest.TestCase):
    def test_shortcuts_target_the_single_host_executable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_root = Path(directory)
            host = project_root / "RabiRoute-Host.exe"
            host.touch()

            target, arguments = _shortcut_target(project_root, host)

            self.assertEqual(target, host.resolve())
            self.assertEqual(arguments, "")

    def test_shortcuts_never_fall_back_to_a_tray_or_batch_entry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_root = Path(directory)
            (project_root / "Start-RabiRoute-Desktop.bat").touch()
            (project_root / "RabiRoute-Tray.exe").touch()

            with self.assertRaises(ValueError):
                _shortcut_target(project_root, project_root / "missing-host.exe")

    def test_startup_ownership_requires_exact_host_arguments_and_working_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_root = Path(directory)
            host = project_root / "RabiRouteHost.exe"
            shortcut = project_root / "RabiRoute.lnk"
            host.touch()
            shortcut.touch()
            with patch(
                "rabiroute_tray.windows_app_identity._read_windows_shortcut",
                return_value=(host, "", project_root),
            ):
                self.assertEqual(_startup_shortcut_ownership(shortcut, project_root, host), "owned")
            with patch(
                "rabiroute_tray.windows_app_identity._read_windows_shortcut",
                return_value=(host, "--legacy", project_root),
            ):
                self.assertEqual(_startup_shortcut_ownership(shortcut, project_root, host), "foreign")


if __name__ == "__main__":
    unittest.main()
