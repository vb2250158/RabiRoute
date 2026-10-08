from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "windows_host.py"
SPEC = importlib.util.spec_from_file_location("rabispeech_windows_host", SCRIPT)
assert SPEC and SPEC.loader
WINDOWS_HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WINDOWS_HOST)


def test_frozen_windows_host_resolves_service_root_above_runtime(tmp_path: Path) -> None:
    executable = tmp_path / "rabi-speech" / "runtime" / "RabiSpeech.exe"

    resolved = WINDOWS_HOST.resolve_service_root(
        executable=executable,
        environment={},
        frozen=True,
    )

    assert resolved == (tmp_path / "rabi-speech").resolve()


def test_explicit_runtime_root_remains_authoritative(tmp_path: Path) -> None:
    configured = tmp_path / "configured-root"

    resolved = WINDOWS_HOST.resolve_service_root(
        executable=tmp_path / "runtime" / "RabiSpeech.exe",
        environment={"RABISPEECH_ROOT": str(configured)},
        frozen=True,
    )

    assert resolved == configured.resolve()


def test_runtime_configuration_uses_external_source_and_dependencies(tmp_path: Path) -> None:
    root = tmp_path / "rabi-speech"
    dependencies = root / ".deps"
    nvidia_bin = dependencies / "nvidia" / "cudnn" / "bin"
    nvidia_bin.mkdir(parents=True)
    (root / "config.example.json").write_text('{"server": {}}\n', encoding="utf-8")
    environment = {"PATH": "system-path", "PYTHONPATH": "existing-path"}
    module_paths: list[str] = []

    result = WINDOWS_HOST.configure_runtime(
        root,
        environment=environment,
        module_paths=module_paths,
    )

    assert Path(result["service_root"]) == root.resolve()
    assert Path(result["dependencies"]) == dependencies.resolve()
    assert Path(result["config"]).read_text(encoding="utf-8") == '{"server": {}}\n'
    assert module_paths[:2] == [str(dependencies.resolve()), str(root.resolve())]
    assert environment["RABISPEECH_ROOT"] == str(root.resolve())
    assert environment["RABISPEECH_CONFIG"] == str((root / "config.json").resolve())
    assert environment["PYTHONPATH"].split(";") == [
        str(dependencies.resolve()),
        str(root.resolve()),
        "existing-path",
    ]
    assert environment["PATH"].split(";")[:2] == [str(nvidia_bin.resolve()), "system-path"]


def test_runtime_configuration_defaults_to_local_app_data_and_migrates_legacy_config(tmp_path: Path) -> None:
    root = tmp_path / "rabi-speech"
    (root / ".deps").mkdir(parents=True)
    (root / "config.json").write_text('{"server": {"port": 8781}}\n', encoding="utf-8")
    local_app_data = tmp_path / "local-app-data"
    environment = {"LOCALAPPDATA": str(local_app_data)}

    result = WINDOWS_HOST.configure_runtime(root, environment=environment, module_paths=[])

    expected = local_app_data / "RabiPC" / "RabiSpeech" / "config.json"
    assert Path(result["config"]) == expected.resolve()
    assert expected.read_text(encoding="utf-8") == '{"server": {"port": 8781}}\n'
    assert environment["RABISPEECH_DATA_ROOT"] == str(expected.parent.resolve())
    assert environment["RABISPEECH_CONFIG"] == str(expected.resolve())


def test_start_script_prefers_built_windows_host() -> None:
    source = (SCRIPT.parent / "start.ps1").read_text(encoding="utf-8")

    assert 'runtime\\RabiSpeech.exe' in source
    assert "-not $Reload" in source
    assert '& $hostExe' in source
    assert '& $pythonExe @prefixArgs @hostArgs' in source
    assert 'RabiPC\\RabiSpeech' in source
    assert 'RABISPEECH_MODEL_ROOT' in source


def test_missing_host_build_tool_probe_is_quiet_and_allows_installation() -> None:
    source = (SCRIPT.parent / "build-windows-host.ps1").read_text(encoding="utf-8")
    probe = re.search(r'& \$pythonExe @prefixArgs -c "([^"]+find_spec[^\"]+)"', source)
    assert probe is not None
    code = probe.group(1).replace("'PyInstaller'", "'rabispeech_missing_build_tool_test'")
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 1
    assert result.stderr == ""
    assert result.stdout == ""


def powershell() -> str:
    executable = shutil.which("powershell.exe") or shutil.which("pwsh")
    if executable is None:
        pytest.skip("PowerShell is required for the Windows installation contract")
    return executable


