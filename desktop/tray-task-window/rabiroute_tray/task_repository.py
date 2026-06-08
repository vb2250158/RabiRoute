from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class PlanItem:
    title: str
    status: str = "未开始"
    priority: str = ""
    kind: str = ""
    current_step: str = ""
    next_action: str = ""
    project_name: str = ""
    project_path: str = ""
    source: str = ""
    updated_at: str = ""
    path: Path | None = None


@dataclass(frozen=True)
class PlanSnapshot:
    role_id: str
    role_dir: Path
    plans_dir: Path
    current: list[PlanItem]
    active: list[PlanItem]
    archived: list[PlanItem]
    message: str = ""

    @property
    def all_plans(self) -> list[PlanItem]:
        return [*self.active, *self.archived]


class PlanRepository:
    def __init__(self, project_root: Path, role_id: str = "Rabi") -> None:
        self.project_root = project_root
        self.role_id = role_id

    def load(self, role_dir: Path | None = None, role_id: str | None = None) -> PlanSnapshot:
        resolved_role_id = role_id or self.role_id
        resolved_role_dir = role_dir or self.project_root / "data" / "roles" / resolved_role_id
        plans_dir = resolved_role_dir / "plans"
        active = self._load_dir(plans_dir / "items" / "active")
        archived = self._load_dir(plans_dir / "archive")
        current = [item for item in active if item.status == "进行中"]
        message = "" if active or archived else f"计划目录还没有可展示计划：{plans_dir}"

        return PlanSnapshot(
            role_id=resolved_role_id,
            role_dir=resolved_role_dir,
            plans_dir=plans_dir,
            current=current,
            active=active,
            archived=archived,
            message=message,
        )

    def _load_dir(self, folder: Path) -> list[PlanItem]:
        if not folder.exists():
            return []
        items: list[PlanItem] = []
        for plan_file in sorted(folder.glob("*.json")):
            items.extend(self._load_json_file(plan_file))
        return items

    def _load_json_file(self, path: Path) -> list[PlanItem]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []

        raw_items = data if isinstance(data, list) else data.get("plans", [data]) if isinstance(data, dict) else []
        return [self._plan_from_mapping(item, path) for item in raw_items if isinstance(item, dict)]

    def _plan_from_mapping(self, item: dict[str, Any], path: Path) -> PlanItem:
        project = item.get("project") if isinstance(item.get("project"), dict) else {}
        source = item.get("source") if isinstance(item.get("source"), dict) else {}
        return PlanItem(
            title=str(item.get("title") or item.get("name") or item.get("id") or "Untitled plan"),
            status=str(item.get("status") or "未开始"),
            priority=str(item.get("priority") or ""),
            kind=str(item.get("kind") or ""),
            current_step=str(item.get("currentStep") or item.get("current_step") or ""),
            next_action=str(item.get("nextAction") or item.get("next_action") or item.get("nextStep") or ""),
            project_name=str(project.get("name") or item.get("projectName") or ""),
            project_path=str(project.get("path") or item.get("projectPath") or ""),
            source=str(source.get("summary") or source.get("kind") or ""),
            updated_at=str(item.get("updatedAt") or item.get("updated_at") or ""),
            path=path,
        )
