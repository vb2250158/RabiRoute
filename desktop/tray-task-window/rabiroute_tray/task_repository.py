from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class PlanStep:
    title: str
    status: str = "未开始"
    detail: str = ""
    completed_at: str = ""


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
    waiting_for: str = ""
    due_at: str = ""
    created_at: str = ""
    updated_at: str = ""
    steps: list[PlanStep] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
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
            waiting_for=str(item.get("waitingFor") or item.get("waiting_for") or ""),
            due_at=str(item.get("dueAt") or item.get("due_at") or ""),
            created_at=str(item.get("createdAt") or item.get("created_at") or ""),
            updated_at=str(item.get("updatedAt") or item.get("updated_at") or ""),
            steps=_normalize_plan_steps(item.get("steps")),
            keywords=_normalize_keywords(item.get("keywords")),
            path=path,
        )


def _normalize_keywords(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    keywords: list[str] = []
    for keyword in value:
        text = str(keyword).strip()
        if text:
            keywords.append(text)
    return keywords


def _normalize_plan_steps(value: Any) -> list[PlanStep]:
    if not isinstance(value, list):
        return []
    steps: list[PlanStep] = []
    for raw_step in value:
        if isinstance(raw_step, str):
            title = raw_step.strip()
            if title:
                steps.append(PlanStep(title=title))
            continue
        if not isinstance(raw_step, dict):
            continue
        title = str(raw_step.get("title") or raw_step.get("name") or raw_step.get("label") or "").strip()
        if not title:
            continue
        status = str(raw_step.get("status") or "").strip()
        if not status:
            if raw_step.get("completed") is True:
                status = "已完成"
            elif raw_step.get("current") is True:
                status = "进行中"
            else:
                status = "未开始"
        steps.append(
            PlanStep(
                title=title,
                status=status,
                detail=str(raw_step.get("detail") or raw_step.get("description") or ""),
                completed_at=str(raw_step.get("completedAt") or raw_step.get("completed_at") or ""),
            )
        )
    return steps
