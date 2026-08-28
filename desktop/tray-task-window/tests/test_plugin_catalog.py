from __future__ import annotations

import os
import time
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import URLError

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QThread
from PySide6.QtWidgets import QApplication, QMenu

from rabiroute_tray.manager_client import ManagerClient
from rabiroute_tray.plugin_catalog import (
    DesktopCommandContext,
    DesktopPanelAction,
    DesktopPanelActionContext,
    DesktopPluginCatalog,
    DesktopPluginCatalogCache,
    DesktopPluginHotkey,
    DesktopPluginMenuItem,
    DesktopPluginTheme,
    DesktopPluginSettingsSection,
    DesktopPluginStatusCard,
    create_builtin_desktop_extension_registry,
    empty_desktop_plugin_catalog,
    load_trusted_desktop_extensions,
    parse_desktop_plugin_catalog,
)
from rabiroute_tray.tray_app import (
    _desktop_plugin_hotkeys,
    _desktop_plugin_theme,
    _rebuild_plugin_menu,
    _start_desktop_plugin_catalog,
    _sync_recovery_webgui_action,
)

DESKTOP_OWNER = {"plugin_id": "io.rabiroute.manager.desktop", "instance_id": "manager:desktop"}
CORE_OWNER = {"plugin_id": "io.rabiroute.manager.core", "instance_id": "manager:core"}
PERSONA_OWNER = {"plugin_id": "io.rabiroute.manager.persona", "instance_id": "manager:persona"}
GATEWAY_RUNTIME_OWNER = {"plugin_id": "io.rabiroute.manager.gateway-runtime", "instance_id": "manager:gateway-runtime"}
SPEECH_OWNER = {"plugin_id": "io.rabiroute.manager.speech", "instance_id": "manager:speech"}
PERFORMANCE_OWNER = {"plugin_id": "io.rabiroute.manager.performance", "instance_id": "manager:performance"}
TRUSTED_OWNER = {"plugin_id": "package:trusted-desktop", "instance_id": "manager:trusted-desktop"}


def _base(kind: str, contribution_id: str, *, plugin_id: str = "io.rabiroute.manager.desktop", instance_id: str = "manager:desktop", **overrides) -> dict:
    row = {
        "pluginId": plugin_id,
        "instanceId": instance_id,
        "id": contribution_id,
        "kind": kind,
        "hosts": ["desktop"],
        "surface": "desktop.commands" if kind == "command" else "desktop.tray",
        "slot": "system",
        "order": 10,
        "label": {"fallback": contribution_id},
    }
    row.update(overrides)
    return row


def _command(command_id: str, handler_id: str, **overrides) -> dict:
    values = {"handlerId": handler_id, "dangerLevel": "safe"}
    values.update(overrides)
    return _base("command", command_id, **values)


def _tray(contribution_id: str, command_id: str, **overrides) -> dict:
    return _base("tray-menu", contribution_id, commandId=command_id, **overrides)


def _hotkey(contribution_id: str, command_id: str, default_binding: str, **overrides) -> dict:
    return _base(
        "hotkey",
        contribution_id,
        surface="desktop.hotkeys",
        slot="capture",
        commandId=command_id,
        defaultBinding=default_binding,
        **overrides,
    )


def _theme(
    theme_id: str,
    desktop_resource_id: str,
    *,
    plugin_id: str = "io.rabiroute.manager.core",
    instance_id: str = "manager:core",
    **overrides,
) -> dict:
    return _base(
        "theme",
        f"{theme_id}-theme",
        plugin_id=plugin_id,
        instance_id=instance_id,
        surface="shared.themes",
        slot="interface",
        themeId=theme_id,
        desktopResourceId=desktop_resource_id,
        **overrides,
    )


def _status(contribution_id: str, query_id: str, renderer_id: str, **overrides) -> dict:
    return _base(
        "status-card",
        contribution_id,
        surface="shared.status",
        slot="runtime-status",
        queryId=query_id,
        rendererId=renderer_id,
        **overrides,
    )


def _settings(contribution_id: str = "desktop-settings", **overrides) -> dict:
    values = {
        "surface": "shared.settings",
        "slot": "desktop",
        "rendererId": "builtin.desktop-settings.v1",
        "schemaId": "desktop.settings.v1",
        "readCommandId": "manager.desktop-settings.read",
        "writeCommandId": "manager.desktop-settings.write",
    }
    values.update(overrides)
    return _base("settings-section", contribution_id, **values)


def _plugin(
    plugin_id: str,
    instance_id: str,
    *,
    status: str = "active",
    capabilities: list[str] | None = None,
    hosts: list[str] | None = None,
    manifest_id: str | None = None,
) -> dict:
    return {
        "instanceId": instance_id,
        "pluginId": plugin_id,
        "host": "manager",
        "scope": "global",
        "status": status,
        "missingCapabilities": [],
        "manifest": {
            "id": manifest_id or plugin_id,
            "name": plugin_id,
            "version": "1.0.0",
            "kind": "builtin",
            "hosts": hosts or ["manager", "desktop"],
            "capabilities": capabilities or [],
        },
    }


