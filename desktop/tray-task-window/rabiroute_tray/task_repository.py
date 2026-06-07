from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TaskItem:
    title: str
    status: str = "unknown"
    priority: str = ""
    task_type: str = ""
    current_step: str = ""
    next_action: str = ""
    project_name: str = ""
    project_path: str = ""
    source: str = ""
    updated_at: str = ""
    path: Path | None = None


@dataclass(frozen=True)
class TaskSnapshot:
    role_id: str
    role_dir: Path
    tasks_dir: Path
    current: list[TaskItem]
    short_term: list[TaskItem]
    long_term: list[TaskItem]
    project_linked: list[TaskItem]
    message: str = ""

    @property
    def all_tasks(self) -> list[TaskItem]:
        return [*self.current, *self.short_term, *self.long_term, *self.project_linked]


class TaskRepository:
    def __init__(self, project_root: Path, role_id: str = "Rabi") -> None:
        self.project_root = project_root
        self.role_id = role_id

    def load(self, role_dir: Path | None = None, role_id: str | None = None) -> TaskSnapshot:
        resolved_role_id = role_id or self.role_id
        resolved_role_dir = role_dir or self.project_root / "data" / "roles" / resolved_role_id
        tasks_dir = resolved_role_dir / "tasks"
        if not tasks_dir.exists():
            return TaskSnapshot(
                role_id=resolved_role_id,
                role_dir=resolved_role_dir,
                tasks_dir=tasks_dir,
                current=[],
                short_term=[],
                long_term=[],
                project_linked=[],
                message=f"任务目录还没有初始化：{tasks_dir}",
            )

        current = self._load_group(tasks_dir, "current")
        short_term = self._load_group(tasks_dir, "short-term") + self._load_items_group(tasks_dir, "short-term")
        long_term = self._load_group(tasks_dir, "long-term") + self._load_items_group(tasks_dir, "long-term")
        project_linked = self._load_group(tasks_dir, "project-linked") + self._load_items_group(tasks_dir, "project-linked")
        if not current:
            current = self._load_items_group(tasks_dir, "current")
        message = ""
        if not current and not short_term and not long_term and not project_linked:
            message = "任务目录已存在，但还没有找到正式任务 JSON。"

        return TaskSnapshot(
            role_id=resolved_role_id,
            role_dir=resolved_role_dir,
            tasks_dir=tasks_dir,
            current=current,
            short_term=short_term,
            long_term=long_term,
            project_linked=project_linked,
            message=message,
        )

    def _load_group(self, tasks_dir: Path, name: str) -> list[TaskItem]:
        group_file = tasks_dir / f"{name}.json"
        group_dir = tasks_dir / name
        if group_file.exists():
            return self._load_json_file(group_file)
        if group_dir.exists():
            items: list[TaskItem] = []
            for task_file in sorted(group_dir.glob("*.json")):
                items.extend(self._load_json_file(task_file))
            return items
        return []

    def _load_items_group(self, tasks_dir: Path, name: str) -> list[TaskItem]:
        group_dir = tasks_dir / "items" / name
        if not group_dir.exists():
            return []
        items: list[TaskItem] = []
        for task_file in sorted(group_dir.glob("*.json")):
            items.extend(self._load_json_file(task_file))
        return items

    def _load_json_file(self, path: Path) -> list[TaskItem]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []

        raw_items = data if isinstance(data, list) else data.get("tasks", [data]) if isinstance(data, dict) else []
        return [self._task_from_mapping(item, path) for item in raw_items if isinstance(item, dict)]

    def _task_from_mapping(self, item: dict[str, Any], path: Path) -> TaskItem:
        project = item.get("project") if isinstance(item.get("project"), dict) else {}
        source = item.get("source") if isinstance(item.get("source"), dict) else {}
        return TaskItem(
            title=str(item.get("title") or item.get("name") or item.get("id") or "Untitled task"),
            status=str(item.get("status") or "unknown"),
            priority=str(item.get("priority") or ""),
            task_type=str(item.get("taskType") or item.get("task_type") or ""),
            current_step=str(item.get("currentStep") or item.get("current_step") or ""),
            next_action=str(item.get("nextAction") or item.get("next_action") or item.get("nextStep") or ""),
            project_name=str(project.get("name") or item.get("projectName") or ""),
            project_path=str(project.get("path") or item.get("projectPath") or ""),
            source=str(source.get("summary") or source.get("kind") or item.get("source") or ""),
            updated_at=str(item.get("updatedAt") or item.get("updated_at") or ""),
            path=path,
        )
