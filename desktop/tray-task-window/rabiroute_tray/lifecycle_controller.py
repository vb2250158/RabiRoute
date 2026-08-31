from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from .manager_client import ManagerSnapshot


CommandRunner = Callable[[Sequence[str]], bool]


def _run_host_command(arguments: Sequence[str]) -> bool:
    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        result = subprocess.run(
            list(arguments),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=35,
            creationflags=creationflags,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


@dataclass(frozen=True)
class LifecycleController:
    host_executable: Path
    application_generation_id: str
    command_runner: CommandRunner = _run_host_command

    @property
    def exit_label(self) -> str:
        return "退出 RabiRoute"

    def observe(self, snapshot: ManagerSnapshot) -> bool:
        # Manager reachability is presentation state. Only the Host owns child
        # recovery, so the Tray never exits or starts processes from a probe.
        _ = snapshot
        return False

    def request_exit(self) -> bool:
        return self.command_runner((
            str(self.host_executable),
            "--command",
            "quit",
            "--application-generation-id",
            self.application_generation_id,
        ))
