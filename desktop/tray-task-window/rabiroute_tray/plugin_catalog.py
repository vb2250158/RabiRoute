from __future__ import annotations

import re
from dataclasses import dataclass
from importlib import metadata
from threading import Lock
from typing import Callable, Mapping


DESKTOP_HOST_CAPABILITIES = frozenset(
    {
        "desktop.command",
        "desktop.hotkey",
        "desktop.settings-section",
        "desktop.status-card",
        "desktop.theme",
        "desktop.tray-menu",
    }
)
TRUSTED_DESKTOP_EXTENSION_ENTRY_POINT_GROUP = "rabiroute.desktop_extensions"
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
class DesktopPluginHotkey:
    plugin_id: str
    instance_id: str
    contribution_id: str
    command_id: str
    handler_id: str
    default_binding: str
    label: str
    order: int


@dataclass(frozen=True)
class DesktopPluginTheme:
    plugin_id: str
    instance_id: str
    contribution_id: str
    theme_id: str
    desktop_resource_id: str
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
    generation: str = ""
    hotkeys: tuple[DesktopPluginHotkey, ...] = ()
    themes: tuple[DesktopPluginTheme, ...] = ()
    status_cards: tuple[DesktopPluginStatusCard, ...] = ()
    settings_sections: tuple[DesktopPluginSettingsSection, ...] = ()


@dataclass(frozen=True)
class DesktopCommandContext:
    manager_url: str
    open_url: Callable[[str], None]
    services: Mapping[str, Callable[[], None]]

    def invoke_service(self, service_id: str) -> None:
        service = self.services.get(service_id)
        if service is None:
            raise LookupError(f"Desktop command service is unavailable: {service_id}")
        service()


@dataclass(frozen=True)
class DesktopThemeContext:
    application: object
    apply_builtin_theme: Callable[[object, str], str]


@dataclass(frozen=True)
class _HotkeyContract:
    binding: Callable[[DesktopPluginHotkey, object], str]
    enabled: Callable[[DesktopPluginHotkey, object], bool]


@dataclass(frozen=True)
class _StatusContract:
    query: Callable[[Callable[[str], dict]], dict]
    render: Callable[[dict], list[tuple[str, str]]]


@dataclass(frozen=True)
class _SettingsContract:
    read: Callable[[Callable[[], object]], object]
    render: Callable[[object], list[tuple[str, str]]]
    open: Callable[[str, Callable[[str], None]], None]


