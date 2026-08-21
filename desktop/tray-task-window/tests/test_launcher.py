from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


TRAY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAY_ROOT))
SPEC = importlib.util.spec_from_file_location("rabiroute_tray_launcher", TRAY_ROOT / "main.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load tray launcher module.")
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)


class LauncherNodeResolutionTest(unittest.TestCase):
    def test_packaged_tray_marks_running_before_starting_supervision(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            response = MagicMock()
            response.__enter__.return_value = response
            response.__exit__.return_value = False

            with patch.object(LAUNCHER.urllib.request, "urlopen", return_value=response) as urlopen:
                result = LAUNCHER._mark_desktop_running(project_root, "http://127.0.0.1:8790")

            self.assertTrue(result)
            request = urlopen.call_args.args[0]
            self.assertEqual(request.full_url, "http://127.0.0.1:8790/manager/desktop-lifecycle/start")
            self.assertIn(b'"source": "packaged-desktop"', request.data)

    def test_desktop_startup_removes_only_obsolete_desktop_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            legacy_names = (
                "RabiRoute-Tray.exe",
                "RabiRoute-Tray.new.exe",
                "RabiRoute-Desktop.new.exe",
            )
            for name in legacy_names:
                (project_root / name).touch()
            current_desktop = project_root / "RabiRoute-Desktop.exe"
            unrelated_file = project_root / "unrelated.exe"
            current_desktop.touch()
            unrelated_file.touch()

            removed = LAUNCHER._remove_legacy_desktop_artifacts(project_root)

            self.assertEqual(removed, legacy_names)
            self.assertTrue(current_desktop.exists())
            self.assertTrue(unrelated_file.exists())
            for name in legacy_names:
                self.assertFalse((project_root / name).exists())

    def test_trusted_desktop_extensions_require_explicit_cli_entries(self) -> None:
        source = (TRAY_ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn('"--trusted-desktop-extension"', source)
        self.assertIn('action="append"', source)
        self.assertIn("default=[]", source)
        self.assertIn("trusted_extension_entry_points=tuple(args.trusted_desktop_extension)", source)

    def test_packaged_runtime_prefers_project_portable_node_over_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            portable_node = project_root / ("node.exe" if os.name == "nt" else "node")
            portable_node.touch()
            path_node = project_root / "external-node.exe"
            path_node.touch()

            with (
                patch.dict(os.environ, {"RABIROUTE_NODE": str(path_node)}, clear=False),
                patch.object(LAUNCHER.shutil, "which", return_value=str(path_node)),
            ):
                node, source = LAUNCHER._node_executable(project_root)

            self.assertEqual(Path(node), portable_node)
            self.assertEqual(source, "project portable node")


if __name__ == "__main__":
    unittest.main()
