from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ContextEntry:
    title: str
    detail: str = ""
    source: str = ""
    path: Path | None = None


@dataclass(frozen=True)
class RoleContextSnapshot:
    role_dir: Path
    route_dir: Path
    current_notes: list[ContextEntry]
    short_memory: list[ContextEntry]
    long_memory: list[ContextEntry]
    status_lines: list[str]
    message: str = ""


class RoleContextRepository:
    def __init__(self, project_root: Path) -> None:
        self.project_root = project_root

    def load(self, role_dir: Path, route_dir: Path) -> RoleContextSnapshot:
        resolved_route_dir = self._resolve_route_dir(route_dir)
        current_notes = self._load_current_notes(resolved_route_dir)
        short_memory = self._load_short_memory(role_dir)
        long_memory = self._load_long_memory(role_dir, resolved_route_dir)
        status_lines = self._load_status_lines(role_dir, resolved_route_dir)
        message = ""
        if not current_notes and not short_memory and not long_memory:
            message = "还没有找到可读取的人格上下文文件。"
        return RoleContextSnapshot(
            role_dir=role_dir,
            route_dir=resolved_route_dir,
            current_notes=current_notes,
            short_memory=short_memory,
            long_memory=long_memory,
            status_lines=status_lines,
            message=message,
        )

    def _resolve_route_dir(self, route_dir: Path) -> Path:
        if (route_dir / "gateway-status.json").exists() or (route_dir / "codex-state.json").exists():
            return route_dir
        default_main = self.project_root / "data" / "route" / "default-main"
        if default_main.exists():
            return default_main
        return route_dir

    def _load_current_notes(self, route_dir: Path) -> list[ContextEntry]:
        state = self._read_json(route_dir / "codex-state.json")
        notes = state.get("todoNotes", []) if isinstance(state, dict) else []
        entries: list[ContextEntry] = []
        note_items = notes if isinstance(notes, list) else []
        for note in note_items:
            if not isinstance(note, dict):
                continue
            title = str(note.get("title") or note.get("summary") or note.get("id") or "Runtime note")
            detail_parts = [
                self._kv("Status", note.get("status")),
                self._kv("Priority", note.get("priority")),
                str(note.get("note") or ""),
            ]
            entries.append(
                ContextEntry(
                    title=title,
                    detail="\n".join(part for part in detail_parts if part),
                    source="route codex-state todoNotes（运行态补充）",
                    path=route_dir / "codex-state.json",
                )
            )
        return entries

    def _load_short_memory(self, role_dir: Path) -> list[ContextEntry]:
        sources = [
            ("private-messages.jsonl", "私聊消息"),
            ("group-messages.jsonl", "群聊消息"),
            ("voice-transcripts.jsonl", "语音转写"),
            ("heartbeat-events.jsonl", "心跳事件"),
        ]
        entries: list[ContextEntry] = []
        for file_name, label in sources:
            path = role_dir / file_name
            for item in self._read_jsonl_tail(path, 2):
                title = str(item.get("rawMessage") or item.get("text") or item.get("message") or item.get("summary") or label)
                sender = str(item.get("senderName") or item.get("source") or "")
                detail = self._kv("发送者", sender)
                entries.append(ContextEntry(title=self._compact(title), detail=detail, source=label, path=path))
        return entries[:8]

    def _load_long_memory(self, role_dir: Path, route_dir: Path) -> list[ContextEntry]:
        entries: list[ContextEntry] = []
        state = self._read_json(route_dir / "codex-state.json")
        notes = state.get("longTermContextNotes", []) if isinstance(state, dict) else []
        note_items = notes if isinstance(notes, list) else []
        for note in note_items:
            if isinstance(note, str):
                entries.append(ContextEntry(title=self._compact(note, 120), source="长期上下文备注", path=route_dir / "codex-state.json"))
            elif isinstance(note, dict):
                entries.append(
                    ContextEntry(
                        title=str(note.get("id") or "长期备注"),
                        detail=str(note.get("note") or ""),
                        source="长期上下文备注",
                        path=route_dir / "codex-state.json",
                    )
                )
        if entries:
            return entries[:8]

        for file_name in ("growth.md", "skills.md", "persona.md"):
            path = role_dir / file_name
            summary = self._markdown_summary(path)
            if summary:
                entries.append(ContextEntry(title=file_name, detail=summary, source="人格 Markdown", path=path))
        return entries

    def _load_status_lines(self, role_dir: Path, route_dir: Path) -> list[str]:
        lines: list[str] = []
        gateway_status = self._read_json(route_dir / "gateway-status.json")
        if isinstance(gateway_status, dict):
            adapters = gateway_status.get("messageAdapters")
            if isinstance(adapters, dict):
                for name, adapter in adapters.items():
                    if isinstance(adapter, dict):
                        lines.append(f"{name}：{adapter.get('status', 'unknown')}")
            napcat = gateway_status.get("napcat")
            if isinstance(napcat, dict):
                lines.append(f"NapCat 已连接：{bool(napcat.get('connected'))}")
                if napcat.get("lastMessageAt"):
                    lines.append(f"NapCat 最近消息：{napcat.get('lastMessageAt')}")
            heartbeat = gateway_status.get("heartbeat")
            if isinstance(heartbeat, dict):
                lines.append(f"心跳次数：{heartbeat.get('tickCount', 0)}")

        role_state = self._read_json(role_dir / "codex-state.json")
        if isinstance(role_state, dict):
            voice_state = role_state.get("voiceReplyState")
            if isinstance(voice_state, dict):
                lines.append(f"语音回复模式：{voice_state.get('mode', 'unknown')}")
            audience_state = role_state.get("audienceState")
            if isinstance(audience_state, dict):
                lines.append(f"听众状态：{audience_state.get('mode', 'unknown')}")
        return lines

    def _read_json(self, path: Path) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _read_jsonl_tail(self, path: Path, limit: int) -> list[dict[str, Any]]:
        try:
            with path.open("r", encoding="utf-8") as handle:
                lines = deque(handle, maxlen=limit)
        except OSError:
            return []
        items: list[dict[str, Any]] = []
        for line in lines:
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(data, dict):
                items.append(data)
        return items

    def _markdown_summary(self, path: Path) -> str:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return ""
        kept = [line.strip() for line in lines if line.strip() and not line.startswith("#")]
        return "\n".join(kept[:4])

    def _compact(self, text: str, limit: int = 100) -> str:
        normalized = " ".join(text.split())
        if len(normalized) <= limit:
            return normalized
        return f"{normalized[: limit - 3]}..."

    def _kv(self, label: str, value: Any) -> str:
        return f"{label}: {value}" if value not in (None, "") else ""