class DesktopExtensionRegistry:
    """Host-owned contracts and handlers for built-in and explicitly trusted extensions."""

    def __init__(self) -> None:
        self._commands: dict[str, Callable[[DesktopCommandContext], None]] = {}
        self._hotkeys: dict[tuple[str, str, str], _HotkeyContract] = {}
        self._themes: dict[tuple[str, str], Callable[[DesktopThemeContext], str]] = {}
        self._statuses: dict[tuple[str, str], _StatusContract] = {}
        self._settings: dict[tuple[str, str, str, str], _SettingsContract] = {}
        self._frozen = False

    @property
    def frozen(self) -> bool:
        return self._frozen

    def freeze(self) -> DesktopExtensionRegistry:
        self._frozen = True
        return self

    def _register(self, collection: dict, key: object, value: object) -> None:
        if self._frozen:
            raise RuntimeError("Desktop extension registry is frozen.")
        if key in collection:
            raise ValueError(f"Desktop extension contract is already registered: {key}")
        collection[key] = value

    def register_command_handler(self, handler_id: str, handler: Callable[[DesktopCommandContext], None]) -> None:
        key = _required_symbol(handler_id, "handler_id")
        if not callable(handler):
            raise TypeError("Desktop command handler must be callable.")
        self._register(self._commands, key, handler)

    def register_hotkey_contract(
        self,
        command_id: str,
        handler_id: str,
        default_binding: str,
        *,
        binding: Callable[[DesktopPluginHotkey, object], str] | None = None,
        enabled: Callable[[DesktopPluginHotkey, object], bool] | None = None,
    ) -> None:
        key = (
            _required_symbol(command_id, "command_id"),
            _required_symbol(handler_id, "handler_id"),
            _required_text(default_binding, "default_binding", limit=80),
        )
        if key[1] not in self._commands:
            raise ValueError(f"Desktop hotkey handler is not registered: {key[1]}")
        self._register(
            self._hotkeys,
            key,
            _HotkeyContract(
                binding or (lambda contribution, _settings: contribution.default_binding),
                enabled or (lambda _contribution, _settings: True),
            ),
        )

    def register_theme_resource(
        self,
        theme_id: str,
        desktop_resource_id: str,
        apply: Callable[[DesktopThemeContext], str],
    ) -> None:
        if not callable(apply):
            raise TypeError("Desktop theme resource handler must be callable.")
        key = (_required_symbol(theme_id, "theme_id"), _required_symbol(desktop_resource_id, "desktop_resource_id"))
        self._register(self._themes, key, apply)

    def register_status_contract(
        self,
        query_id: str,
        renderer_id: str,
        *,
        query: Callable[[Callable[[str], dict]], dict],
        render: Callable[[dict], list[tuple[str, str]]],
    ) -> None:
        if not callable(query) or not callable(render):
            raise TypeError("Desktop status query and renderer must be callable.")
        key = (_required_symbol(query_id, "query_id"), _required_symbol(renderer_id, "renderer_id"))
        self._register(self._statuses, key, _StatusContract(query, render))

    def register_settings_contract(
        self,
        renderer_id: str,
        schema_id: str,
        read_command_id: str,
        write_command_id: str,
        *,
        read: Callable[[Callable[[], object]], object],
        render: Callable[[object], list[tuple[str, str]]],
        open: Callable[[str, Callable[[str], None]], None],
    ) -> None:
        if not callable(read) or not callable(render) or not callable(open):
            raise TypeError("Desktop settings reader, renderer, and opener must be callable.")
        key = tuple(_required_symbol(value, name) for value, name in (
            (renderer_id, "renderer_id"),
            (schema_id, "schema_id"),
            (read_command_id, "read_command_id"),
            (write_command_id, "write_command_id"),
        ))
        self._register(self._settings, key, _SettingsContract(read, render, open))

    def has_command_handler(self, handler_id: str) -> bool:
        return handler_id in self._commands

    def has_hotkey_contract(self, item: DesktopPluginHotkey) -> bool:
        return (item.command_id, item.handler_id, item.default_binding) in self._hotkeys

    def has_theme_resource(self, theme_id: str, resource_id: str) -> bool:
        return (theme_id, resource_id) in self._themes

    def has_status_contract(self, query_id: str, renderer_id: str) -> bool:
        return (query_id, renderer_id) in self._statuses

    def has_settings_contract(self, section: DesktopPluginSettingsSection) -> bool:
        return self._settings_key(section) in self._settings

    def invoke_command(self, handler_id: str, context: DesktopCommandContext) -> None:
        handler = self._commands.get(handler_id)
        if handler is None:
            raise LookupError(f"Desktop command handler is not registered: {handler_id}")
        handler(context)

    def hotkey_binding(self, item: DesktopPluginHotkey, settings: object) -> str:
        contract = self._hotkeys.get((item.command_id, item.handler_id, item.default_binding))
        if contract is None:
            raise LookupError(f"Desktop hotkey contract is not registered: {item.contribution_id}")
        return _required_text(contract.binding(item, settings), "resolved hotkey binding", limit=80)

    def hotkey_enabled(self, item: DesktopPluginHotkey, settings: object) -> bool:
        contract = self._hotkeys.get((item.command_id, item.handler_id, item.default_binding))
        return contract is not None and contract.enabled(item, settings) is True

    def apply_theme(self, item: DesktopPluginTheme, context: DesktopThemeContext) -> str:
        apply = self._themes.get((item.theme_id, item.desktop_resource_id))
        if apply is None:
            raise LookupError(f"Desktop theme resource is not registered: {item.desktop_resource_id}")
        return apply(context)

    def apply_registered_theme(self, theme_id: str, resource_id: str, context: DesktopThemeContext) -> str:
        apply = self._themes.get((theme_id, resource_id))
        if apply is None:
            raise LookupError(f"Desktop theme resource is not registered: {resource_id}")
        return apply(context)

    def query_status(self, card: DesktopPluginStatusCard, get_json: Callable[[str], dict]) -> dict:
        contract = self._statuses.get((card.query_id, card.renderer_id))
        if contract is None:
            raise LookupError(f"Desktop status contract is not registered: {card.query_id} / {card.renderer_id}")
        return contract.query(get_json)

    def render_status(self, card: DesktopPluginStatusCard, payload: dict) -> list[tuple[str, str]]:
        contract = self._statuses.get((card.query_id, card.renderer_id))
        return contract.render(payload) if contract is not None else []

    def read_settings(self, section: DesktopPluginSettingsSection, reader: Callable[[], object]) -> object:
        contract = self._settings.get(self._settings_key(section))
        if contract is None:
            raise LookupError(f"Desktop settings contract is not registered: {section.contribution_id}")
        return contract.read(reader)

    def render_settings(self, section: DesktopPluginSettingsSection, value: object) -> list[tuple[str, str]]:
        contract = self._settings.get(self._settings_key(section))
        return contract.render(value) if contract is not None else []

    def open_settings(self, section: DesktopPluginSettingsSection, manager_url: str, open_url: Callable[[str], None]) -> None:
        contract = self._settings.get(self._settings_key(section))
        if contract is None:
            raise LookupError(f"Desktop settings contract is not registered: {section.contribution_id}")
        contract.open(manager_url, open_url)

    @staticmethod
    def _settings_key(section: DesktopPluginSettingsSection) -> tuple[str, str, str, str]:
        return section.renderer_id, section.schema_id, section.read_command_id, section.write_command_id


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
        generation="",
        hotkeys=(),
        themes=(),
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


