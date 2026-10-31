from __future__ import annotations

from dataclasses import dataclass, field


_NEUTRAL_LINES = {
    "openers": {
        "watch": "我陪你看。",
        "play": "我在旁边陪你玩。",
        "work": "有需要可以叫我。",
    },
    "fallbacks": {
        "companionContextFailed": "陪伴资料读取失败",
        "companionProcessingFailed": "陪伴处理暂未完成",
        "managerInterrupted": "Rabi Manager 连接暂时中断",
        "actionUnavailable": "这个动作暂时不可用",
        "companionFailed": "陪伴操作未完成，请稍后重试",
        "bubbleStyleSaved": "气泡样式已保存",
        "bubbleStyleFailed": "气泡样式未保存，请稍后重试",
    },
}


@dataclass(frozen=True)
class DesktopPetDialogue:
    openers: dict[str, str] = field(default_factory=dict)
    fallbacks: dict[str, str] = field(default_factory=dict)

    def line(self, group: str, key: str) -> str:
        configured = getattr(self, group, {}).get(key)
        return configured or _NEUTRAL_LINES.get(group, {}).get(key, "")


def parse_desktop_pet_dialogue(payload: object, persona_id: str) -> DesktopPetDialogue:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict) or data.get("personaId") != persona_id:
        raise ValueError("Manager desktop pet dialogue returned a different persona.")
    dialogue = data.get("dialogue")
    if not isinstance(dialogue, dict):
        return DesktopPetDialogue()
    groups = {}
    for group in ("openers", "fallbacks"):
        rows = dialogue.get(group)
        groups[group] = {key: value.strip() for key, value in rows.items()
                         if isinstance(key, str) and isinstance(value, str) and value.strip()} if isinstance(rows, dict) else {}
    return DesktopPetDialogue(**groups)
