from __future__ import annotations

from dataclasses import dataclass

from .manager_client import ManagerClient, ManagerSnapshot


@dataclass
class LifecycleController:
    manager: ManagerClient
    was_connected: bool = False
    quit_scheduled: bool = False

    @property
    def exit_label(self) -> str:
        return "退出 RabiRoute"

    def observe(self, snapshot: ManagerSnapshot) -> bool:
        if snapshot.connected:
            self.was_connected = True
            return False
        if self.was_connected and not self.quit_scheduled:
            self.quit_scheduled = True
            return True
        return False

    def request_exit(self) -> bool:
        return self.manager.shutdown()
