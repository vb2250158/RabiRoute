from __future__ import annotations

from pathlib import Path
from typing import Any


def role_id_from_gateway(gateway: dict[str, Any] | None, fallback: str = "Rabi") -> str:
    if not gateway:
        return fallback
    return str(gateway.get("agentRoleId") or fallback)


def role_dir_from_gateway(project_root: Path, gateway: dict[str, Any] | None, role_id: str) -> Path:
    if not gateway:
        return project_root / "data" / "roles" / role_id
    role_info = gateway.get("roleInfo") if isinstance(gateway.get("roleInfo"), dict) else {}
    selected = role_info.get("selectedRoleDataDir")
    if selected:
        return Path(str(selected))
    roles_dir = Path(str(gateway.get("rolesDir") or project_root / "data" / "roles"))
    if not roles_dir.is_absolute():
        roles_dir = project_root / roles_dir
    return roles_dir / role_id


def project_dir_from_gateway(project_root: Path, gateway: dict[str, Any] | None) -> Path:
    if gateway and gateway.get("codexCwd"):
        return Path(str(gateway["codexCwd"]))
    return project_root


def runtime_dir_from_gateway(project_root: Path, gateway: dict[str, Any] | None) -> Path:
    if gateway and gateway.get("dataDir"):
        data_dir = Path(str(gateway["dataDir"]))
        return data_dir if data_dir.is_absolute() else project_root / data_dir
    if gateway and gateway.get("routeDir"):
        route_dir = Path(str(gateway["routeDir"]))
        return route_dir if route_dir.is_absolute() else project_root / route_dir
    default_main = project_root / "data" / "route" / "default-main"
    if default_main.exists():
        return default_main
    return project_root / "data" / "route"