def _required_text(value: object, name: str, *, limit: int = 300) -> str:
    text = _text(value, limit=limit)
    if not text:
        raise ValueError(f"Desktop extension {name} must be a non-empty string.")
    return text


def _required_symbol(value: object, name: str) -> str:
    symbol = _symbol(value)
    if not symbol:
        raise ValueError(f"Desktop extension {name} is invalid: {value!r}")
    return symbol


def _status_data(payload: dict) -> dict:
    data = payload.get("data")
    return data if isinstance(data, dict) else {}


def _render_speech_status(payload: dict) -> list[tuple[str, str]]:
    row = _status_data(payload)
    fields = [
        ("状态", str(row.get("state") or "未知")),
        ("服务", str(row.get("service") or "RabiSpeech")),
        ("地址", str(row.get("configuredUrl") or "未配置")),
    ]
    if row.get("latencyMs") is not None:
        fields.append(("延迟", f"{row.get('latencyMs')} ms"))
    return fields


def _render_performance_status(payload: dict) -> list[tuple[str, str]]:
    row = _status_data(payload)
    return [
        ("采集", "已启用" if row.get("enabled") is True else "未启用"),
        ("数据", "已加载" if row.get("loaded") is True else "未加载"),
        ("保留记录", str(row.get("retainedRecords") or 0)),
        ("待写记录", str(row.get("pendingRecords") or 0)),
    ]


def _render_desktop_settings(value: object) -> list[tuple[str, str]]:
    return [
        ("界面主题", str(getattr(value, "theme", "system"))),
        ("开机启动", "已启用" if getattr(value, "autostart", False) else "未启用"),
        ("截图", "已启用" if getattr(value, "screenshot_enabled", False) else "未启用"),
        ("截图快捷键", str(getattr(value, "screenshot_shortcut", "Ctrl+Shift+S"))),
    ]


