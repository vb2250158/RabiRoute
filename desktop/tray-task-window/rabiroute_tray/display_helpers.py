from __future__ import annotations

from pathlib import Path


def _text(value: object) -> str:
    return str(value).strip() if value is not None else ""


def _has_cjk(value: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in value)


def _first_role_route_name(gateway: dict) -> str:
    role_route_names = gateway.get("roleRouteNames")
    if not isinstance(role_route_names, dict):
        return ""
    for key in role_route_names:
        label = _text(key)
        if label:
            return label
    return ""


def _persona_title(gateway: dict) -> str:
    role_id = _text(gateway.get("agentRoleId"))
    if not role_id:
        return ""
    roles_dir = Path(_text(gateway.get("rolesDir")) or "data/roles")
    role_file = _text(gateway.get("agentRoleFile")) or "persona.md"
    persona_path = roles_dir / role_id / role_file
    if not persona_path.is_absolute():
        persona_path = Path.cwd() / persona_path
    try:
        with persona_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                title = line.strip()
                if title.startswith("# "):
                    return title[2:].strip()
                if title:
                    return ""
    except OSError:
        return ""
    return ""


def _best_role_name(profile_name: str, persona_title: str) -> str:
    if not persona_title:
        return profile_name
    if not _has_cjk(persona_title):
        return profile_name or persona_title
    if profile_name and persona_title in profile_name:
        return profile_name
    return persona_title


def route_label(gateway: dict | None) -> str:
    if not gateway:
        return "未命名航线"
    return _text(gateway.get("routeName") or gateway.get("name") or gateway.get("configName") or gateway.get("id")) or "未命名航线"


def role_id_label(gateway: dict | None, fallback: str = "未指定人格") -> str:
    if not gateway:
        return fallback
    return _text(gateway.get("agentRoleId")) or fallback


def role_label(gateway: dict | None, fallback: str = "未指定人格") -> str:
    if not gateway:
        return fallback
    profile_name = _first_role_route_name(gateway) or _text(gateway.get("configName")) or _text(gateway.get("id"))
    persona_title = _persona_title(gateway)
    best_name = _best_role_name(profile_name, persona_title)
    if best_name:
        return best_name
    return (
        _text((gateway.get("napcatInstances") or [{}])[0].get("botNickname") if isinstance(gateway.get("napcatInstances"), list) and gateway.get("napcatInstances") else "")
        or route_label(gateway)
        or role_id_label(gateway, fallback)
    )


def route_title(gateway: dict | None) -> str:
    return role_label(gateway, "未选择航线")


def route_running_label(gateway: dict | None) -> str:
    return "运行中" if gateway and gateway.get("running") else "已停止"


def route_enabled_label(gateway: dict | None) -> str:
    return "禁用" if gateway and gateway.get("enabled") is False else "启用"


def route_state(gateway: dict | None) -> str:
    if gateway and gateway.get("enabled") is False:
        return "disabled"
    if gateway and gateway.get("running"):
        return "running"
    return "stopped"


def gateway_adapter_types(gateway: dict | None) -> list[str]:
    if not gateway:
        return []
    adapters = gateway.get("messageAdapters")
    if isinstance(adapters, list) and adapters:
        return [str(adapter) for adapter in adapters if adapter and str(adapter) != "disabled"]
    adapter = str(gateway.get("messageAdapterType") or "")
    return [adapter] if adapter else []


def adapter_label(adapter_type: str) -> str:
    labels = {
        "napcat": "NapCat / OneBot",
        "heartbeat": "定时触发",
        "rolePanel": "角色面板",
        "fennenote": "FenneNote / 芬妮笔记",
        "xiaoai": "小米音箱 / 小爱",
        "webhook": "通用 Webhook",
        "disabled": "已禁用",
    }
    return labels.get(adapter_type, adapter_type)


def adapter_summary(gateway: dict | None) -> str:
    labels = [adapter_label(adapter) for adapter in gateway_adapter_types(gateway)]
    return " + ".join(labels) if labels else "未配置消息入口"


def route_subtitle(gateway: dict | None) -> str:
    if not gateway:
        return "未选择航线"
    parts = []
    route_name = route_label(gateway)
    role_name = role_label(gateway)
    role_id = role_id_label(gateway, "")
    if route_name and route_name != role_name:
        parts.append(f"路由 {route_name}")
    if role_id and role_id != role_name:
        parts.append(f"ID {role_id}")
    parts.append(adapter_summary(gateway))
    return " · ".join(parts)


def route_menu_label(gateway: dict | None) -> str:
    role_name = role_label(gateway)
    role_id = role_id_label(gateway, "")
    if role_id and role_id != role_name:
        return f"{role_name}（{role_id}）"
    return role_name


def route_status_label(gateway: dict | None) -> str:
    return f"{route_title(gateway)} / {route_subtitle(gateway)} / {route_enabled_label(gateway)} / {route_running_label(gateway)}"
