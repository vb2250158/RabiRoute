from __future__ import annotations

import re
from dataclasses import dataclass
from threading import Lock


DESKTOP_HOST_CAPABILITIES = frozenset(
    {
        "desktop.command",
        "desktop.settings-section",
        "desktop.status-card",
        "desktop.tray-menu",
    }
)
SUPPORTED_DESKTOP_HANDLERS = frozenset(
    {
        "desktop.open-webgui",
        "desktop.open-settings",
    }
)
SUPPORTED_DESKTOP_STATUS_CARDS = frozenset(
    {
        ("manager.speech-status", "builtin.speech-status.v1"),
        ("manager.performance-status", "builtin.performance-status.v1"),
    }
)
SUPPORTED_DESKTOP_SETTINGS_SECTIONS = frozenset(
    {
        (
            "builtin.desktop-settings.v1",
            "desktop.settings.v1",
            "manager.desktop-settings.read",
            "manager.desktop-settings.write",
        ),
    }
)
_SYMBOL_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._:-]*$", re.IGNORECASE)


@dataclass(frozen=True)
class DesktopPluginMenuItem:
    plugin_id: str
    instance_id: str
    contribution_id: str
    command_id: str
    handler_id: str
    label: str
    order: int


@dataclass(frozen=True)
class DesktopPluginStatusCard:
    plugin_id: str
    instance_id: str
    contribution_id: str
    query_id: str
    renderer_id: str
    label: str
    order: int


@dataclass(frozen=True)
class DesktopPluginSettingsSection:
    plugin_id: str
    instance_id: str
    contribution_id: str
    renderer_id: str
    schema_id: str
    read_command_id: str
    write_command_id: str
    label: str
    order: int


@dataclass(frozen=True)
class DesktopPluginCatalog:
    schema_version: int
    plugin_revision: int
    contribution_revision: int
    menu_items: tuple[DesktopPluginMenuItem, ...]
    status_cards: tuple[DesktopPluginStatusCard, ...] = ()
    settings_sections: tuple[DesktopPluginSettingsSection, ...] = ()


@dataclass(frozen=True)
class _ContributionBase:
    plugin_id: str
    instance_id: str
    contribution_id: str
    label: str
    order: int


@dataclass(frozen=True)
class _CommandContribution:
    plugin_id: str
    instance_id: str
    command_id: str
    handler_id: str


@dataclass(frozen=True)
class _ActivePlugin:
    plugin_id: str


def empty_desktop_plugin_catalog() -> DesktopPluginCatalog:
    return DesktopPluginCatalog(
        schema_version=2,
        plugin_revision=0,
        contribution_revision=0,
        menu_items=(),
        status_cards=(),
        settings_sections=(),
    )


def _text(value: object, *, limit: int = 300) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def _symbol(value: object, *, limit: int = 300) -> str:
    symbol = _text(value, limit=limit)
    return symbol if _SYMBOL_PATTERN.fullmatch(symbol) else ""