def create_builtin_desktop_extension_registry(*, freeze: bool = True) -> DesktopExtensionRegistry:
    registry = DesktopExtensionRegistry()
    registry.register_command_handler(
        "desktop.open-webgui",
        lambda context: context.open_url(context.manager_url.rstrip("/")),
    )
    registry.register_command_handler(
        "desktop.open-settings",
        lambda context: context.open_url(f"{context.manager_url.rstrip('/')}/#/settings"),
    )
    registry.register_command_handler(
        "desktop.capture-screenshot",
        lambda context: context.invoke_service("desktop.capture-screenshot"),
    )
    registry.register_command_handler(
        "desktop.pin-clipboard-image",
        lambda context: context.invoke_service("desktop.pin-clipboard-image"),
    )
    registry.register_hotkey_contract(
        "capture-screenshot",
        "desktop.capture-screenshot",
        "Ctrl+Shift+S",
        binding=lambda _item, settings: str(getattr(settings, "shortcut", "Ctrl+Shift+S")),
        enabled=lambda _item, settings: getattr(settings, "enabled", False) is True,
    )
    registry.register_hotkey_contract(
        "pin-clipboard-image",
        "desktop.pin-clipboard-image",
        "F3",
        binding=lambda _item, settings: str(getattr(settings, "clipboard_shortcut", "F3")),
        enabled=lambda _item, settings: getattr(settings, "enabled", False) is True,
    )
    for theme_id in ("system", "light", "dark"):
        registry.register_theme_resource(
            theme_id,
            f"builtin.desktop-theme.{theme_id}.v1",
            lambda context, selected=theme_id: context.apply_builtin_theme(context.application, selected),
        )
    registry.register_status_contract(
        "manager.speech-status",
        "builtin.speech-status.v1",
        query=lambda get_json: get_json("/api/speech/status"),
        render=_render_speech_status,
    )
    registry.register_status_contract(
        "manager.performance-status",
        "builtin.performance-status.v1",
        query=lambda get_json: get_json("/api/performance/status"),
        render=_render_performance_status,
    )
    registry.register_settings_contract(
        "builtin.desktop-settings.v1",
        "desktop.settings.v1",
        "manager.desktop-settings.read",
        "manager.desktop-settings.write",
        read=lambda reader: reader(),
        render=_render_desktop_settings,
        open=lambda manager_url, open_url: open_url(f"{manager_url.rstrip('/')}/#/settings"),
    )
    return registry.freeze() if freeze else registry


def load_trusted_desktop_extensions(
    registry: DesktopExtensionRegistry,
    entry_point_names: tuple[str, ...] | list[str],
) -> tuple[str, ...]:
    """Import only explicitly allowed entry points; an empty allowlist imports nothing."""
    requested = tuple(dict.fromkeys(
        _required_text(name, "entry point name", limit=160) for name in entry_point_names
    ))
    if not requested:
        return ()
    if registry.frozen:
        raise RuntimeError("Trusted Desktop extensions must be loaded before the registry is frozen.")
    available: dict[str, object] = {}
    duplicate_names: set[str] = set()
    for entry_point in metadata.entry_points(group=TRUSTED_DESKTOP_EXTENSION_ENTRY_POINT_GROUP):
        if entry_point.name in available:
            duplicate_names.add(entry_point.name)
        else:
            available[entry_point.name] = entry_point
    ambiguous = [name for name in requested if name in duplicate_names]
    if ambiguous:
        raise LookupError(f"Trusted Desktop extension entry point is ambiguous: {', '.join(ambiguous)}")
    missing = [name for name in requested if name not in available]
    if missing:
        raise LookupError(f"Trusted Desktop extension entry point is not installed: {', '.join(missing)}")
    for name in requested:
        registrar = available[name].load()
        if not callable(registrar):
            raise TypeError(f"Trusted Desktop extension entry point is not callable: {name}")
        registrar(registry)
    return requested


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
    registry: DesktopExtensionRegistry,
) -> dict[tuple[str, str, str], _CommandContribution]:
    commands: dict[tuple[str, str, str], _CommandContribution] = {}
    duplicate_keys: set[tuple[str, str, str]] = set()
    for row in rows:
        base = _contribution_base(row, "command", active_plugins, host_capabilities)
        if base is None or not isinstance(row, dict):
            continue
        handler_id = _symbol(row.get("handlerId"))
        danger_level = _text(row.get("dangerLevel") or "safe", limit=40)
        if not registry.has_command_handler(handler_id) or danger_level != "safe":
            continue
        key = (base.plugin_id, base.instance_id, base.contribution_id)
        if key in commands:
            duplicate_keys.add(key)
            commands.pop(key, None)
            continue
        if key not in duplicate_keys:
            commands[key] = _CommandContribution(base.plugin_id, base.instance_id, base.contribution_id, handler_id)
    return commands


