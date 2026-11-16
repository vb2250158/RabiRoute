from __future__ import annotations

from pathlib import Path
import re


BUILTIN_WORKERS = frozenset({"local_tts_worker.py", "local_asr_worker.py", "local_onnx_vits_worker.py"})


def current_builtin_command(command: tuple[str, ...], service_root: Path, state_root: str) -> tuple[str, ...]:
    """Project only the Host's legacy built-in entries onto its active program.

    Model arguments, interpreter/venv, working directory and raw user config stay
    owned by the existing configuration. External workers are never relocated.
    """
    if not command or not state_root.strip() or not Path(state_root).is_absolute():
        return command
    if not re.fullmatch(r"(?:py|python(?:\d+(?:\.\d+)*)?)(?:\.exe)?", Path(command[0]).name, re.IGNORECASE):
        return command
    index = 1
    while index < len(command) and re.fullmatch(r"-3(?:\.\d+)?(?:-(?:32|64))?|-[uBEsSIO]|-OO", command[index]):
        index += 1
    if index >= len(command):
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
