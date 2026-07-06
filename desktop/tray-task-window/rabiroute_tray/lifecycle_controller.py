from __future__ import annotations

from dataclasses import dataclass

from .manager_client import ManagerClient, ManagerSnapshot


@dataclass
class LifecycleController:
    manager: ManagerClient
    was_connected: bool = False
    quit_scheduled: bool = False
    consecutive_disconnects: int = 0
    disconnects_before_quit: int = 3

    @property
    def exit_label(self) -> str:
        return "退出 RabiRoute"

    def observe(self, snapshot: ManagerSnapshot) -> bool:
        if snapshot.connected:
            self.was_connected = True
            self.consecutive_disconnects = 0
            return False
        if self.was_connected:
            self.consecutive_disconnects += 1
        if (
            self.was_connected
            and self.consecutive_disconnects >= self.disconnects_before_quit
            and not self.quit_scheduled
        ):
            self.quit_scheduled = True
            return True
        return False

    def request_exit(self) -> bool:
        return self.manager.shutdown()
