import importlib.util
from pathlib import Path
import tempfile
import unittest
import os
import shutil
import subprocess
import sys
import json
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ensure_dependencies", Path(__file__).with_name("ensure_dependencies.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DependencyPreparationTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows runtime invocation")
    def test_start_preserves_configured_whisper_directory(self):
        with tempfile.TemporaryDirectory(prefix="rabi start space ") as directory:
            root = Path(directory)
            scripts = root / "scripts"; scripts.mkdir()
            shutil.copyfile(Path(__file__).with_name("start.ps1"), scripts / "start.ps1")
            dependencies = root / "deps"; dependencies.mkdir()
            selected = root / "selected model cache"
            config = root / "config.json"
            config.write_text(json.dumps({"providers": {"asr": {"faster_whisper": {"model_root": str(selected)}}}}))
            (scripts / "windows_host.py").write_text(
                "import os\nfrom pathlib import Path\n"
                "Path(os.environ['RABISPEECH_DATA_ROOT'], 'selected.txt').write_text(os.environ['RABISPEECH_WHISPER_MODEL_ROOT'])\n"
            )
            environment = {key: value for key, value in os.environ.items()
                           if not key.startswith("RABISPEECH_")}
            environment.update(RABISPEECH_CONFIG=str(config), RABISPEECH_DEPS_ROOT=str(dependencies))
            result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                                     "-File", str(scripts / "start.ps1"), "-Python", sys.executable],
                                    env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(Path((root / "selected.txt").read_text()), selected)

    @unittest.skipUnless(os.name == "nt", "Windows installer invocation")
    def test_installer_accepts_an_executable_path_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix="rabi installer space ") as directory:
            root = Path(directory)
            scripts = root / "scripts"; scripts.mkdir()
            shutil.copyfile(Path(__file__).with_name("install.ps1"), scripts / "install.ps1")
            executable = root / "Python executable.exe"
            shutil.copyfile(sys.executable, executable)
            (scripts / "ensure_dependencies.py").write_text(
                "import sys\nfrom pathlib import Path\n"
                "assert '--target' in sys.argv and '--requirements' in sys.argv\n"
                "Path(sys.argv[sys.argv.index('--target')+1], 'invoked.txt').write_text(sys.executable)\n"
            )
            environment = dict(os.environ, PYTHONHOME=sys.base_prefix,
                               PATH=sys.base_prefix + os.pathsep + os.environ.get("PATH", ""))
            environment["PSModulePath"] = str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/Modules")
            target = root / "dependency target"
            result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                                     "-File", str(scripts / "install.ps1"), "-Python", str(executable),
                                     "-DependencyRoot", str(target), "-EnsureMissing", "-SkipHostBuild"],
                                    env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(Path((target / "invoked.txt").read_text()), executable)

    def test_target_only_versions_and_missing_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            requirements = module.required_packages("scipy>=1.10,<2\nnumpy>=1.24,<2\n")
            # Global Python installations never count as private-target evidence.
            self.assertEqual(len(module.missing_requirements(requirements, target)), 2)
            for name, version in [("scipy", "1.15.3"), ("numpy", "2.2.6")]:
                metadata = target / f"{name}-{version}.dist-info"
                metadata.mkdir()
                (metadata / "METADATA").write_text(f"Name: {name}\nVersion: {version}\n")
            self.assertEqual(len(module.missing_requirements(requirements, target)), 2)
            (target / "scipy").mkdir(); (target / "scipy" / "__init__.py").touch()
            self.assertEqual(module.missing_requirements(requirements, target), ["numpy<2,>=1.24"])

    def test_failed_install_never_leaves_a_ready_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "deps"
            target.mkdir()
            receipt = target / ".runtime-requirements.sha256"
            receipt.write_text("old-success")
            requirements = Path(directory) / "requirements.txt"
            requirements.write_text("scipy>=1.10,<2\n")
            with patch.object(module.subprocess, "run", side_effect=RuntimeError("offline")):
                with self.assertRaisesRegex(RuntimeError, "offline"):
                    module.reconcile(requirements, target)
            self.assertFalse(receipt.exists())

    def test_platform_markers_do_not_install_other_platform_packages(self):
        with tempfile.TemporaryDirectory() as directory:
            requirements = module.required_packages('irrelevant==1; platform_system == "UnrealPlatform"\n')
            self.assertEqual(module.missing_requirements(requirements, Path(directory)), [])


if __name__ == "__main__":
    unittest.main()
