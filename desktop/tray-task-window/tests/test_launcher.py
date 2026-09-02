from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


TRAY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAY_ROOT))
SPEC = importlib.util.spec_from_file_location("rabiroute_tray_launcher", TRAY_ROOT / "main.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load tray launcher module.")
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)


class LauncherContractTest(unittest.TestCase):
    def test_packaged_runtime_resolves_its_parent_as_project_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            executable = project_root / "desktop-runtime" / "RabiRoute-Tray.exe"
            executable.parent.mkdir()
            executable.touch()

            with (
                patch.object(LAUNCHER.sys, "frozen", True, create=True),
                patch.object(LAUNCHER.sys, "executable", str(executable)),
            ):
                self.assertEqual(LAUNCHER._resolve_project_root(), project_root.resolve())

    def test_unfrozen_modular_host_resolves_its_parent_as_project_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            packaged_main = project_root / "desktop-runtime" / "main.py"
            packaged_main.parent.mkdir()
            packaged_main.touch()

            with patch.object(LAUNCHER, "__file__", str(packaged_main)):
                self.assertEqual(LAUNCHER._resolve_project_root(), project_root.resolve())

    def test_host_runtime_layout_separates_package_and_state_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package_root = root / "versions" / "release-test"
            state_root = root / "install-state"
            package_root.mkdir(parents=True)
            state_root.mkdir()

            with patch.dict(
                LAUNCHER.os.environ,
                {
                    "RABIROUTE_PACKAGE_ROOT": str(package_root),
                    "RABIROUTE_STATE_ROOT": str(state_root),
                },
                clear=False,
            ):
                self.assertEqual(LAUNCHER._resolve_runtime_roots(), (package_root.resolve(), state_root.resolve()))

    def test_host_runtime_layout_rejects_a_relative_state_root(self) -> None:
        with patch.dict(
            LAUNCHER.os.environ,
            {"RABIROUTE_STATE_ROOT": "relative-state"},
            clear=False,
        ):
            with self.assertRaisesRegex(RuntimeError, "RABIROUTE_STATE_ROOT must be an absolute directory"):
                LAUNCHER._resolve_runtime_roots()

    def test_comtypes_cache_uses_the_mutable_state_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_root = Path(temp_dir)
            comtypes_package = types.ModuleType("comtypes")
            comtypes_package.__path__ = []
            comtypes_client = types.ModuleType("comtypes.client")
            comtypes_client.gen_dir = "immutable-package-cache"
            comtypes_gen = types.ModuleType("comtypes.gen")
            comtypes_gen.__path__ = ["immutable-package-gen"]
            comtypes_package.client = comtypes_client
            comtypes_package.gen = comtypes_gen

            with patch.dict(
                sys.modules,
                {
                    "comtypes": comtypes_package,
                    "comtypes.client": comtypes_client,
                    "comtypes.gen": comtypes_gen,
                },
            ):
                cache_dir = LAUNCHER._configure_comtypes_cache(state_root)

            self.assertEqual(cache_dir, state_root / "data" / ".runtime" / "desktop" / "comtypes-cache")
            self.assertEqual(comtypes_client.gen_dir, str(cache_dir))
            self.assertEqual(comtypes_gen.__path__[-1], str(cache_dir))

    def test_surface_child_requires_the_complete_host_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            host = Path(temp_dir) / "RabiRoute-Host.exe"
            host.touch()

            args = LAUNCHER.build_argument_parser().parse_args([
                "--surface-child",
                "--manager-url",
                "http://127.0.0.1:49152",
                "--application-generation-id",
                "generation-1",
                "--manager-instance-id",
                "manager-1",
                "--host-executable",
                str(host),
                "--host-lifecycle-pipe",
                "RabiRoute.Tray.generation-1.channel",
            ])

            self.assertTrue(args.surface_child)
            self.assertEqual(args.manager_url, "http://127.0.0.1:49152")
            self.assertEqual(args.application_generation_id, "generation-1")
            self.assertEqual(args.manager_instance_id, "manager-1")
            self.assertEqual(args.host_executable, host.resolve())
            self.assertEqual(args.host_lifecycle_pipe, "RabiRoute.Tray.generation-1.channel")

    def test_launcher_rejects_direct_execution_without_surface_child_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            host = Path(temp_dir) / "RabiRoute-Host.exe"
            host.touch()
            with self.assertRaises(SystemExit):
                LAUNCHER.main([
                    "--manager-url",
                    "http://127.0.0.1:49152",
                    "--application-generation-id",
                    "generation-1",
                    "--manager-instance-id",
                    "manager-1",
                    "--host-executable",
                    str(host),
                ])

    def test_launcher_rejects_non_loopback_manager_origins(self) -> None:
        parser = LAUNCHER.build_argument_parser()
        with self.assertRaises(SystemExit):
            parser.parse_args([
                "--surface-child",
                "--manager-url",
                "http://192.168.1.20:8790",
                "--application-generation-id",
                "generation-1",
                "--manager-instance-id",
                "manager-1",
                "--host-executable",
                str(Path(__file__).resolve()),
            ])

    def test_launcher_contains_no_process_or_extension_ownership_backdoors(self) -> None:
        source = (TRAY_ROOT / "main.py").read_text(encoding="utf-8")

        for forbidden in (
            "_start_manager",
            "resolve_manager_endpoint",
            "watch-rabiroute",
            "--trusted-desktop-extension",
            "--startup-status",
            "--owns-manager",
            "npm",
        ):
            self.assertNotIn(forbidden, source)

    def test_qt_dll_bootstrap_remains_supported_without_the_legacy_single_pet_flag(self) -> None:
        source = (TRAY_ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn("_configure_frozen_qt_dll_search_paths", source)
        self.assertNotIn('"--show-desktop-pet"', source)
        self.assertNotIn("show_desktop_pet=args.show_desktop_pet", source)
        self.assertIn("package_root, state_root = _resolve_runtime_roots()", source)
        self.assertIn("run(\n            package_root,\n            state_root,", source)


if __name__ == "__main__":
    unittest.main()