def _resolved_menu_items(
    rows: list[object],
    active_plugins: dict[str, _ActivePlugin],
    host_capabilities: frozenset[str],
    registry: DesktopExtensionRegistry,
) -> tuple[DesktopPluginMenuItem, ...]:
    commands = _command_contributions(rows, active_plugins, host_capabilities, registry)
    resolved: list[tuple[int, int, DesktopPluginMenuItem]] = []
    seen: set[tuple[str, str, str]] = set()
    for sequence, row in enumerate(rows):
        base = _contribution_base(row, "tray-menu", active_plugins, host_capabilities)
        if base is None or not isinstance(row, dict):
            continue
        command = commands.get((base.plugin_id, base.instance_id, _symbol(row.get("commandId"))))
        key = (base.plugin_id, base.instance_id, base.contribution_id)
        if command is None or key in seen:
            continue
        seen.add(key)
        resolved.append((base.order, sequence, DesktopPluginMenuItem(
            base.plugin_id, base.instance_id, base.contribution_id,
            command.command_id, command.handler_id, base.label, base.order,
        )))
    resolved.sort(key=lambda item: (item[0], item[1]))
    return tuple(item for _order, _sequence, item in resolved)


def _resolved_hotkeys(
    rows: list[object],
    active_plugins: dict[str, _ActivePlugin],
    host_capabilities: frozenset[str],
    registry: DesktopExtensionRegistry,
) -> tuple[DesktopPluginHotkey, ...]:
    commands = _command_contributions(rows, active_plugins, host_capabilities, registry)
    resolved: list[tuple[int, int, DesktopPluginHotkey]] = []
    seen: set[tuple[str, str, str]] = set()
    for sequence, row in enumerate(rows):
        base = _contribution_base(row, "hotkey", active_plugins, host_capabilities)
        if base is None or not isinstance(row, dict):
            continue
        command = commands.get((base.plugin_id, base.instance_id, _symbol(row.get("commandId"))))
        key = (base.plugin_id, base.instance_id, base.contribution_id)
        if command is None or key in seen:
            continue
        item = DesktopPluginHotkey(
            base.plugin_id, base.instance_id, base.contribution_id,
            command.command_id, command.handler_id,
            _text(row.get("defaultBinding"), limit=80), base.label, base.order,
        )
        if not registry.has_hotkey_contract(item):
            continue
        seen.add(key)
        resolved.append((base.order, sequence, item))
    resolved.sort(key=lambda item: (item[0], item[1]))
    return tuple(item for _order, _sequence, item in resolved)


def _resolved_themes(
    rows: list[object],
    active_plugins: dict[str, _ActivePlugin],
    host_capabilities: frozenset[str],
    registry: DesktopExtensionRegistry,
) -> tuple[DesktopPluginTheme, ...]:
    resolved: list[tuple[int, int, DesktopPluginTheme]] = []
    seen_contributions: set[tuple[str, str, str]] = set()
    seen_themes: set[str] = set()
    for sequence, row in enumerate(rows):
        base = _contribution_base(row, "theme", active_plugins, host_capabilities)
        if base is None or not isinstance(row, dict):
            continue
        theme_id = _symbol(row.get("themeId"))
        resource_id = _symbol(row.get("desktopResourceId"))
        key = (base.plugin_id, base.instance_id, base.contribution_id)
        if not registry.has_theme_resource(theme_id, resource_id):
            continue
        if key in seen_contributions or theme_id in seen_themes:
            continue
        seen_contributions.add(key)
        seen_themes.add(theme_id)
        resolved.append((base.order, sequence, DesktopPluginTheme(
            base.plugin_id, base.instance_id, base.contribution_id,
            theme_id, resource_id, base.label, base.order,
        )))
    resolved.sort(key=lambda item: (item[0], item[1]))
    return tuple(item for _order, _sequence, item in resolved)


