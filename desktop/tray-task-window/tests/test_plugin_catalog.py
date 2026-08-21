from __future__ import annotations

import os
import time
import unittest
from urllib.error import URLError

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QThread
from PySide6.QtWidgets import QApplication, QMenu

from rabiroute_tray.manager_client import ManagerClient
from rabiroute_tray.plugin_catalog import (
    DesktopPluginCatalog,
    DesktopPluginCatalogCache,
    DesktopPluginMenuItem,
    empty_desktop_plugin_catalog,
    parse_desktop_plugin_catalog,
)
from rabiroute_tray.tray_app import (
    _desktop_plugin_handler_url,
    _rebuild_plugin_menu,
    _start_desktop_plugin_catalog,
)


def _base(kind: str, contribution_id: str, *, plugin_id: str = "builtin:manager/desktop", instance_id: str = "manager:desktop", **overrides) -> dict:
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


def _payload(revision: int = 1, contributions: list[object] | None = None) -> dict:
    return {
        "code": 0,
        "data": {
            "schemaVersion": 2,
            "host": "desktop",
            "revision": {"plugins": revision, "contributions": revision},
            "plugins": [],
            "contributions": contributions if contributions is not None else [],
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


class _SlowCatalogManager:
    def desktop_plugin_catalog(self) -> DesktopPluginCatalog:
        time.sleep(0.15)
        return empty_desktop_plugin_catalog()


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

    def test_first_request_failure_returns_empty_catalog(self) -> None:
        client = _CatalogManagerClient([URLError("offline")])

        self.assertEqual(client.desktop_plugin_catalog(), empty_desktop_plugin_catalog())

    def test_request_failure_returns_last_successful_catalog(self) -> None:
        client = _CatalogManagerClient([_builtin_payload(4), URLError("offline")])

        accepted = client.desktop_plugin_catalog()
        fallback = client.desktop_plugin_catalog()

        self.assertEqual(fallback, accepted)

    def test_invalid_payload_returns_last_successful_catalog(self) -> None:
        cache = DesktopPluginCatalogCache()
        accepted = cache.accept_payload(_builtin_payload(3))

        fallback = cache.accept_payload({"code": 0, "data": {"schemaVersion": 99}})

        self.assertEqual(fallback, accepted)

    def test_older_revision_does_not_replace_newer_cache(self) -> None:
        cache = DesktopPluginCatalogCache()
        newer = cache.accept_payload(_builtin_payload(8))

        result = cache.accept_payload(_payload(7, []))

        self.assertEqual(result, newer)

    def test_plugin_menu_keeps_fixed_recovery_entries_and_executes_whitelist(self) -> None:
        root = QMenu()
        webgui = root.addAction("打开 RabiRoute WebGUI")
        refresh = root.addAction("刷新")
        separator = root.addSeparator()
        quit_action = root.addAction("退出")
        plugin_menu = QMenu("插件", root)
        executed: list[str] = []
        catalog = parse_desktop_plugin_catalog(_builtin_payload())

        _rebuild_plugin_menu(root, plugin_menu, refresh, catalog, executed.append)

        self.assertEqual(root.actions(), [webgui, plugin_menu.menuAction(), refresh, separator, quit_action])
        self.assertEqual([action.text() for action in plugin_menu.actions()], ["打开 WebGUI", "打开设置"])
        plugin_menu.actions()[0].trigger()
        plugin_menu.actions()[1].trigger()
        self.assertEqual(executed, ["desktop.open-webgui", "desktop.open-settings"])

    def test_catalog_failure_reuses_cached_menu_without_duplicates(self) -> None:
        client = _CatalogManagerClient([_builtin_payload(4), URLError("offline")])
        root = QMenu()
        webgui = root.addAction("打开 RabiRoute WebGUI")
        refresh = root.addAction("刷新")
        quit_action = root.addAction("退出")
        plugin_menu = QMenu("插件", root)

        _rebuild_plugin_menu(root, plugin_menu, refresh, client.desktop_plugin_catalog(), lambda _handler: None)
        first_actions = list(plugin_menu.actions())
        _rebuild_plugin_menu(root, plugin_menu, refresh, client.desktop_plugin_catalog(), lambda _handler: None)

        self.assertEqual(root.actions(), [webgui, plugin_menu.menuAction(), refresh, quit_action])
        self.assertEqual(root.actions().count(plugin_menu.menuAction()), 1)
        self.assertEqual(plugin_menu.actions(), first_actions)

    def test_first_failure_does_not_insert_plugin_menu(self) -> None:
        client = _CatalogManagerClient([URLError("offline")])
        root = QMenu()
        webgui = root.addAction("打开 RabiRoute WebGUI")
        refresh = root.addAction("刷新")
        quit_action = root.addAction("退出")
        plugin_menu = QMenu("插件", root)

        _rebuild_plugin_menu(root, plugin_menu, refresh, client.desktop_plugin_catalog(), lambda _handler: None)

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

        _rebuild_plugin_menu(root, plugin_menu, refresh, catalog, lambda _handler: None)

        self.assertNotIn(plugin_menu.menuAction(), root.actions())

    def test_handler_urls_are_local_fixed_mappings(self) -> None:
        self.assertEqual(
            _desktop_plugin_handler_url("http://127.0.0.1:8790/", "desktop.open-webgui"),
            "http://127.0.0.1:8790",
        )
        self.assertEqual(
            _desktop_plugin_handler_url("http://127.0.0.1:8790", "desktop.open-settings"),
            "http://127.0.0.1:8790/#/settings",
        )
        self.assertIsNone(_desktop_plugin_handler_url("http://127.0.0.1:8790", "desktop.run-shell"))

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


if __name__ == "__main__":
    unittest.main()
