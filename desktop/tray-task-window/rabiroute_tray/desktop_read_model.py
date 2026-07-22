from __future__ import annotations

from pathlib import Path
from typing import Any

from .app_paths import role_dir_from_gateway, runtime_dir_from_gateway
from .role_context_repository import ContextEntry, RoleContextSnapshot
from .task_repository import PlanItem, PlanSnapshot, PlanStep


def plan_snapshot_from_manager(
    project_root: Path,
    gateway: dict | None,
    role_id: str,
    raw_plans: list[dict],
) -> PlanSnapshot:
    role_dir = role_dir_from_gateway(project_root, gateway, role_id)
    plans_dir = role_dir / "plans"
    items = [_plan_item_from_manager(item) for item in raw_plans]
    active = [item for item in items if item.status != "已归档"]
    archived = [item for item in items if item.status == "已归档"]
    current = [item for item in active if item.status == "进行中"]
    message = "" if items else "Manager 暂无可展示计划。"
    return PlanSnapshot(
        role_id=role_id,
        role_dir=role_dir,
        plans_dir=plans_dir,
        current=current,
        active=active,
        archived=archived,
        message=message,
    )


def context_snapshot_from_manager(
    project_root: Path,
    gateway: dict | None,
    role_id: str,
    raw_memory: dict,
) -> RoleContextSnapshot:
    role_dir = role_dir_from_gateway(project_root, gateway, role_id)
    route_dir = runtime_dir_from_gateway(project_root, gateway)
    recent_raw = raw_memory.get("recent") if isinstance(raw_memory.get("recent"), list) else []
    consolidated_raw = raw_memory.get("consolidated") if isinstance(raw_memory.get("consolidated"), list) else []
    recent = [_context_entry_from_manager(item, "近期记忆") for item in recent_raw if isinstance(item, dict)]
    consolidated = [
        _context_entry_from_manager(item, "沉淀记忆") for item in consolidated_raw if isinstance(item, dict)
    ]
    status_lines = [
        f"Manager Route：{str((gateway or {}).get('id') or '未选择')}",
        f"Route 已启用：{bool((gateway or {}).get('enabled'))}",
        f"Route 运行中：{bool((gateway or {}).get('running'))}",
        f"计划目录：{role_dir / 'plans'}",
        f"记忆目录：{role_dir / 'memory'}",
    ]
    message = "" if recent or consolidated else "Manager 暂无可展示记忆。"
    return RoleContextSnapshot(
        role_dir=role_dir,
        route_dir=route_dir,
        recent_memory=recent,
        consolidated_memory=consolidated,
        status_lines=status_lines,
        message=message,
    )


def empty_desktop_read_model(
    project_root: Path,
    gateway: dict | None = None,
    role_id: str = "Rabi",
) -> tuple[PlanSnapshot, RoleContextSnapshot]:
    return (
        plan_snapshot_from_manager(project_root, gateway, role_id, []),
        context_snapshot_from_manager(project_root, gateway, role_id, {}),
    )


def _plan_item_from_manager(item: dict[str, Any]) -> PlanItem:
    project = item.get("project") if isinstance(item.get("project"), dict) else {}
    source = item.get("source") if isinstance(item.get("source"), dict) else {}
    return PlanItem(
        title=str(item.get("title") or item.get("id") or "Untitled plan"),
        status=str(item.get("status") or "未开始"),
        priority=str(item.get("priority") or ""),
        kind=str(item.get("kind") or ""),
        current_step=str(item.get("currentStep") or ""),
        current_step_id=str(item.get("currentStepId") or ""),
        next_action=str(item.get("nextAction") or ""),
        project_name=str(project.get("name") or ""),
        project_path=str(project.get("path") or ""),
        source=str(source.get("summary") or source.get("kind") or ""),
        waiting_for=str(item.get("waitingFor") or ""),
        blocked_by=str(item.get("blockedBy") or ""),
        due_at=str(item.get("dueAt") or ""),
        created_at=str(item.get("createdAt") or ""),
        updated_at=str(item.get("updatedAt") or ""),
        steps=_plan_steps_from_manager(item.get("steps")),
        keywords=_keywords(item.get("keywords")),
        path=None,
    )


def _plan_steps_from_manager(value: Any) -> list[PlanStep]:
    if not isinstance(value, list):
        return []
    steps: list[PlanStep] = []
    for index, raw_step in enumerate(value, start=1):
        if not isinstance(raw_step, dict):
            continue
        title = str(raw_step.get("title") or "").strip()
        if not title:
            continue
        steps.append(
            PlanStep(
                title=title,
                status=str(raw_step.get("status") or "未开始"),
                detail=str(raw_step.get("detail") or ""),
                completed_at=str(raw_step.get("completedAt") or ""),
                step_id=str(raw_step.get("id") or f"step-{index}"),
                waiting_for=str(raw_step.get("waitingFor") or ""),
                blocked_by=str(raw_step.get("blockedBy") or ""),
            )
        )
    return steps


def _context_entry_from_manager(item: dict[str, Any], fallback_title: str) -> ContextEntry:
    source = item.get("source") if isinstance(item.get("source"), dict) else {}
    return ContextEntry(
        title=str(item.get("title") or item.get("id") or fallback_title),
        detail=str(item.get("content") or ""),
        source=str(source.get("summary") or source.get("kind") or ""),
        updated_at=str(item.get("updatedAt") or ""),
        keywords=_keywords(item.get("keywords")),
        path=None,
    )


def _keywords(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for text in (str(item).strip() for item in value) if text]
