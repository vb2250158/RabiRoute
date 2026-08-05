from __future__ import annotations

from dataclasses import dataclass

from .manager_client import ManagerClient, ManagerSnapshot


@dataclass
class LifecycleController:
    manager: ManagerClient

    @property
    def exit_label(self) -> str:
        return "退出 RabiRoute"

    def observe(self, snapshot: ManagerSnapshot) -> bool:
        # Manager reachability is presentation state. Process recovery belongs to
        # the desktop lifecycle supervisor, so a transient outage must never quit
        # the tray and create a split desktop state.
        _ = snapshot
        return False

    def request_exit(self) -> bool:
        return self.manager.shutdown()