def _payload(
    revision: int = 1,
    contributions: list[object] | None = None,
    plugins: list[object] | None = None,
    generation: str = "manager-generation-a",
) -> dict:
    contribution_rows = contributions if contributions is not None else []
    if plugins is None:
        owners: dict[tuple[str, str], dict] = {}
        for row in contribution_rows:
            if not isinstance(row, dict):
                continue
            plugin_id = row.get("pluginId")
            instance_id = row.get("instanceId")
            if isinstance(plugin_id, str) and isinstance(instance_id, str):
                owners[(plugin_id, instance_id)] = _plugin(plugin_id, instance_id)
        plugins = list(owners.values())
    return {
        "code": 0,
        "data": {
            "schemaVersion": 2,
            "generation": generation,
            "host": "desktop",
            "revision": {"plugins": revision, "contributions": revision},
            "plugins": plugins,
            "contributions": contribution_rows,
        },
    }


def _builtin_payload(revision: int = 1) -> dict:
    return _payload(
        revision,
        [
            _command("open-webgui", "desktop.open-webgui", order=10, label={"fallback": "WebGUI command"}),
            _command("open-settings", "desktop.open-settings", order=20, label={"fallback": "Settings command"}),
            _tray("open-settings-menu", "open-settings", order=20, label={"fallback": "打开设置"}),
            _tray("open-webgui-menu", "open-webgui", order=10, label={"fallback": "打开 WebGUI"}),
        ],
    )


class _CatalogManagerClient(ManagerClient):
    def __init__(self, responses: list[object]) -> None:
        super().__init__()
        self.responses = list(responses)
        self.paths: list[str] = []

    def _get_json(self, path: str) -> dict:
        self.paths.append(path)
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response  # type: ignore[return-value]


class _SurfaceManagerClient(ManagerClient):
    def __init__(self) -> None:
        super().__init__()
        self.paths: list[str] = []
        self.catalog_payload = _payload(
            contributions=[
                _status(
                    "speech-status",
                    "manager.speech-status",
                    "builtin.speech-status.v1",
                    label={"fallback": "语音服务"},
                    **SPEECH_OWNER,
                ),
                _status(
                    "performance-status",
                    "manager.performance-status",
                    "builtin.performance-status.v1",
                    label={"fallback": "性能监控"},
                    **PERFORMANCE_OWNER,
                ),
                _status("private-status", "manager.private", "package.private.v1"),
                _settings(label={"fallback": "桌面设置"}),
            ]
        )

    def _get_json(self, path: str) -> dict:
        self.paths.append(path)
        if path == "/api/plugins/catalog?host=desktop":
            return self.catalog_payload
        if path == "/api/speech/status":
            return {"code": 0, "data": {"state": "online", "service": "RabiSpeech"}}
        if path == "/api/performance/status":
            return {"code": 0, "data": {"enabled": True, "loaded": True}}
        if path == "/api/desktop/settings":
            return {"code": 0, "data": {"theme": "dark", "screenshot": {"enabled": True}}}
        raise AssertionError(f"Unexpected path: {path}")


class _SlowCatalogManager:
    def desktop_plugin_catalog(self) -> DesktopPluginCatalog:
        time.sleep(0.15)
        return empty_desktop_plugin_catalog()


class _RuntimeErrorCatalogManager:
    def desktop_plugin_catalog(self) -> DesktopPluginCatalog:
        raise RuntimeError("catalog worker failed")


class DesktopPluginCatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_resolves_tray_commands_to_two_whitelisted_handlers(self) -> None:
        catalog = parse_desktop_plugin_catalog(_builtin_payload(6))

        self.assertIsNotNone(catalog)
        self.assertEqual(catalog.schema_version, 2)
        self.assertEqual(catalog.contribution_revision, 6)
        self.assertEqual(
            [(item.label, item.command_id, item.handler_id) for item in catalog.menu_items],
            [
                ("打开 WebGUI", "open-webgui", "desktop.open-webgui"),
                ("打开设置", "open-settings", "desktop.open-settings"),
            ],
        )

    def test_valid_catalog_exposes_active_commands_capabilities_and_availability(self) -> None:
        registry = create_builtin_desktop_extension_registry()
        catalog = parse_desktop_plugin_catalog(
            _payload(
                contributions=[
                    _command(
                        "system-selection",
                        "desktop.system-selection",
                        surface="desktop.lifecycle",
                        slot="selection",
                        requiredCapabilities=["desktop.lifecycle"],
                    ),
                ],
                plugins=[
                    _plugin(
                        "io.rabiroute.manager.desktop",
                        "manager:desktop",
                        capabilities=["desktop.system-selection"],
                    )
                ],
            ),
            registry,
        )

        self.assertIsNotNone(catalog)
        assert catalog is not None
        self.assertTrue(catalog.available)
        self.assertEqual([command.handler_id for command in catalog.commands], ["desktop.system-selection"])
        self.assertIn("desktop.system-selection", catalog.capabilities)
        self.assertTrue(registry.lifecycle_capability_active(catalog, "desktop.system-selection"))

    def test_panel_actions_are_resolved_only_from_active_catalog_commands(self) -> None:
        registry = create_builtin_desktop_extension_registry()
        catalog = parse_desktop_plugin_catalog(
            _payload(contributions=[
                _command(
                    "open-role-directory",
                    "desktop.open-role-directory",
                    surface="desktop.panel",
                    slot="directories",
                    order=10,
                    requiredCapabilities=["desktop.panel-action"],
                    label={"fallback": "人格目录"},
                    **PERSONA_OWNER,
                ),
                _command(
                    "manual-trigger",
                    "desktop.manual-trigger",
                    surface="desktop.panel",
                    slot="actions",
                    order=20,
                    requiredCapabilities=["desktop.panel-action"],
                    label={"fallback": "手动触发"},
                    **GATEWAY_RUNTIME_OWNER,
                ),
            ]),
            registry,
        )
        assert catalog is not None
        invoked: list[str] = []
        actions = registry.panel_actions(
            catalog,
            DesktopPanelActionContext(
                invoke=invoked.append,
                action_groups={
                    "desktop.manual-trigger": (DesktopPanelAction("触发：巡检", lambda: None),),
                },
            ),
        )

        self.assertEqual([action.label for action in actions], ["人格目录", "触发：巡检"])
        actions[0].callback()
        self.assertEqual(invoked, ["desktop.open-role-directory"])

    def test_resolves_controlled_status_and_settings_contributions(self) -> None:
        catalog = parse_desktop_plugin_catalog(
            _payload(
                contributions=[
                    _status(
                        "speech-status",
                        "manager.speech-status",
                        "builtin.speech-status.v1",
                        label={"fallback": "语音服务"},
                        order=20,
                        **SPEECH_OWNER,
                    ),
                    _status(
                        "performance-status",
                        "manager.performance-status",
                        "builtin.performance-status.v1",
                        label={"fallback": "性能监控"},
                        order=30,
                        **PERFORMANCE_OWNER,
                    ),
                    _settings(label={"fallback": "桌面设置"}, order=40),
                ]
            )
        )

        self.assertEqual(
            [(item.label, item.query_id, item.renderer_id) for item in catalog.status_cards],
            [
                ("语音服务", "manager.speech-status", "builtin.speech-status.v1"),
                ("性能监控", "manager.performance-status", "builtin.performance-status.v1"),
            ],
        )
        self.assertEqual(len(catalog.settings_sections), 1)
        self.assertEqual(catalog.settings_sections[0].schema_id, "desktop.settings.v1")

    def test_required_capabilities_use_desktop_host_registry_with_and_semantics(self) -> None:
        plugin_id = "io.rabiroute.manager.speech"
        instance_id = "manager:speech"
        catalog = parse_desktop_plugin_catalog(
            _payload(
                contributions=[
                    _status(
                        "supported",
                        "manager.speech-status",
                        "builtin.speech-status.v1",
                        plugin_id=plugin_id,
                        instance_id=instance_id,
                        requiredCapabilities=["desktop.status-card"],
                    ),
                    _status(
                        "missing-one",
                        "manager.speech-status",
                        "builtin.speech-status.v1",
                        plugin_id=plugin_id,
                        instance_id=instance_id,
                        requiredCapabilities=["desktop.status-card", "manager.contributions"],
                    ),
                ],
                plugins=[
                    _plugin(
                        plugin_id,
                        instance_id,
                        capabilities=["manager.contributions"],
                    )
                ],
            )
        )

        self.assertEqual([item.contribution_id for item in catalog.status_cards], ["supported"])

    def test_inactive_or_mismatched_plugin_owner_is_not_consumed(self) -> None:
        contribution = _status(
            "speech-status",
            "manager.speech-status",
            "builtin.speech-status.v1",
            **SPEECH_OWNER,
        )
        inactive = parse_desktop_plugin_catalog(
            _payload(
                contributions=[contribution],
                plugins=[_plugin("io.rabiroute.manager.speech", "manager:speech", status="inactive")],
            )
        )
        mismatched = parse_desktop_plugin_catalog(
            _payload(
                contributions=[contribution],
                plugins=[
                    _plugin(
                        "io.rabiroute.manager.speech",
                        "manager:speech",
                        manifest_id="example.manager.other",
                    )
                ],
            )
        )
        unsupported_host = parse_desktop_plugin_catalog(
            _payload(
                contributions=[contribution],
                plugins=[
                    _plugin(
                        "io.rabiroute.manager.speech",
                        "manager:speech",
                        hosts=["manager", "web"],
                    )
                ],
            )
        )

        self.assertEqual(inactive.status_cards, ())
        self.assertEqual(mismatched.status_cards, ())
        self.assertEqual(unsupported_host.status_cards, ())

    def test_unknown_status_and_settings_contracts_are_not_consumed(self) -> None:
        catalog = parse_desktop_plugin_catalog(
            _payload(
                contributions=[
                    _status("unknown-query", "manager.private", "builtin.speech-status.v1", **SPEECH_OWNER),
                    _status("unknown-renderer", "manager.speech-status", "package.custom.v1", **SPEECH_OWNER),
                    _settings("unknown-schema", schemaId="package.settings.v1"),
                    _settings("unknown-read", readCommandId="manager.private.read"),
                ]
            )
        )

        self.assertEqual(catalog.status_cards, ())
        self.assertEqual(catalog.settings_sections, ())

    def test_unknown_or_dangerous_handler_is_not_output(self) -> None:
        catalog = parse_desktop_plugin_catalog(
            _payload(
                contributions=[
                    _command("shell", "desktop.run-shell"),
                    _tray("shell-menu", "shell"),
                    _command("dangerous-settings", "desktop.open-settings", dangerLevel="dangerous"),
                    _tray("dangerous-settings-menu", "dangerous-settings"),
                ]
            )
        )

        self.assertEqual(catalog.menu_items, ())

    def test_tray_command_must_belong_to_same_plugin_instance(self) -> None:
        catalog = parse_desktop_plugin_catalog(
            _payload(
                contributions=[
                    _command("open-settings", "desktop.open-settings"),
                    _tray(
                        "borrowed-settings",
                        "open-settings",
                        plugin_id="third-party:plugin",
                        instance_id="manager:third-party",
                    ),
                ]
            )
        )

        self.assertEqual(catalog.menu_items, ())

    def test_orphan_command_or_tray_and_invalid_rows_are_ignored(self) -> None:
        catalog = parse_desktop_plugin_catalog(
            _payload(
                contributions=[
                    _command("open-webgui", "desktop.open-webgui"),
                    _tray("missing-command", "missing"),
                    {"kind": "command", "hosts": ["desktop"]},
                ]
            )
        )

        self.assertEqual(catalog.menu_items, ())

    def test_invalid_catalog_contract_is_rejected(self) -> None:
        self.assertIsNone(parse_desktop_plugin_catalog({"code": 0, "data": {"schemaVersion": 1}}))
        self.assertIsNone(parse_desktop_plugin_catalog(_builtin_payload() | {"code": -1}))

    def test_manager_client_requests_desktop_catalog(self) -> None:
        client = _CatalogManagerClient([_builtin_payload(2)])

        catalog = client.desktop_plugin_catalog()

        self.assertEqual(catalog.contribution_revision, 2)
        self.assertEqual(client.paths, ["/api/plugins/catalog?host=desktop"])

    def test_manager_client_consumes_only_resolved_status_and_settings_contracts(self) -> None:
        client = _SurfaceManagerClient()

        snapshot = client.desktop_plugin_surface_snapshot()

        self.assertEqual(
            [result.card.query_id for result in snapshot.statuses],
            ["manager.speech-status", "manager.performance-status"],
        )
        self.assertEqual(snapshot.statuses[0].payload["data"]["state"], "online")
        self.assertEqual(len(snapshot.settings), 1)
        self.assertEqual(snapshot.settings[0].settings.theme, "dark")
        self.assertEqual(
            client.paths,
            [
                "/api/plugins/catalog?host=desktop",
                "/api/speech/status",
                "/api/performance/status",
                "/api/desktop/settings",
            ],
        )

    def test_manager_client_rejects_unknown_fixed_ids_before_request(self) -> None:
        client = _SurfaceManagerClient()
        unknown_card = DesktopPluginStatusCard(
            plugin_id="package:private",
            instance_id="manager:private",
            contribution_id="private-status",
            query_id="manager.private",
            renderer_id="package.private.v1",
            label="私有状态",
            order=1,
        )
        unknown_settings = DesktopPluginSettingsSection(
            plugin_id="package:private",
            instance_id="manager:private",
            contribution_id="private-settings",
            renderer_id="package.private.v1",
            schema_id="package.private.v1",
            read_command_id="manager.private.read",
            write_command_id="manager.private.write",
            label="私有设置",
            order=1,
        )

        with self.assertRaises(ValueError):
            client.desktop_plugin_status_payload(unknown_card)
        with self.assertRaises(ValueError):
            client.desktop_plugin_settings_value(unknown_settings)
        self.assertEqual(client.paths, [])

    def test_first_request_failure_returns_empty_catalog(self) -> None:
        client = _CatalogManagerClient([URLError("offline")])

        self.assertEqual(client.desktop_plugin_catalog(), empty_desktop_plugin_catalog())

    def test_request_failure_removes_last_successful_catalog(self) -> None:
        client = _CatalogManagerClient([_builtin_payload(4), URLError("offline")])

        accepted = client.desktop_plugin_catalog()
        fallback = client.desktop_plugin_catalog()

        self.assertTrue(accepted.available)
        self.assertEqual(fallback, empty_desktop_plugin_catalog())

    def test_invalid_payload_removes_last_successful_catalog(self) -> None:
        cache = DesktopPluginCatalogCache()
        accepted = cache.accept_payload(_builtin_payload(3))

        fallback = cache.accept_payload({"code": 0, "data": {"schemaVersion": 99}})

        self.assertTrue(accepted.available)
        self.assertEqual(fallback, empty_desktop_plugin_catalog())

    def test_older_revision_does_not_replace_newer_cache(self) -> None:
        cache = DesktopPluginCatalogCache()
        newer = cache.accept_payload(_builtin_payload(8))

        result = cache.accept_payload(_payload(7, []))

        self.assertEqual(result, newer)

    def test_new_manager_generation_accepts_lower_revision(self) -> None:
        cache = DesktopPluginCatalogCache()
        cache.accept_payload(_payload(8, [], generation="manager-generation-a"))

        restarted = cache.accept_payload(_payload(1, [], generation="manager-generation-b"))

        self.assertEqual(restarted.generation, "manager-generation-b")
        self.assertEqual(restarted.contribution_revision, 1)

    def test_legacy_manager_pid_change_clears_revision_cache(self) -> None:
        cache = DesktopPluginCatalogCache()
        cache.observe_manager_identity("pid:100")
        cache.accept_payload(_payload(8, [], generation=""))

        cache.observe_manager_identity("pid:200")
        restarted = cache.accept_payload(_payload(1, [], generation=""))

        self.assertEqual(restarted.contribution_revision, 1)

    def test_old_catalog_response_cannot_repopulate_after_manager_pid_changes(self) -> None:
        cache = DesktopPluginCatalogCache()
        cache.observe_manager_identity("pid:100")
        old_request_revision = cache.request_identity_revision()
        cache.accept_payload(_payload(8, [], generation=""), old_request_revision)

        cache.observe_manager_identity("pid:200")
        stale = cache.accept_payload(_payload(9, [], generation=""), old_request_revision)
        new_request_revision = cache.request_identity_revision()
        restarted = cache.accept_payload(_payload(1, [], generation=""), new_request_revision)

        self.assertEqual(stale, empty_desktop_plugin_catalog())
        self.assertEqual(restarted.contribution_revision, 1)

    def test_resolves_controlled_hotkeys_and_themes(self) -> None:
        catalog = parse_desktop_plugin_catalog(
            _payload(
                contributions=[
                    _command("capture-screenshot", "desktop.capture-screenshot"),
                    _hotkey("capture-screenshot-hotkey", "capture-screenshot", "Ctrl+Shift+S"),
                    _command("pin-clipboard-image", "desktop.pin-clipboard-image"),
                    _hotkey("pin-clipboard-image-hotkey", "pin-clipboard-image", "F3"),
                    _theme("system", "builtin.desktop-theme.system.v1"),
                    _theme("light", "builtin.desktop-theme.light.v1"),
                    _theme("dark", "builtin.desktop-theme.dark.v1"),
                ]
            )
        )

        self.assertIsNotNone(catalog)
        assert catalog is not None
        self.assertEqual(
            [(item.command_id, item.handler_id, item.default_binding) for item in catalog.hotkeys],
            [
                ("capture-screenshot", "desktop.capture-screenshot", "Ctrl+Shift+S"),
                ("pin-clipboard-image", "desktop.pin-clipboard-image", "F3"),
            ],
        )
        self.assertEqual(
            [(item.theme_id, item.desktop_resource_id) for item in catalog.themes],
            [
                ("system", "builtin.desktop-theme.system.v1"),
                ("light", "builtin.desktop-theme.light.v1"),
                ("dark", "builtin.desktop-theme.dark.v1"),
            ],
        )
        self.assertEqual(
            tuple(item.handler_id for item in _desktop_plugin_hotkeys(
                catalog, create_builtin_desktop_extension_registry()
            )),
            ("desktop.capture-screenshot", "desktop.pin-clipboard-image"),
        )
        registry = create_builtin_desktop_extension_registry()
        self.assertEqual(_desktop_plugin_theme(catalog, "dark", registry).theme_id, "dark")
        self.assertIsNone(_desktop_plugin_theme(catalog, "unknown", registry))

    def test_trusted_registry_accepts_registered_extension_contracts(self) -> None:
        registry = create_builtin_desktop_extension_registry(freeze=False)
        executed: list[str] = []
        registry.register_command_handler(
            "trusted.open-panel",
            lambda context: executed.append(context.manager_url),
            **TRUSTED_OWNER,
        )
        registry.register_hotkey_contract(
            "open-trusted-panel",
            "trusted.open-panel",
            "Ctrl+Alt+T",
            **TRUSTED_OWNER,
        )
        registry.register_theme_resource(
            "trusted",
            "trusted.theme.v1",
            lambda _context: "dark",
            **TRUSTED_OWNER,
        )
        registry.register_status_contract(
            "manager.trusted-status",
            "trusted.status.v1",
            query=lambda get_json: get_json("/api/trusted/status"),
            render=lambda payload: [("状态", str(payload["data"]["state"]))],
            **TRUSTED_OWNER,
        )
        registry.register_settings_contract(
            "trusted.settings.v1",
            "trusted.settings.schema.v1",
            "manager.trusted-settings.read",
            "manager.trusted-settings.write",
            read=lambda _reader: {"enabled": True},
            render=lambda value: [("启用", "是" if value["enabled"] else "否")],
            open=lambda manager_url, open_url: open_url(f"{manager_url}/#/trusted"),
            **TRUSTED_OWNER,
        )
        registry.freeze()
        catalog = parse_desktop_plugin_catalog(
            _payload(contributions=[
                _command("open-trusted-panel", "trusted.open-panel", **TRUSTED_OWNER),
                _tray("trusted-panel-menu", "open-trusted-panel", **TRUSTED_OWNER),
                _hotkey("trusted-panel-hotkey", "open-trusted-panel", "Ctrl+Alt+T", **TRUSTED_OWNER),
                _theme("trusted", "trusted.theme.v1", **TRUSTED_OWNER),
                _status("trusted-status", "manager.trusted-status", "trusted.status.v1", **TRUSTED_OWNER),
                _settings(
                    "trusted-settings",
                    rendererId="trusted.settings.v1",
                    schemaId="trusted.settings.schema.v1",
                    readCommandId="manager.trusted-settings.read",
                    writeCommandId="manager.trusted-settings.write",
                    **TRUSTED_OWNER,
                ),
            ]),
            registry,
        )

        self.assertIsNotNone(catalog)
        assert catalog is not None
        self.assertEqual([item.handler_id for item in catalog.menu_items], ["trusted.open-panel"])
        self.assertEqual([item.handler_id for item in catalog.hotkeys], ["trusted.open-panel"])
        self.assertEqual([item.desktop_resource_id for item in catalog.themes], ["trusted.theme.v1"])
        self.assertEqual([item.renderer_id for item in catalog.status_cards], ["trusted.status.v1"])
        self.assertEqual([item.renderer_id for item in catalog.settings_sections], ["trusted.settings.v1"])
        registry.invoke_command(
            "trusted.open-panel",
            DesktopCommandContext("http://127.0.0.1:8790", lambda _url: None, {}),
        )
        self.assertEqual(executed, ["http://127.0.0.1:8790"])

    def test_trusted_registry_rejects_cross_plugin_contract_references(self) -> None:
        attacker = {"plugin_id": "package:attacker", "instance_id": "manager:attacker"}
        catalog = parse_desktop_plugin_catalog(
            _payload(contributions=[
                _command("borrow-open-webgui", "desktop.open-webgui", **attacker),
                _tray("borrow-open-webgui-menu", "borrow-open-webgui", **attacker),
                _hotkey("borrow-screenshot", "borrow-open-webgui", "Ctrl+Shift+S", **attacker),
                _theme("dark", "builtin.desktop-theme.dark.v1", **attacker),
                _status("borrow-speech", "manager.speech-status", "builtin.speech-status.v1", **attacker),
                _settings("borrow-settings", **attacker),
            ]),
            create_builtin_desktop_extension_registry(),
        )

        self.assertIsNotNone(catalog)
        assert catalog is not None
        self.assertEqual(catalog.commands, ())
        self.assertEqual(catalog.menu_items, ())
        self.assertEqual(catalog.hotkeys, ())
        self.assertEqual(catalog.themes, ())
        self.assertEqual(catalog.status_cards, ())
        self.assertEqual(catalog.settings_sections, ())

    def test_trusted_extension_entry_points_are_explicit_and_loaded_before_freeze(self) -> None:
        registry = create_builtin_desktop_extension_registry(freeze=False)
        entry_point = MagicMock()
        entry_point.name = "trusted-example"
        entry_point.load.return_value = lambda target: target.register_command_handler(
            "trusted.entry-command",
            lambda _context: None,
            **TRUSTED_OWNER,
        )

        with patch(
            "rabiroute_tray.plugin_catalog.metadata.entry_points",
            return_value=[entry_point],
        ) as entry_points:
            self.assertEqual(load_trusted_desktop_extensions(registry, ()), ())
            entry_points.assert_not_called()
            self.assertEqual(
                load_trusted_desktop_extensions(registry, ("trusted-example", "trusted-example")),
                ("trusted-example",),
            )

        self.assertTrue(registry.has_command_handler("trusted.entry-command", **TRUSTED_OWNER))
        registry.freeze()
        with self.assertRaises(RuntimeError):
            load_trusted_desktop_extensions(registry, ("trusted-example",))

    def test_duplicate_trusted_extension_entry_point_fails_closed(self) -> None:
        registry = create_builtin_desktop_extension_registry(freeze=False)
        first = MagicMock()
        first.name = "duplicate-extension"
        second = MagicMock()
        second.name = "duplicate-extension"
        with patch(
            "rabiroute_tray.plugin_catalog.metadata.entry_points",
            return_value=[first, second],
        ):
            with self.assertRaises(LookupError):
                load_trusted_desktop_extensions(registry, ("duplicate-extension",))
        first.load.assert_not_called()
        second.load.assert_not_called()
    def test_missing_trusted_extension_entry_point_fails_closed(self) -> None:
        registry = create_builtin_desktop_extension_registry(freeze=False)
        with patch("rabiroute_tray.plugin_catalog.metadata.entry_points", return_value=[]):
            with self.assertRaises(LookupError):
                load_trusted_desktop_extensions(registry, ("missing-extension",))
    def test_rejects_unknown_or_cross_instance_hotkey_contracts(self) -> None:
        catalog = parse_desktop_plugin_catalog(
            _payload(
                contributions=[
                    _command("capture-screenshot", "desktop.capture-screenshot"),
                    _hotkey("wrong-binding", "capture-screenshot", "Ctrl+Alt+S"),
                    _hotkey("unknown-command", "missing-command", "Ctrl+Shift+S"),
                    _hotkey(
                        "cross-instance",
                        "capture-screenshot",
                        "Ctrl+Shift+S",
                        plugin_id="third-party:desktop",
                        instance_id="manager:third-party",
                    ),
                    _command("unsafe", "desktop.run-shell"),
                    _hotkey("unsafe-hotkey", "unsafe", "F3"),
                ]
            )
        )

        self.assertIsNotNone(catalog)
        assert catalog is not None
        self.assertEqual(catalog.hotkeys, ())

    def test_rejects_unknown_theme_resources_and_missing_host_capabilities(self) -> None:
        catalog = parse_desktop_plugin_catalog(
            _payload(
                contributions=[
                    _theme("dark", "third-party.theme.dark"),
                    _theme(
                        "light",
                        "builtin.desktop-theme.light.v1",
                        requiredCapabilities=["desktop.unknown"],
                    ),
                    _command("capture-screenshot", "desktop.capture-screenshot"),
                    _hotkey(
                        "capture-screenshot-hotkey",
                        "capture-screenshot",
                        "Ctrl+Shift+S",
                        requiredCapabilities=["desktop.unknown"],
                    ),
                ]
            )
        )

        self.assertIsNotNone(catalog)
        assert catalog is not None
        self.assertEqual(catalog.themes, ())
        self.assertEqual(catalog.hotkeys, ())

    def test_tray_host_rechecks_hotkey_and_theme_whitelists(self) -> None:
        catalog = DesktopPluginCatalog(
            schema_version=2,
            plugin_revision=1,
            contribution_revision=1,
            menu_items=(),
            hotkeys=(
                DesktopPluginHotkey(
                    plugin_id="third-party:desktop",
                    instance_id="manager:third-party",
                    contribution_id="unsafe",
                    command_id="capture-screenshot",
                    handler_id="desktop.run-shell",
                    default_binding="Ctrl+Shift+S",
                    label="unsafe",
                    order=1,
                ),
            ),
            themes=(
                DesktopPluginTheme(
                    plugin_id="third-party:desktop",
                    instance_id="manager:third-party",
                    contribution_id="unsafe-theme",
                    theme_id="dark",
                    desktop_resource_id="third-party.theme.dark",
                    label="unsafe",
                    order=1,
                ),
            ),
        )

        registry = create_builtin_desktop_extension_registry()
        self.assertEqual(_desktop_plugin_hotkeys(catalog, registry), ())
        self.assertIsNone(_desktop_plugin_theme(catalog, "dark", registry))

    def test_plugin_menu_keeps_fixed_recovery_entries_and_executes_whitelist(self) -> None:
        root = QMenu()
        webgui = root.addAction("打开 RabiRoute WebGUI")
        refresh = root.addAction("刷新")
        separator = root.addSeparator()
        quit_action = root.addAction("退出")
        plugin_menu = QMenu("插件", root)
        executed: list[str] = []
        catalog = parse_desktop_plugin_catalog(_builtin_payload())

        _rebuild_plugin_menu(root, plugin_menu, refresh, catalog, executed.append, create_builtin_desktop_extension_registry())

        self.assertEqual(root.actions(), [webgui, plugin_menu.menuAction(), refresh, separator, quit_action])
        self.assertEqual([action.text() for action in plugin_menu.actions()], ["打开 WebGUI", "打开设置"])
        plugin_menu.actions()[0].trigger()
        plugin_menu.actions()[1].trigger()
        self.assertEqual(executed, ["desktop.open-webgui", "desktop.open-settings"])

    def test_fixed_webgui_action_is_only_present_while_catalog_is_unavailable(self) -> None:
        root = QMenu()
        recovery = root.addAction("打开 RabiRoute WebGUI")
        refresh = root.addAction("刷新")

        _sync_recovery_webgui_action(root, recovery, refresh, empty_desktop_plugin_catalog())
        self.assertIn(recovery, root.actions())

        _sync_recovery_webgui_action(
            root,
            recovery,
            refresh,
            DesktopPluginCatalog(2, 1, 1, (), available=True),
        )
        self.assertNotIn(recovery, root.actions())

        _sync_recovery_webgui_action(root, recovery, refresh, empty_desktop_plugin_catalog())
        self.assertEqual(root.actions(), [recovery, refresh])

    def test_catalog_failure_removes_cached_plugin_menu(self) -> None:
        client = _CatalogManagerClient([_builtin_payload(4), URLError("offline")])
        root = QMenu()
        webgui = root.addAction("打开 RabiRoute WebGUI")
        refresh = root.addAction("刷新")
        quit_action = root.addAction("退出")
        plugin_menu = QMenu("插件", root)

        _rebuild_plugin_menu(root, plugin_menu, refresh, client.desktop_plugin_catalog(), lambda _handler: None, create_builtin_desktop_extension_registry())
        self.assertIn(plugin_menu.menuAction(), root.actions())
        failed_catalog = client.desktop_plugin_catalog()
        _sync_recovery_webgui_action(root, webgui, refresh, failed_catalog)
        _rebuild_plugin_menu(root, plugin_menu, refresh, failed_catalog, lambda _handler: None, create_builtin_desktop_extension_registry())

        self.assertEqual(root.actions(), [webgui, refresh, quit_action])
        self.assertEqual(plugin_menu.actions(), [])

    def test_first_failure_does_not_insert_plugin_menu(self) -> None:
        client = _CatalogManagerClient([URLError("offline")])
        root = QMenu()
        webgui = root.addAction("打开 RabiRoute WebGUI")
        refresh = root.addAction("刷新")
        quit_action = root.addAction("退出")
        plugin_menu = QMenu("插件", root)

        _rebuild_plugin_menu(root, plugin_menu, refresh, client.desktop_plugin_catalog(), lambda _handler: None, create_builtin_desktop_extension_registry())

        self.assertEqual(root.actions(), [webgui, refresh, quit_action])

    def test_unknown_handler_is_filtered_again_by_tray_host(self) -> None:
        root = QMenu()
        refresh = root.addAction("刷新")
        plugin_menu = QMenu("插件", root)
        catalog = DesktopPluginCatalog(
            schema_version=2,
            plugin_revision=1,
            contribution_revision=1,
            menu_items=(
                DesktopPluginMenuItem(
                    plugin_id="third-party:plugin",
                    instance_id="manager:third-party",
                    contribution_id="unsafe-menu",
                    command_id="unsafe",
                    handler_id="desktop.run-shell",
                    label="运行命令",
                    order=1,
                ),
            ),
        )

        _rebuild_plugin_menu(root, plugin_menu, refresh, catalog, lambda _handler: None, create_builtin_desktop_extension_registry())

        self.assertNotIn(plugin_menu.menuAction(), root.actions())

    def test_registered_command_handlers_fail_closed(self) -> None:
        registry = create_builtin_desktop_extension_registry()
        opened: list[str] = []
        context = DesktopCommandContext("http://127.0.0.1:8790/", opened.append, {})

        registry.invoke_command("desktop.open-webgui", context)
        registry.invoke_command("desktop.open-settings", context)

        self.assertEqual(opened, ["http://127.0.0.1:8790", "http://127.0.0.1:8790/#/settings"])
        with self.assertRaises(LookupError):
            registry.invoke_command("desktop.run-shell", context)

    def test_catalog_fetch_does_not_block_qt_thread(self) -> None:
        results: list[DesktopPluginCatalog | None] = []
        callback_threads: list[QThread] = []
        started_at = time.perf_counter()

        _start_desktop_plugin_catalog(
            _SlowCatalogManager(),  # type: ignore[arg-type]
            lambda _task, catalog: (
                callback_threads.append(QThread.currentThread()),
                results.append(catalog),
            ),
        )

        self.assertLess(time.perf_counter() - started_at, 0.08)
        deadline = time.perf_counter() + 1.0
        while not results and time.perf_counter() < deadline:
            self.app.processEvents()
            time.sleep(0.01)
        self.assertEqual(results, [empty_desktop_plugin_catalog()])
        self.assertEqual(callback_threads, [self.app.thread()])

    def test_catalog_runtime_error_returns_empty_catalog_and_revokes_old_contributions(self) -> None:
        registry = create_builtin_desktop_extension_registry()
        root = QMenu()
        recovery = root.addAction("打开 RabiRoute WebGUI")
        refresh = root.addAction("刷新")
        quit_action = root.addAction("退出")
        plugin_menu = QMenu("插件", root)
        old_catalog = parse_desktop_plugin_catalog(_builtin_payload(4), registry)
        assert old_catalog is not None
        applied: list[DesktopPluginCatalog] = []

        _sync_recovery_webgui_action(root, recovery, refresh, old_catalog)
        _rebuild_plugin_menu(root, plugin_menu, refresh, old_catalog, lambda _handler: None, registry)
        self.assertIn(plugin_menu.menuAction(), root.actions())
        self.assertNotIn(recovery, root.actions())

        def completed(_task, catalog: DesktopPluginCatalog) -> None:
            applied.append(catalog)
            _sync_recovery_webgui_action(root, recovery, refresh, catalog)
            _rebuild_plugin_menu(root, plugin_menu, refresh, catalog, lambda _handler: None, registry)

        _start_desktop_plugin_catalog(
            _RuntimeErrorCatalogManager(),  # type: ignore[arg-type]
            completed,
        )

        deadline = time.perf_counter() + 1.0
        while not applied and time.perf_counter() < deadline:
            self.app.processEvents()
            time.sleep(0.01)

        self.assertEqual(applied, [empty_desktop_plugin_catalog()])
        self.assertEqual(root.actions(), [recovery, refresh, quit_action])
        self.assertEqual(plugin_menu.actions(), [])


if __name__ == "__main__":
    unittest.main()
