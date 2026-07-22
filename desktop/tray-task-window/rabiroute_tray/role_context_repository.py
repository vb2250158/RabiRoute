from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


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


class RoleContextRepository:
    def __init__(self, project_root: Path) -> None:
        self.project_root = project_root

    def load(self, role_dir: Path, route_dir: Path) -> RoleContextSnapshot:
        resolved_route_dir = self._resolve_route_dir(route_dir)
        recent_memory = self._load_memory_dir(role_dir / "memory" / "recent", "近期记忆")
        consolidated_memory = self._load_memory_dir(role_dir / "memory" / "consolidated", "沉淀记忆")
        status_lines = self._load_status_lines(role_dir, resolved_route_dir)
        avatar_path = self._load_avatar_path(role_dir)
        message = "" if recent_memory or consolidated_memory else f"记忆目录还没有可展示记忆：{role_dir / 'memory'}"
        return RoleContextSnapshot(
            role_dir=role_dir,
            route_dir=resolved_route_dir,
            recent_memory=recent_memory,
            consolidated_memory=consolidated_memory,
            status_lines=status_lines,
            message=message,
            avatar_path=avatar_path,
        )

    def _load_avatar_path(self, role_dir: Path) -> Path | None:
        config = self._read_json(role_dir / "personaConfig.json")
        file_name = str(config.get("avatar") or "").strip() if isinstance(config, dict) else ""
        if not file_name or Path(file_name).name != file_name:
            return None
        if Path(file_name).suffix.lower() not in {".png", ".jpg", ".webp", ".gif"}:
            return None
        candidate = role_dir / file_name
        try:
            if candidate.resolve().parent != role_dir.resolve() or not candidate.is_file():
                return None
        except OSError:
            return None
        return candidate

    def _resolve_route_dir(self, route_dir: Path) -> Path:
        if (route_dir / "adapterConfig.json").exists() or (route_dir / "gateway-status.json").exists():
            return route_dir
        default_main = self.project_root / "data" / "route" / "default-main"
        if default_main.exists():
            return default_main
        return route_dir

    def _load_memory_dir(self, folder: Path, label: str) -> list[ContextEntry]:
        if not folder.exists():
            return []
        entries: list[ContextEntry] = []
        for file_path in sorted(folder.glob("*.json")):
            item = self._read_json(file_path)
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or item.get("id") or label)
            content = str(item.get("content") or "")
            updated_at = str(item.get("updatedAt") or "")
            source = item.get("source") if isinstance(item.get("source"), dict) else {}
            source_text = str(source.get("summary") or source.get("kind") or "")
            entries.append(
                ContextEntry(
                    title=title,
                    detail=content,
                    source=source_text,
                    updated_at=updated_at,
                    keywords=_normalize_keywords(item.get("keywords")),
                    path=file_path,
                )
            )
        return entries

    def _load_status_lines(self, role_dir: Path, route_dir: Path) -> list[str]:
        lines: list[str] = []
        gateway_status = self._read_json(route_dir / "gateway-status.json")
        if isinstance(gateway_status, dict):
            napcat = gateway_status.get("napcat")
            if isinstance(napcat, dict):
                lines.append(f"NapCat 已连接：{bool(napcat.get('connected'))}")
                if napcat.get("lastMessageAt"):
                    lines.append(f"NapCat 最近消息：{napcat.get('lastMessageAt')}")
            heartbeat = gateway_status.get("heartbeat")
            if isinstance(heartbeat, dict):
                lines.append(f"心跳次数：{heartbeat.get('tickCount', 0)}")
        lines.append(f"计划目录：{role_dir / 'plans'}")
        lines.append(f"记忆目录：{role_dir / 'memory'}")
        return lines

    def _read_json(self, path: Path) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _kv(self, label: str, value: Any) -> str:
        return f"{label}: {value}" if value not in (None, "") else ""


def _normalize_keywords(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    keywords: list[str] = []
    for keyword in value:
        text = str(keyword).strip()
        if text:
            keywords.append(text)
    return keywords
