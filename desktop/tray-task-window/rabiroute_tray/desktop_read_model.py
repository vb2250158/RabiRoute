from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .app_paths import role_dir_from_gateway, runtime_dir_from_gateway
from .desktop_models import (
    ContextEntry,
    PlanApprovalCommand,
    PlanApprovalContract,
    PlanApprovalExternalChange,
    PlanApprovalFileChange,
    PlanItem,
    PlanSnapshot,
    PlanStep,
    RoleContextSnapshot,
)


HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def plan_snapshot_from_manager(
    project_root: Path,
    gateway: dict | None,
    role_id: str,
    raw_plans: list[dict],
) -> PlanSnapshot:
    role_dir = role_dir_from_gateway(project_root, gateway, role_id)
    plans_dir = role_dir / "plans"
    items = [_plan_item_from_manager(item) for item in raw_plans]
    active = [item for item in items if _plan_in_view(item, "plans")]
    archived = [item for item in items if _plan_in_view(item, "archived")]
    current = [item for item in items if _plan_in_view(item, "current")]
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
    avatar_data: bytes | None = None,
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
        avatar_data=avatar_data,
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
    presentation = item.get("presentation") if isinstance(item.get("presentation"), dict) else {}
    palette = presentation.get("palette") if isinstance(presentation.get("palette"), dict) else {}
    approval_presentation = presentation.get("approval") if isinstance(presentation.get("approval"), dict) else {}
    approval_contract = _approval_contract_from_manager(approval_presentation.get("contract"))
    approval = item.get("approval") if isinstance(item.get("approval"), dict) else {}
    latest_approval = approval.get("latest") if isinstance(approval.get("latest"), dict) else {}
    status = str(item.get("status") or "")
    return PlanItem(
        plan_id=str(item.get("id") or ""),
        title=str(item.get("title") or item.get("id") or "Untitled plan"),
        status=status,
        archive_status=str(item.get("archiveStatus") or "未归档"),
        display_status=str(presentation.get("label") or ""),
        display_status_en=str(presentation.get("labelEn") or ""),
        display_description=str(presentation.get("description") or ""),
        display_description_en=str(presentation.get("descriptionEn") or ""),
        display_tone=str(presentation.get("tone") or ""),
        display_status_level=_integer(presentation.get("statusLevel"), -1),
        display_views=_plan_views(presentation.get("views")),
        display_accent=_palette_color(palette.get("accent")),
        display_background=_palette_color(palette.get("background")),
        display_foreground=_palette_color(palette.get("foreground")),
        approval_state=str(approval_presentation.get("state") or ("ready" if approval_presentation.get("enabled") else "none")),
        approval_enabled=bool(approval_presentation.get("enabled")),
        approval_label=str(approval_presentation.get("label") or ""),
        approval_helper=str(approval_presentation.get("helper") or ""),
        approval_step_id=str(approval_presentation.get("stepId") or ""),
        approval_missing=tuple(_keywords(approval_presentation.get("missing"))),
        approval_contract=approval_contract,
        approval_count=int(approval.get("count") or 0),
        latest_approval_text=str(latest_approval.get("text") or ""),
        latest_approval_at=str(latest_approval.get("createdAt") or ""),
        latest_approval_delivery_status=str(latest_approval.get("deliveryStatus") or ""),
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


def _approval_contract_from_manager(value: Any) -> PlanApprovalContract | None:
    if not isinstance(value, dict):
        return None
    files: list[PlanApprovalFileChange] = []
    for item in value.get("files") if isinstance(value.get("files"), list) else []:
        if not isinstance(item, dict):
            continue
        files.append(PlanApprovalFileChange(
            path=str(item.get("path") or ""),
            action=str(item.get("action") or "modify"),
            change=str(item.get("change") or ""),
            destination=str(item.get("destination") or ""),
        ))
    commands: list[PlanApprovalCommand] = []
    for item in value.get("commands") if isinstance(value.get("commands"), list) else []:
        if not isinstance(item, dict):
            continue
        commands.append(PlanApprovalCommand(
            command=str(item.get("command") or ""),
            purpose=str(item.get("purpose") or ""),
            expected_effect=str(item.get("expectedEffect") or ""),
        ))
    changes: list[PlanApprovalExternalChange] = []
    for item in value.get("changes") if isinstance(value.get("changes"), list) else []:
        if not isinstance(item, dict):
            continue
        changes.append(PlanApprovalExternalChange(
            target=str(item.get("target") or ""),
            change=str(item.get("change") or ""),
            impact=str(item.get("impact") or ""),
        ))
    return PlanApprovalContract(
        request=str(value.get("request") or ""),
        reason=str(value.get("reason") or ""),
        files=files,
        commands=commands,
        changes=changes,
        validation=_keywords(value.get("validation")),
        rollback=_keywords(value.get("rollback")),
        out_of_scope=_keywords(value.get("outOfScope")),
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


def _palette_color(value: Any) -> str:
    color = str(value or "").strip()
    return color.lower() if HEX_COLOR.fullmatch(color) else ""


def _integer(value: Any, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _plan_views(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    allowed = {"current", "plans", "archived"}
    return tuple(view for view in (str(item) for item in value) if view in allowed)


def _plan_in_view(plan: PlanItem, view: str) -> bool:
    return view in plan.display_views