def powershell_literal(value: Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def fake_python(path: Path, receipt: Path) -> None:
    path.write_text(
        "[pscustomobject]@{argv=@($args); python_path=[string]$env:PYTHONPATH; "
        "dependencies=[string]$env:RABISPEECH_DEPS_ROOT} | ConvertTo-Json -Depth 4 | "
        f"Set-Content -LiteralPath {powershell_literal(receipt)} -Encoding UTF8\n"
        "$global:LASTEXITCODE = 0\n",
        encoding="utf-8",
    )


def run_powershell(script: Path, args: list[str], environment: dict[str, str]) -> None:
    result = subprocess.run(
        [powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script), *args],
        cwd=script.parent.parent,
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("external_dependencies", [False, True])
def test_installer_writes_requested_dependencies_and_passes_them_to_host_builder(
    tmp_path: Path, external_dependencies: bool
) -> None:
    root = tmp_path / "current-package" / "rabi-speech"
    scripts = root / "scripts"
    scripts.mkdir(parents=True)
    installer = scripts / "install.ps1"
    installer.write_text((SCRIPT.parent / installer.name).read_text(encoding="utf-8"), encoding="utf-8")
    (root / "requirements.txt").write_text("# fixture\n", encoding="utf-8")
    pip_receipt = tmp_path / "pip.json"
    build_receipt = tmp_path / "build.json"
    python = tmp_path / "fake_python.ps1"
    fake_python(python, pip_receipt)
    (scripts / "build-windows-host.ps1").write_text(
        "[pscustomobject]@{dependencies=[string]$env:RABISPEECH_DEPS_ROOT} | ConvertTo-Json | "
        f"Set-Content -LiteralPath {powershell_literal(build_receipt)} -Encoding UTF8\n"
        "$global:LASTEXITCODE = 0\n",
        encoding="utf-8",
    )
    dependencies = tmp_path / "state" / "core-deps" if external_dependencies else root / ".deps"
    args = ["-Python", str(python)]
    if external_dependencies:
        args += ["-DependencyRoot", str(dependencies)]
    environment = os.environ.copy()
    environment["OS"] = "Windows_NT"
    environment.pop("RABISPEECH_DEPS_ROOT", None)
    run_powershell(installer, args, environment)
    pip = json.loads(pip_receipt.read_text(encoding="utf-8-sig"))
    build = json.loads(build_receipt.read_text(encoding="utf-8-sig"))
    assert dependencies.is_dir()
    assert Path(pip["argv"][pip["argv"].index("--target") + 1]) == dependencies
    assert Path(build["dependencies"]) == dependencies
    if external_dependencies:
        assert not (root / ".deps").exists()


@pytest.mark.parametrize("external_dependencies", [False, True])
def test_current_model_downloader_uses_effective_dependencies_with_manual_fallback(
    tmp_path: Path, external_dependencies: bool
) -> None:
    root = tmp_path / "current-package" / "rabi-speech"
    scripts = root / "scripts"
    scripts.mkdir(parents=True)
    downloader = scripts / "install_models.ps1"
    downloader.write_text((SCRIPT.parent / downloader.name).read_text(encoding="utf-8"), encoding="utf-8")
    (scripts / "install_models.py").write_text("# fixture downloader\n", encoding="utf-8")
    dependencies = tmp_path / "state" / "core-deps" if external_dependencies else root / ".deps"
    dependencies.mkdir(parents=True)
    receipt = tmp_path / "downloader.json"
    python = tmp_path / "fake_python.ps1"
    fake_python(python, receipt)
    environment = os.environ.copy()
    environment.pop("RABISPEECH_DEPS_ROOT", None)
    if external_dependencies:
        environment["RABISPEECH_DEPS_ROOT"] = str(dependencies)
    run_powershell(downloader, ["-List", "-ModelRoot", str(tmp_path / "models"), "-Python", str(python)], environment)
    result = json.loads(receipt.read_text(encoding="utf-8-sig"))
    assert Path(result["argv"][0]) == scripts / "install_models.py"
    assert result["argv"][-1] == "--list"
    assert result["python_path"].split(os.pathsep)[:2] == [str(dependencies), str(root)]
    if external_dependencies:
        assert not (root / ".deps").exists()


def test_reload_uses_uvicorn_factory_and_limits_watch_directory() -> None:
    source = SCRIPT.read_text(encoding="utf-8")

    assert '"rabispeech.app:create_app"' in source
    assert "factory=True" in source
    assert "reload=True" in source
    assert 'service_root / "rabispeech"' in source


def test_only_windows_network_error_59_is_treated_as_transient() -> None:
    network_error = OSError("network problem")
    network_error.winerror = 59
    wrapped = RuntimeError("cache root cannot be listed")
    wrapped.__cause__ = network_error

    assert WINDOWS_HOST.is_transient_network_filesystem_error(network_error)
    assert WINDOWS_HOST.is_transient_network_filesystem_error(wrapped)
    assert not WINDOWS_HOST.is_transient_network_filesystem_error(OSError("other problem"))
    assert not WINDOWS_HOST.is_transient_network_filesystem_error(RuntimeError("ordinary failure"))


def test_versioned_code_reuses_stable_dependencies_without_writing_version(tmp_path: Path) -> None:
    root = tmp_path / "versions" / "candidate" / "rabi-speech"
    root.mkdir(parents=True)
    deps = tmp_path / "shared-deps"
    deps.mkdir()
    config = tmp_path / "state" / "config.json"
    config.parent.mkdir()
    config.write_text("{}", encoding="utf-8")
    result = WINDOWS_HOST.configure_runtime(root, environment={"RABISPEECH_DEPS_ROOT": str(deps), "RABISPEECH_CONFIG": str(config)}, module_paths=[])
    assert Path(result["dependencies"]) == deps.resolve()
    assert Path(result["service_root"]) == root.resolve()
    assert list(root.iterdir()) == []
