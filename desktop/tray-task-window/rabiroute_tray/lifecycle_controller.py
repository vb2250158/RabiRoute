from __future__ import annotations

from dataclasses import dataclass

from .manager_client import ManagerClient, ManagerSnapshot


@dataclass
class LifecycleController:
    manager: ManagerClient
    owns_manager: bool = False
    was_connected: bool = False
    quit_scheduled: bool = False

    @property
    def exit_label(self) -> str:
        return "退出 RabiRoute" if self.owns_manager else "退出面板"

    def observe(self, snapshot: ManagerSnapshot) -> bool:
        if snapshot.connected:
            self.was_connected = True
            return False
        if self.owns_manager and self.was_connected and not self.quit_scheduled:
            self.quit_scheduled = True
            return True
        return False

    def request_exit(self) -> bool:
        if not self.owns_manager:
            return False
        return self.manager.shutdown()
