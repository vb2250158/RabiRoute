from __future__ import annotations

import json
from pathlib import Path
import re
from shutil import which


BUILTIN_WORKERS = frozenset({"local_tts_worker.py", "local_asr_worker.py", "local_onnx_vits_worker.py"})


def _python_script_index(command: tuple[str, ...]) -> int | None:
    if not command or not re.fullmatch(r"(?:py|python(?:\d+(?:\.\d+)*)?)(?:\.exe)?", Path(command[0]).name, re.IGNORECASE):
        return None
    index = 1
    while index < len(command) and re.fullmatch(r"-3(?:\.\d+)?(?:-(?:32|64))?|-[uBEsSIO]|-OO", command[index]):
        index += 1
    return index if index < len(command) else None


def current_builtin_command(command: tuple[str, ...], service_root: Path, state_root: str) -> tuple[str, ...]:
    """Project only the Host's legacy built-in entries onto its active program.

    Model arguments, interpreter/venv, working directory and raw user config stay
    owned by the existing configuration. External workers are never relocated.
    """
    if not state_root.strip() or not Path(state_root).is_absolute():
        return command
    index = _python_script_index(command)
    if index is None:
        return command
    script = Path(command[index])
    if not script.is_absolute() or script.name not in BUILTIN_WORKERS:
        return command
    legacy = Path(state_root) / "plugin-adapters" / "rabi-speech" / "scripts" / script.name
    # Neither a same-name custom entry nor a redirected legacy script is owned
    # merely because its basename matches the built-in convention.
    expected = Path(state_root).resolve() / "plugin-adapters" / "rabi-speech" / "scripts" / script.name
    if script != legacy or script.resolve() != expected:
        return command
    current = service_root.resolve() / "scripts" / script.name
    if not current.is_file():
        raise RuntimeError(f"Current RabiSpeech built-in worker entry is missing: {script.name}")
    return (*command[:index], str(current), *command[index + 1:])


def _option(arguments: tuple[str, ...], name: str) -> tuple[str, ...]:
    values = []
    prefix = name + "="
    for index, argument in enumerate(arguments):
        if argument == name:
            values.append(arguments[index + 1] if index + 1 < len(arguments) else "")
        elif argument.startswith(prefix):
            values.append(argument[len(prefix):])
    return tuple(values)


def _managed_firered_directory(root: Path | None) -> Path | None:
    if root is None:
        return None
    root = root.resolve()
    expected = (root / "asr" / "fireredasr2-aed").resolve()
    if not expected.is_relative_to(root):
        return None
    manifest_file = (root / "install-manifest.json").resolve()
    if not manifest_file.is_relative_to(root):
        return None
    with manifest_file.open("rb") as source:
        raw = source.read(256 * 1024 + 1)
    if len(raw) > 256 * 1024:
        return None
    manifest = json.loads(raw)
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        return None
    rows = manifest.get("models")
    if not isinstance(rows, list):
        return None
    for row in rows:
        if (isinstance(row, dict) and row.get("alias") == "asr-fireredasr2-aed" and row.get("status") == "installed"
                and row.get("repository") == "FireRedTeam/FireRedASR2-AED" and isinstance(row.get("target"), str)):
            target = Path(row["target"])
            if target.is_absolute() and target.resolve() == expected:
                return expected
    return None


def discover_firered_command(
    command: tuple[str, ...], service_root: Path, working_directory: Path | None, model_root: Path | None,
) -> tuple[str, ...] | None:
    """Recognize a configured built-in worker; installer metadata never supplies executable arguments."""
    index = _python_script_index(command)
    if index is None:
        return None
    try:
        directory = working_directory or Path.cwd()
        script = Path(command[index])
        packaged = service_root.resolve() / "scripts" / "local_asr_worker.py"
        if not script.is_absolute() or script.resolve() != packaged or not packaged.is_file():
            return None
        interpreter = Path(command[0])
        if not directory.is_dir() or not (interpreter.is_file() if interpreter.is_absolute() else which(command[0])):
            return None
        arguments = command[index + 1:]
        if "--" in arguments or _option(arguments, "--engine") != ("fireredasr2-aed",):
            return None
        paths = _option(arguments, "--model")
        if paths and (len(paths) != 1 or not paths[0] or paths[0].startswith("--")):
            return None
        repository = _option(arguments, "--repository-root")
        if repository:
            if len(repository) != 1 or not repository[0] or repository[0].startswith("--"):
                return None
            module = directory / repository[0] / "fireredasr2s" / "fireredasr2"
            if not (module.with_suffix(".py").is_file() or (module / "__init__.py").is_file()):
                return None
        weights = (directory / paths[0]).resolve() if paths else _managed_firered_directory(model_root)
        if weights is None:
            return None
        for name in ("model.pth.tar", "cmvn.ark", "dict.txt", "train_bpe1000.model"):
            weight = weights / name
            if not paths and not weight.resolve().is_relative_to(weights):
                return None
            if not weight.is_file() or weight.stat().st_size == 0:
                return None
        return command if paths else (*command, "--model", str(weights))
    except (OSError, RuntimeError, ValueError):
        # An installer can be writing its manifest while the model catalog is read.
        return None