def _resolved_status_cards(
    rows: list[object],
    active_plugins: dict[str, _ActivePlugin],
    host_capabilities: frozenset[str],
    registry: DesktopExtensionRegistry,
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
        if not registry.has_status_contract(query_id, renderer_id) or key in seen:
            continue
        seen.add(key)
        resolved.append((base.order, sequence, DesktopPluginStatusCard(
            base.plugin_id, base.instance_id, base.contribution_id,
            query_id, renderer_id, base.label, base.order,
        )))
    resolved.sort(key=lambda item: (item[0], item[1]))
    return tuple(item for _order, _sequence, item in resolved)


def _resolved_settings_sections(
    rows: list[object],
    active_plugins: dict[str, _ActivePlugin],
    host_capabilities: frozenset[str],
    registry: DesktopExtensionRegistry,
) -> tuple[DesktopPluginSettingsSection, ...]:
    resolved: list[tuple[int, int, DesktopPluginSettingsSection]] = []
    seen: set[tuple[str, str, str]] = set()
    for sequence, row in enumerate(rows):
        base = _contribution_base(row, "settings-section", active_plugins, host_capabilities)
        if base is None or not isinstance(row, dict):
            continue
        section = DesktopPluginSettingsSection(
            base.plugin_id, base.instance_id, base.contribution_id,
            _symbol(row.get("rendererId")), _symbol(row.get("schemaId")),
            _symbol(row.get("readCommandId")), _symbol(row.get("writeCommandId")),
            base.label, base.order,
        )
        key = (base.plugin_id, base.instance_id, base.contribution_id)
        if not registry.has_settings_contract(section) or key in seen:
            continue
        seen.add(key)
        resolved.append((base.order, sequence, section))
    resolved.sort(key=lambda item: (item[0], item[1]))
    return tuple(item for _order, _sequence, item in resolved)


def parse_desktop_plugin_catalog(
    payload: object,
    registry: DesktopExtensionRegistry | None = None,
) -> DesktopPluginCatalog | None:
    registry = registry or create_builtin_desktop_extension_registry()
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
    active_plugins = _active_plugins(data.get("plugins"))
    if plugin_revision is None or contribution_revision is None or not isinstance(rows, list) or active_plugins is None:
        return None
    return DesktopPluginCatalog(
        schema_version=2,
        plugin_revision=plugin_revision,
        contribution_revision=contribution_revision,
        menu_items=_resolved_menu_items(rows, active_plugins, DESKTOP_HOST_CAPABILITIES, registry),
        generation=_symbol(data.get("generation")),
        hotkeys=_resolved_hotkeys(rows, active_plugins, DESKTOP_HOST_CAPABILITIES, registry),
        themes=_resolved_themes(rows, active_plugins, DESKTOP_HOST_CAPABILITIES, registry),
        status_cards=_resolved_status_cards(rows, active_plugins, DESKTOP_HOST_CAPABILITIES, registry),
        settings_sections=_resolved_settings_sections(rows, active_plugins, DESKTOP_HOST_CAPABILITIES, registry),
    )


class DesktopPluginCatalogCache:
    def __init__(self, registry: DesktopExtensionRegistry | None = None) -> None:
        self._lock = Lock()
        self._latest: DesktopPluginCatalog | None = None
        self._manager_identity = ""
        self._identity_revision = 0
        self._registry = registry or create_builtin_desktop_extension_registry()

    def observe_manager_identity(self, value: object) -> None:
        identity = _text(value, limit=120)
        if not identity:
            return
        with self._lock:
            if identity == self._manager_identity:
                return
            self._latest = None
            self._manager_identity = identity
            self._identity_revision += 1

    def request_identity_revision(self) -> int:
        with self._lock:
            return self._identity_revision

    def accept_payload(
        self,
        payload: object,
        expected_identity_revision: int | None = None,
    ) -> DesktopPluginCatalog:
        catalog = parse_desktop_plugin_catalog(payload, self._registry)
        if catalog is None:
            return self.fallback()
        with self._lock:
            if expected_identity_revision is not None and expected_identity_revision != self._identity_revision:
                return self._latest or empty_desktop_plugin_catalog()
            if self._latest is not None:
                generation_changed = bool(catalog.generation) and catalog.generation != self._latest.generation
                stale_same_generation = (
                    not generation_changed
                    and (
                        catalog.plugin_revision < self._latest.plugin_revision
                        or catalog.contribution_revision < self._latest.contribution_revision
                    )
                )
                if stale_same_generation:
                    return self._latest
            self._latest = catalog
            return catalog

    def fallback(self) -> DesktopPluginCatalog:
        with self._lock:
            return self._latest or empty_desktop_plugin_catalog()
