from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .app_paths import role_id_from_gateway
from .desktop_read_model import context_snapshot_from_manager, plan_snapshot_from_manager
from .manager_client import ManagerClient, ManagerSnapshot
from .role_context_repository import RoleContextSnapshot
from .task_repository import PlanSnapshot


@dataclass(frozen=True)
class DesktopRefreshResult:
    manager: ManagerSnapshot
    selected_gateway: dict | None
    plan_snapshot: PlanSnapshot | None
    context_snapshot: RoleContextSnapshot | None
    role_messages: list[dict] | None


class DesktopRefreshService:
    """Loads the complete desktop read model without depending on Qt or UI state."""

    def __init__(
        self,
        manager: ManagerClient,
        project_root: Path,
    ) -> None:
        self.manager = manager
        self.project_root = project_root

    def load(
        self,
        previous_manager: ManagerSnapshot,
        selected_gateway_id: str,
        include_role_messages: bool,
    ) -> DesktopRefreshResult:
        try:
            incoming = self.manager.snapshot()
            manager_snapshot = retain_last_gateway_snapshot(previous_manager, incoming)
            selected_gateway = (
                gateway_by_id(manager_snapshot.gateways, selected_gateway_id)
                or manager_snapshot.selected_gateway
            )
            if selected_gateway is None:
                return DesktopRefreshResult(manager_snapshot, None, None, None, None)

            role_id = role_id_from_gateway(selected_gateway)
            try:
                raw_plans = self.manager.role_plans(role_id)
                raw_memory = self.manager.role_memory(role_id)
                role_messages = (
                    self.manager.role_panel_messages_snapshot(role_id) if include_role_messages else None
                )
            except Exception as error:
                return DesktopRefreshResult(
                    manager=_with_refresh_error(manager_snapshot, f"Manager desktop data unavailable: {error}"),
                    selected_gateway=selected_gateway,
                    plan_snapshot=None,
                    context_snapshot=None,
                    role_messages=None,
                )
            return DesktopRefreshResult(
                manager=manager_snapshot,
                selected_gateway=selected_gateway,
                plan_snapshot=plan_snapshot_from_manager(self.project_root, selected_gateway, role_id, raw_plans),
                context_snapshot=context_snapshot_from_manager(
                    self.project_root,
                    selected_gateway,
                    role_id,
                    raw_memory,
                ),
                role_messages=role_messages,
            )
        except Exception as error:
            return self.unexpected_failure(error)

    def unexpected_failure(self, error: Exception) -> DesktopRefreshResult:
        return DesktopRefreshResult(
            manager=ManagerSnapshot(
                connected=False,
                manager_url=self.manager.manager_url,
                meta={},
                gateways=[],
                error=f"unexpected desktop refresh failure: {error}",
            ),
            selected_gateway=None,
            plan_snapshot=None,
            context_snapshot=None,
            role_messages=None,
        )


def gateway_by_id(gateways: list[dict], gateway_id: str) -> dict | None:
    if not gateway_id:
        return None
    for gateway in gateways:
        if str(gateway.get("id") or "") == gateway_id:
            return gateway
    return None


def retain_last_gateway_snapshot(previous: ManagerSnapshot, incoming: ManagerSnapshot) -> ManagerSnapshot:
    if not incoming.connected or incoming.gateways or not incoming.error or not previous.gateways:
        return incoming
    return ManagerSnapshot(
        connected=True,
        manager_url=incoming.manager_url,
        meta=incoming.meta or previous.meta,
        gateways=list(previous.gateways),
        error=incoming.error,
    )


def _with_refresh_error(snapshot: ManagerSnapshot, error: str) -> ManagerSnapshot:
    combined_error = "; ".join(part for part in (snapshot.error, error) if part)
    return ManagerSnapshot(
        connected=snapshot.connected,
        manager_url=snapshot.manager_url,
        meta=snapshot.meta,
        gateways=snapshot.gateways,
        error=combined_error,
    )
