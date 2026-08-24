from __future__ import annotations

import importlib.util
from pathlib import Path


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
