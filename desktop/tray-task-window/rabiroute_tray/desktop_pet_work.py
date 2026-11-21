from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field


WORK_PHASE_ACTIONS = {
    "thinking": ("thinking",),
    "working": ("working", "thinking", "idle-reading"),
    "reviewing": ("reviewing", "idle-reading"),
    "waiting": ("waiting", "attention"),
    "completed": ("success",),
    "failed": ("concerned",),
}
WORK_TERMINAL_PHASES = frozenset({"completed", "failed"})

WORK_TEXT = {
    "thinking": "正在想下一步",
    "working": "正在用工具",
    "reviewing": "正在整理结果",
    "waiting": "在等你回复",
    "completed": "这轮忙完啦",
    "failed": "这轮遇到了问题",
}

TOOL_TEXT = {
    "editing": "正在修改文件",
    "reading": "正在查资料",
    "command": "正在运行命令",
}

_ACTIVE_TIMEOUT_SECONDS = 1800
_FINISH_DISPLAY_SECONDS = 5


@dataclass
class _WorkTurn:
    key: str
    phase: str
    deadline: float
    tools: dict[str, tuple[str, str]] = field(default_factory=dict)
    activity: str = ""

    @property
    def presentation(self) -> tuple[str, str]:
        phase, activity = next(reversed(self.tools.values())) if self.tools else (self.phase, self.activity)
        return phase, TOOL_TEXT.get(activity, WORK_TEXT[phase])


class DesktopPetWork:
    """Keeps only the work cues needed by this pet, independently of chat and speech."""

    def __init__(self) -> None:
        self._turns: OrderedDict[str, _WorkTurn] = OrderedDict()
        self._ended: OrderedDict[tuple[str, str], tuple[str, float]] = OrderedDict()
        self._finished_phase = ""
        self._finished_until = 0.0

    def _remember_end(self, session: str, turn: str, phase: str, now: float) -> None:
        key = (session, turn)
        self._ended[key] = (phase, now)
        self._ended.move_to_end(key)
        if len(self._ended) > 128:
            self._ended.popitem(last=False)

    def accept(self, event: dict, now: float) -> bool:
        session, turn, phase = (event.get(key) for key in ("sessionKey", "turnKey", "phase"))
        if phase == "detached" and isinstance(session, str):
            previous = self._turns.pop(session, None)
            if previous:
                self._remember_end(session, previous.key, "detached", now)
            return previous is not None
        if not all(isinstance(value, str) and value for value in (session, turn, phase)):
            return False
        previous = self._turns.get(session)
        ended = self._ended.get((session, turn))
        outcome_correction = phase == "failed" and ended and ended[0] in {"cleared", "completed"}
        if ended and not (outcome_correction and now - ended[1] <= _FINISH_DISPLAY_SECONDS):
            return False
        if phase in WORK_TERMINAL_PHASES or phase == "cleared":
            if (previous and previous.key != turn) or (not previous and phase == "completed"):
                return False
            self._turns.pop(session, None)
            self._remember_end(session, turn, phase, now)
            self._finished_phase = phase if phase in WORK_TERMINAL_PHASES and not self._turns else ""
            self._finished_until = now + _FINISH_DISPLAY_SECONDS if self._finished_phase else 0
            return True
        if phase not in WORK_PHASE_ACTIONS:
            return False
        if previous and previous.key != turn:
            if phase != "thinking":
                return False
            self._remember_end(session, previous.key, "superseded", now)
        if previous is None or previous.key != turn:
            previous = _WorkTurn(turn, phase, now + _ACTIVE_TIMEOUT_SECONDS)
            self._turns[session] = previous
        tool = event.get("toolKey")
        activity = event.get("activity")
        previous.phase = phase
        previous.activity = activity if isinstance(activity, str) else ""
        if event.get("clearTools") is True:
            previous.tools.clear()
        if isinstance(tool, str) and tool:
            if phase == "reviewing":
                previous.tools.pop(tool, None)
            elif phase in {"working", "waiting"}:
                previous.tools[tool] = (phase, previous.activity)
                if len(previous.tools) > 32:
                    del previous.tools[next(iter(previous.tools))]
        previous.deadline = now + _ACTIVE_TIMEOUT_SECONDS
        self._turns.move_to_end(session)
        if len(self._turns) > 64:
            expired_session, expired = self._turns.popitem(last=False)
            self._remember_end(expired_session, expired.key, "expired", now)
        self._finished_until = 0
        return True

    def current(self, now: float) -> tuple[str, str, float]:
        for session, turn in tuple(self._turns.items()):
            if turn.deadline <= now:
                self._turns.pop(session)
                self._remember_end(session, turn.key, "expired", now)
        if self._turns:
            phase, text = next(reversed(self._turns.values())).presentation
            return phase, text, min(turn.deadline for turn in self._turns.values())
        if self._finished_phase and self._finished_until > now:
            return self._finished_phase, WORK_TEXT[self._finished_phase], self._finished_until
        return "", "", 0

    def clear(self) -> None:
        self._turns.clear()
        self._ended.clear()
        self._finished_phase = ""
        self._finished_until = 0
