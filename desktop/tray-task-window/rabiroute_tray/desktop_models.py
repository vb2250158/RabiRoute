from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class PlanStep:
    title: str
    status: str = "未开始"
    detail: str = ""
    completed_at: str = ""
    step_id: str = ""
    waiting_for: str = ""
    blocked_by: str = ""


@dataclass(frozen=True)
class PlanApprovalFileChange:
    path: str
    action: str = "modify"
    change: str = ""
    destination: str = ""


@dataclass(frozen=True)
class PlanApprovalCommand:
    command: str
    purpose: str = ""
    expected_effect: str = ""


@dataclass(frozen=True)
class PlanApprovalExternalChange:
    target: str
    change: str = ""
    impact: str = ""


@dataclass(frozen=True)
class PlanApprovalContract:
    request: str = ""
    reason: str = ""
    files: list[PlanApprovalFileChange] = field(default_factory=list)
    commands: list[PlanApprovalCommand] = field(default_factory=list)
    changes: list[PlanApprovalExternalChange] = field(default_factory=list)
    validation: list[str] = field(default_factory=list)
    rollback: list[str] = field(default_factory=list)
    out_of_scope: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class PlanItem:
    title: str
    plan_id: str = ""
    status: str = "未开始"
    display_status: str = ""
    display_tone: str = ""
    display_views: tuple[str, ...] = field(default_factory=tuple)
    display_accent: str = ""
    display_background: str = ""
    display_foreground: str = ""
    approval_state: str = "none"
    approval_enabled: bool = False
    approval_label: str = ""
    approval_helper: str = ""
    approval_step_id: str = ""
    approval_missing: tuple[str, ...] = field(default_factory=tuple)
    approval_contract: PlanApprovalContract | None = None
    approval_count: int = 0
    latest_approval_text: str = ""
    latest_approval_at: str = ""
    latest_approval_delivery_status: str = ""
    priority: str = ""
    kind: str = ""
    current_step: str = ""
    current_step_id: str = ""
    next_action: str = ""
    project_name: str = ""
    project_path: str = ""
    source: str = ""
    waiting_for: str = ""
    blocked_by: str = ""
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


@dataclass(frozen=True)
class ContextEntry:
    title: str
    detail: str = ""
    source: str = ""
    updated_at: str = ""
    keywords: list[str] = field(default_factory=list)
    path: Path | None = None


@dataclass(frozen=True)
class RoleContextSnapshot:
    role_dir: Path
    route_dir: Path
    recent_memory: list[ContextEntry]
    consolidated_memory: list[ContextEntry]
    status_lines: list[str]
    message: str = ""
    avatar_path: Path | None = None
    avatar_data: bytes | None = None