def _revision(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _symbols(value: object) -> frozenset[str] | None:
    if value is None:
        return frozenset()
    if not isinstance(value, list):
        return None
    symbols = [_symbol(item) for item in value]
    if any(not symbol for symbol in symbols) or len(set(symbols)) != len(symbols):
        return None
    return frozenset(symbols)


def _active_plugins(rows: object) -> dict[str, _ActivePlugin] | None:
    if not isinstance(rows, list):
        return None
    plugins: dict[str, _ActivePlugin] = {}
    for row in rows:
        if not isinstance(row, dict) or row.get("status") != "active":
            continue
        instance_id = _text(row.get("instanceId"))
        plugin_id = _text(row.get("pluginId"))
        manifest = row.get("manifest")
        if not instance_id or not plugin_id or not isinstance(manifest, dict):
            continue
        if _text(manifest.get("id")) != plugin_id:
            continue
        hosts = manifest.get("hosts")
        if not isinstance(hosts, list) or "desktop" not in hosts:
            continue
        plugins[instance_id] = _ActivePlugin(plugin_id=plugin_id)
    return plugins


def _contribution_base(
    row: object,
    expected_kind: str,
    active_plugins: dict[str, _ActivePlugin],
    host_capabilities: frozenset[str],
) -> _ContributionBase | None:
    if not isinstance(row, dict) or row.get("kind") != expected_kind:
        return None
    hosts = row.get("hosts")
    if not isinstance(hosts, list) or "desktop" not in hosts:
        return None
    plugin_id = _text(row.get("pluginId"))
    instance_id = _text(row.get("instanceId"))
    owner = active_plugins.get(instance_id)
    if owner is None or owner.plugin_id != plugin_id:
        return None
    required_capabilities = _symbols(row.get("requiredCapabilities"))
    if required_capabilities is None or not required_capabilities.issubset(host_capabilities):
        return None
    contribution_id = _symbol(row.get("id"))
    surface = _symbol(row.get("surface"))
    slot = _symbol(row.get("slot"))
    label_row = row.get("label")
    label = _text(label_row.get("fallback")) if isinstance(label_row, dict) else ""
    order_value = row.get("order", 0)
    order = order_value if isinstance(order_value, int) and not isinstance(order_value, bool) else 0
    if not all((plugin_id, instance_id, contribution_id, surface, slot, label)):
        return None
    return _ContributionBase(
        plugin_id=plugin_id,
        instance_id=instance_id,
        contribution_id=contribution_id,
        label=label,
        order=order,
    )


def _command_contributions(
    rows: list[object],
    active_plugins: dict[str, _ActivePlugin],
    host_capabilities: frozenset[str],
) -> dict[tuple[str, str, str], _CommandContribution]:
    commands: dict[tuple[str, str, str], _CommandContribution] = {}
    duplicate_keys: set[tuple[str, str, str]] = set()
    for row in rows:
        base = _contribution_base(row, "command", active_plugins, host_capabilities)
        if base is None or not isinstance(row, dict):
            continue
        handler_id = _symbol(row.get("handlerId"))
        danger_level = _text(row.get("dangerLevel") or "safe", limit=40)
        if handler_id not in SUPPORTED_DESKTOP_HANDLERS or danger_level != "safe":
            continue
        key = (base.plugin_id, base.instance_id, base.contribution_id)
        if key in commands:
            duplicate_keys.add(key)
            commands.pop(key, None)
            continue
        if key not in duplicate_keys:
            commands[key] = _CommandContribution(
                plugin_id=base.plugin_id,
                instance_id=base.instance_id,
                command_id=base.contribution_id,
                handler_id=handler_id,
            )
    return commands


def _resolved_menu_items(
    rows: list[object],
    active_plugins: dict[str, _ActivePlugin],
    host_capabilities: frozenset[str],
) -> tuple[DesktopPluginMenuItem, ...]:
    commands = _command_contributions(rows, active_plugins, host_capabilities)
    resolved: list[tuple[int, int, DesktopPluginMenuItem]] = []
    seen_tray_items: set[tuple[str, str, str]] = set()
    for sequence, row in enumerate(rows):
        base = _contribution_base(row, "tray-menu", active_plugins, host_capabilities)
        if base is None or not isinstance(row, dict):
            continue
        command_id = _symbol(row.get("commandId"))
        command = commands.get((base.plugin_id, base.instance_id, command_id))
        tray_key = (base.plugin_id, base.instance_id, base.contribution_id)
        if command is None or tray_key in seen_tray_items:
            continue
        seen_tray_items.add(tray_key)
        resolved.append(
            (
                base.order,
                sequence,
                DesktopPluginMenuItem(
                    plugin_id=base.plugin_id,
                    instance_id=base.instance_id,
                    contribution_id=base.contribution_id,
                    command_id=command.command_id,
                    handler_id=command.handler_id,
                    label=base.label,
                    order=base.order,
                ),
            )
        )
    resolved.sort(key=lambda item: (item[0], item[1]))
    return tuple(item for _order, _sequence, item in resolved)


def _resolved_status_cards(
    rows: list[object],
    active_plugins: dict[str, _ActivePlugin],
    host_capabilities: frozenset[str],
) -> tuple[DesktopPluginStatusCard, ...]:
    resolved: list[tuple[int, int, DesktopPluginStatusCard]] = []
    seen: set[tuple[str, str, str]] = set()
    for sequence, row in enumerate(rows):
        base = _contribution_base(row, "status-card", active_plugins, host_capabilities)
        if base is None or not isinstance(row, dict):
            continue
        query_id = _symbol(row.get("queryId"))
        renderer_id = _symbol(row.get("rendererId"))
        key = (base.plugin_id, base.instance_id, base.contribution_id)
        if (query_id, renderer_id) not in SUPPORTED_DESKTOP_STATUS_CARDS or key in seen:
            continue
        seen.add(key)
        resolved.append(
            (
                base.order,
                sequence,
                DesktopPluginStatusCard(
                    plugin_id=base.plugin_id,
                    instance_id=base.instance_id,
                    contribution_id=base.contribution_id,
                    query_id=query_id,
                    renderer_id=renderer_id,
                    label=base.label,
                    order=base.order,
                ),
            )
        )
    resolved.sort(key=lambda item: (item[0], item[1]))
    return tuple(item for _order, _sequence, item in resolved)


def _resolved_settings_sections(
    rows: list[object],
    active_plugins: dict[str, _ActivePlugin],
    host_capabilities: frozenset[str],
) -> tuple[DesktopPluginSettingsSection, ...]:
    resolved: list[tuple[int, int, DesktopPluginSettingsSection]] = []
    seen: set[tuple[str, str, str]] = set()
    for sequence, row in enumerate(rows):
        base = _contribution_base(row, "settings-section", active_plugins, host_capabilities)
        if base is None or not isinstance(row, dict):
            continue
        renderer_id = _symbol(row.get("rendererId"))
        schema_id = _symbol(row.get("schemaId"))
        read_command_id = _symbol(row.get("readCommandId"))
        write_command_id = _symbol(row.get("writeCommandId"))
        contract = (renderer_id, schema_id, read_command_id, write_command_id)
        key = (base.plugin_id, base.instance_id, base.contribution_id)
        if contract not in SUPPORTED_DESKTOP_SETTINGS_SECTIONS or key in seen:
            continue
        seen.add(key)
        resolved.append(
            (
                base.order,
                sequence,
                DesktopPluginSettingsSection(
                    plugin_id=base.plugin_id,
                    instance_id=base.instance_id,
                    contribution_id=base.contribution_id,
                    renderer_id=renderer_id,
                    schema_id=schema_id,
                    read_command_id=read_command_id,
                    write_command_id=write_command_id,
                    label=base.label,
                    order=base.order,
                ),
            )
        )
    resolved.sort(key=lambda item: (item[0], item[1]))
    return tuple(item for _order, _sequence, item in resolved)


def parse_desktop_plugin_catalog(payload: object) -> DesktopPluginCatalog | None:
    if not isinstance(payload, dict) or payload.get("code") != 0:
        return None
    data = payload.get("data")
    if not isinstance(data, dict) or data.get("schemaVersion") != 2 or data.get("host") != "desktop":
        return None
    revisions = data.get("revision")
    if not isinstance(revisions, dict):
        return None
    plugin_revision = _revision(revisions.get("plugins"))
    contribution_revision = _revision(revisions.get("contributions"))
    rows = data.get("contributions")
    plugin_state = _active_plugins(data.get("plugins"))
    if (
        plugin_revision is None
        or contribution_revision is None
        or not isinstance(rows, list)
        or plugin_state is None
    ):
        return None
    active_plugins = plugin_state
    host_capabilities = DESKTOP_HOST_CAPABILITIES
    return DesktopPluginCatalog(
        schema_version=2,
        plugin_revision=plugin_revision,
        contribution_revision=contribution_revision,
        menu_items=_resolved_menu_items(rows, active_plugins, host_capabilities),
        status_cards=_resolved_status_cards(rows, active_plugins, host_capabilities),
        settings_sections=_resolved_settings_sections(rows, active_plugins, host_capabilities),
    )


class DesktopPluginCatalogCache:
    def __init__(self) -> None:
        self._lock = Lock()
        self._latest: DesktopPluginCatalog | None = None

    def accept_payload(self, payload: object) -> DesktopPluginCatalog:
        catalog = parse_desktop_plugin_catalog(payload)
        if catalog is None:
            return self.fallback()
        with self._lock:
            if self._latest is not None and catalog.contribution_revision < self._latest.contribution_revision:
                return self._latest
            self._latest = catalog
            return catalog

    def fallback(self) -> DesktopPluginCatalog:
        with self._lock:
            return self._latest or empty_desktop_plugin_catalog()
