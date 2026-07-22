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


def test_start_script_prefers_built_windows_host() -> None:
    source = (SCRIPT.parent / "start.ps1").read_text(encoding="utf-8")

    assert 'runtime\\RabiSpeech.exe' in source
    assert '& $hostExe' in source
    assert '& $pythonExe @prefixArgs $hostScript' in source
