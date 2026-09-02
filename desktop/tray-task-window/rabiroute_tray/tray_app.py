from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Callable

from PySide6.QtCore import QEventLoop, QIODevice, QTimer, Qt
from PySide6.QtGui import QAction, QColor, QIcon, QPainter, QPixmap
from PySide6.QtNetwork import QLocalSocket
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

from .app_paths import project_dir_from_gateway, role_dir_from_gateway, role_id_from_gateway, runtime_dir_from_gateway
from .desktop_adapter import DesktopAdapter
from .desktop_feature_runtime import (
    DesktopFeatureContext,
    activate_builtin_features,
    enabled_builtin_feature_ids,
)
from .desktop_refresh import (
    DesktopRefreshResult,
    DesktopRefreshService,
    gateway_by_id as _gateway_by_id,
    retain_last_gateway_snapshot as _retain_last_gateway_snapshot,
)
from .desktop_read_model import empty_desktop_read_model
from .display_helpers import route_menu_label, route_state, route_status_label
from .lifecycle_controller import LifecycleController
from .manager_client import (
    ManagerClient,
    ManagerSnapshot,
    ManualTriggerResult,
    PlanFeedbackSubmitResult,
    RolePanelSendResult,
)
from .plugin_catalog import (
    DesktopCommandContext,
    DesktopExtensionRegistry,
    DesktopPanelAction,
    DesktopPanelActionContext,
    DesktopPluginCatalog,
    DesktopPluginHotkey,
    DesktopPluginTheme,
    DesktopThemeContext,
    create_builtin_desktop_extension_registry,
    empty_desktop_plugin_catalog,
)
from .qt_async import QtAsyncTask, start_qt_task, wait_for_qt_tasks
from .system_selection import (
    SelectionDeliveryTarget,
    SystemSelectionController,
    active_selection_delivery_targets,
)
from .system_screenshot import SystemScreenshotController
from .task_window import TaskWindow
from .theme import apply_rabi_application_theme, apply_rabi_menu_theme
from .themes import register_custom_theme
from .tray_menu_controller import TrayMenuController, show_tray_menu_for_activation
from .windows_app_identity import apply_qt_app_metadata


MAX_DIRECT_PERSONA_CHATS = 5
FIXED_TRAY_COMMAND_HANDLER_IDS = frozenset({"desktop.open-webgui"})
_ROUTE_STATE_ICONS: dict[str, QIcon] = {}


class _SnapshotRefreshGate:
    def __init__(self) -> None:
        self._pending_tasks: set[object] = set()
        self._manual_refresh_queued = False

    def request(self, auto: bool) -> bool:
        if not self._pending_tasks:
            return True
        if not auto:
            self._manual_refresh_queued = True
        return False

    def started(self, task: object) -> None:
        self._pending_tasks.add(task)

    def completed(self, task: object) -> bool:
        self._pending_tasks.discard(task)
        manual_refresh_queued = self._manual_refresh_queued
        self._manual_refresh_queued = False
        return manual_refresh_queued


def _start_role_panel_send(
    manager: ManagerClient,
    gateway_id: str,
    text: str,
    attachments: list[dict],
    completed_callback,
    started_callback=None,
) -> QtAsyncTask:
    return start_qt_task(
        lambda: manager.send_role_panel_message(gateway_id, text, attachments),
        completed_callback,
        on_error=lambda error: RolePanelSendResult(ok=False, message=f"unexpected send failure: {error}"),
        started_callback=started_callback,
    )


def _start_manager_snapshot(
    manager: ManagerClient,
    completed_callback,
    started_callback=None,
) -> QtAsyncTask:
    return start_qt_task(
        manager.snapshot,
        completed_callback,
        on_error=lambda error: ManagerSnapshot(
            connected=False,
            manager_url=manager.manager_url,
            meta={},
            gateways=[],
            error=f"unexpected snapshot failure: {error}",
        ),
        started_callback=started_callback,
    )


def _start_desktop_plugin_catalog(
    manager: ManagerClient,
    completed_callback,
    started_callback=None,
) -> QtAsyncTask:
    return start_qt_task(
        manager.desktop_plugin_catalog,
        completed_callback,
        on_error=lambda _error: empty_desktop_plugin_catalog(),
        started_callback=started_callback,
    )


def _start_plan_feedback_send(
    manager: ManagerClient,
    role_id: str,
    plan_id: str,
    gateway_id: str,
    step_id: str,
    feedback_id: str,
    text: str,
    completed_callback,
    started_callback=None,
) -> QtAsyncTask:
    return start_qt_task(
        lambda: manager.submit_plan_feedback(role_id, plan_id, gateway_id, step_id, feedback_id, text),
        completed_callback,
        on_error=lambda error: PlanFeedbackSubmitResult(ok=False, message=f"unexpected feedback failure: {error}"),
        started_callback=started_callback,
    )


def _start_manual_trigger(
    manager: ManagerClient,
    gateway_id: str,
    trigger_id: str,
    trigger_name: str,
    message: str,
    route_kind: str,
    completed_callback,
    started_callback=None,
) -> QtAsyncTask:
    return start_qt_task(
        lambda: manager.manual_trigger(
            gateway_id,
            trigger_id,
            trigger_name,
            message,
            route_kind,
            trigger_id,
        ),
        completed_callback,
        on_error=lambda error: ManualTriggerResult(ok=False, message=f"unexpected trigger failure: {error}"),
        started_callback=started_callback,
    )


def _start_application_quit(
    lifecycle: LifecycleController,
    completed_callback,
    started_callback=None,
) -> QtAsyncTask:
    return start_qt_task(
        lifecycle.request_exit,
        completed_callback,
        on_error=lambda _error: False,
        started_callback=started_callback,
    )


def _start_desktop_refresh(
    refresh_service: DesktopRefreshService,
    previous_manager: ManagerSnapshot,
    selected_gateway_id: str,
    include_role_messages: bool,
    completed_callback,
    started_callback=None,
) -> QtAsyncTask:
    return start_qt_task(
        lambda: refresh_service.load(previous_manager, selected_gateway_id, include_role_messages),
        completed_callback,
        on_error=refresh_service.unexpected_failure,
        started_callback=started_callback,
    )


def _wait_for_background_tasks(timeout_ms: int = 5_000) -> bool:
    return wait_for_qt_tasks(timeout_ms)


def run(
    package_root: Path,
    state_root: Path,
    manager_url: str,
    application_generation_id: str,
    manager_instance_id: str,
    host_executable: Path,
    host_lifecycle_pipe: str,
) -> int:
    enabled_features = enabled_builtin_feature_ids()
    desktop_pet_enabled = "io.rabiroute.desktop.pet-renderer@1" in enabled_features
    desktop_extensions = create_builtin_desktop_extension_registry()
    app = QApplication(sys.argv)
    apply_qt_app_metadata(app)

    tray_available = QSystemTrayIcon.isSystemTrayAvailable()
    app.setQuitOnLastWindowClosed(not tray_available)

    manager = ManagerClient(
        manager_url,
        application_generation_id=application_generation_id,
        manager_instance_id=manager_instance_id,
        extension_registry=desktop_extensions,
    )
    lifecycle = LifecycleController(host_executable, application_generation_id)
    desktop = DesktopAdapter(package_root)
    refresh_service = DesktopRefreshService(manager, state_root)
    app_icon = desktop.app_icon()

    tray = QSystemTrayIcon(app_icon, app)
    tray.setToolTip("RabiRoute / Rabi 桌面分诊台")

    refresh_action = QAction("刷新")
    webgui_action = QAction("打开 RabiRoute WebGUI")
    desktop_pet_menu = QMenu("虚拟形象") if desktop_pet_enabled else None
    status_action = QAction("状态：加载中")
    persona_heading_action = QAction("人格聊天")
    more_personas_menu = QMenu("更多人格")
    quit_action = QAction(lifecycle.exit_label)
    status_action.setEnabled(False)
    persona_heading_action.setEnabled(False)

    menu = QMenu()
    plugin_menu = QMenu("插件", menu)
    themed_menus = [menu, more_personas_menu, plugin_menu]
    if desktop_pet_menu is not None:
        themed_menus.append(desktop_pet_menu)
    apply_rabi_menu_theme(*themed_menus)
    menu.addAction(status_action)
    menu.addSeparator()
    menu.addAction(persona_heading_action)
    persona_actions_end = menu.addSeparator()
    if desktop_pet_menu is not None:
        menu.addMenu(desktop_pet_menu)
    menu.addAction(webgui_action)
    menu.addAction(refresh_action)
    menu.addSeparator()
    menu.addAction(quit_action)
    _warm_menu_layout(menu)
    tray._rabiroute_menu_controller = TrayMenuController(tray, menu)

    initial_manager = ManagerSnapshot(
        connected=False,
        manager_url=manager.manager_url,
        meta={},
        gateways=[],
        error="initializing",
    )
    panel: TaskWindow | None = None
    selected_gateway_id = str(initial_manager.selected_gateway.get("id") or "") if initial_manager.selected_gateway else ""
    initial_role_id = role_id_from_gateway(initial_manager.selected_gateway)
    initial_plans, initial_context = empty_desktop_read_model(
        state_root,
        initial_manager.selected_gateway,
        initial_role_id,
    )
    state = {
        "manager": initial_manager,
        "plans": initial_plans,
        "context": initial_context,
        "role_messages": [],
        "loaded_gateway_id": selected_gateway_id,
        "theme": "system",
        "resolved_theme": "light",
        "theme_definition": None,
        "plugin_catalog": empty_desktop_plugin_catalog(),
    }
    theme_refresh_task: QtAsyncTask | None = None
    plugin_catalog_task: QtAsyncTask | None = None
    pending_role_panel_sends: set[QtAsyncTask] = set()
    pending_plan_feedback_sends: set[QtAsyncTask] = set()
    refresh_gate = _SnapshotRefreshGate()
    lifecycle.observe(initial_manager)

    def apply_desktop_theme(theme: object, custom_theme: object = None) -> None:
        registered_custom_theme = register_custom_theme(custom_theme)
        if registered_custom_theme:
            theme = registered_custom_theme
        selected = _desktop_plugin_theme(state["plugin_catalog"], theme, desktop_extensions)
        context = DesktopThemeContext(app, apply_rabi_application_theme)
        try:
            resolved = (
                desktop_extensions.apply_theme(selected, context)
                if selected is not None
                else apply_rabi_application_theme(app, theme)
                if registered_custom_theme
                else desktop_extensions.apply_registered_theme(
                    "system", "builtin.desktop-theme.system.v1", context
                )
            )
        except LookupError:
            resolved = apply_rabi_application_theme(app, "system")
        state["theme"] = theme if isinstance(theme, str) else "system"
        state["theme_definition"] = custom_theme if isinstance(custom_theme, dict) else None
        state["resolved_theme"] = resolved
        apply_rabi_menu_theme(*themed_menus, theme=resolved)
        if panel is not None:
            panel.apply_theme(resolved)

    def refresh_desktop_theme() -> None:
        nonlocal theme_refresh_task
        if theme_refresh_task is not None:
            return

        def completed(_task: QtAsyncTask, settings) -> None:
            nonlocal theme_refresh_task
            theme_refresh_task = None
            apply_desktop_theme(
                getattr(settings, "theme", "system"),
                getattr(settings, "custom_theme", None),
            )

        def failed(_error: BaseException) -> None:
            nonlocal theme_refresh_task
            theme_refresh_task = None

        theme_refresh_task = start_qt_task(manager.desktop_settings, completed, on_error=failed)

    def ensure_panel() -> TaskWindow:
        nonlocal panel
        if panel is not None:
            return panel
        panel = TaskWindow(
            app_icon,
            state["resolved_theme"],
            plugin_manager_factory=lambda url: ManagerClient(
                url,
                application_generation_id=application_generation_id,
                manager_instance_id=manager_instance_id,
                extension_registry=desktop_extensions,
            ),
            extension_registry=desktop_extensions,
        )
        panel.refresh_button.clicked.connect(refresh)
        panel.route_selected.connect(lambda item_id: open_panel(_gateway_by_id(state["manager"].gateways, item_id)))
        panel.send_message_requested.connect(lambda text, attachments: _send_role_panel_message(
            manager,
            selected_gateway_id,
            str(text),
            attachments if isinstance(attachments, list) else [],
            panel,
            tray,
            tray_available,
            refresh,
            pending_role_panel_sends,
        ))
        panel.plan_feedback_requested.connect(lambda plan_id, step_id, feedback_id, text: _send_plan_feedback(
            manager,
            selected_gateway_id,
            role_id_from_gateway(_gateway_by_id(state["manager"].gateways, selected_gateway_id), "Rabi"),
            str(plan_id),
            str(step_id),
            str(feedback_id),
            str(text),
            panel,
            tray,
            tray_available,
            refresh,
            pending_plan_feedback_sends,
        ))
        return panel

    def open_panel(gateway: dict | None = None, view_key: str | None = None) -> None:
        nonlocal selected_gateway_id
        if gateway is None:
            gateway = _gateway_by_id(state["manager"].gateways, selected_gateway_id) or state["manager"].selected_gateway
        if gateway is None:
            return
        selected_gateway_id = str(gateway.get("id") or selected_gateway_id)
        active_gateway_id = selected_gateway_id
        active_panel = ensure_panel()
        if view_key is not None:
            active_panel.set_view(view_key)

        def render_selected_gateway() -> None:
            if selected_gateway_id != active_gateway_id:
                return
            role_id = role_id_from_gateway(gateway, "未指定人格")
            if state["loaded_gateway_id"] != active_gateway_id:
                state["plans"], state["context"] = empty_desktop_read_model(state_root, gateway, role_id)
                state["role_messages"] = []
                state["loaded_gateway_id"] = active_gateway_id
            active_panel.set_actions(
                _panel_actions(
                    gateway,
                    state_root,
                    desktop,
                    manager,
                    tray,
                    tray_available,
                    refresh,
                    state["plugin_catalog"],
                    desktop_extensions,
                    execute_plugin_handler,
                )
            )
            _render_panel(
                active_panel,
                state["manager"],
                gateway,
                state["plans"],
                state["context"],
                state["role_messages"],
            )

        _present_panel_immediately(active_panel, render_selected_gateway)
        manager_snapshot = state["manager"]
        QTimer.singleShot(
            0,
            lambda: _run_when_menu_idle(
                menu,
                lambda: _rebuild_persona_chat_menu(
                    menu,
                    persona_actions_end,
                    more_personas_menu,
                    manager_snapshot,
                    active_gateway_id,
                    open_chat,
                ),
            ),
        )
        QTimer.singleShot(0, lambda: refresh(auto=False))

    def open_chat(gateway: dict) -> None:
        try:
            open_panel(gateway, "chat")
        except Exception as error:
            _show_message(
                tray,
                tray_available,
                "RabiRoute / 人格聊天",
                f"无法打开 {route_menu_label(gateway)} 的聊天窗口：{error}",
                QSystemTrayIcon.Warning,
                5000,
            )

    def open_desktop_pet_persona(persona_id: str) -> None:
        gateway = next(
            (item for item in state["manager"].gateways if role_id_from_gateway(item, "") == persona_id),
            None,
        )
        if gateway is None:
            _show_message(
                tray,
                tray_available,
                "虚拟形象",
                f"Manager 当前没有提供 {persona_id} 的人格入口。",
                QSystemTrayIcon.Warning,
                4000,
            )
            return
        open_chat(gateway)

    if desktop_pet_menu is not None:
        feature_context = DesktopFeatureContext(
            manager_url=manager.manager_url,
            application=app,
            desktop_pet_menu=desktop_pet_menu,
            open_desktop_pet_persona=open_desktop_pet_persona,
        )
        for dispose in activate_builtin_features(enabled_features, feature_context):
            app.aboutToQuit.connect(dispose)

    def apply_refresh(result: DesktopRefreshResult, auto: bool) -> None:
        previous_manager = state["manager"]
        previous_plans = state["plans"]
        previous_context = state["context"]
        previous_role_messages = state["role_messages"]
        state["manager"] = result.manager
        lifecycle.observe(state["manager"])
        selected_gateway = result.selected_gateway
        if result.plan_snapshot is not None:
            state["plans"] = result.plan_snapshot
        if result.context_snapshot is not None:
            state["context"] = result.context_snapshot
        if selected_gateway is not None and result.plan_snapshot is not None and result.context_snapshot is not None:
            state["loaded_gateway_id"] = str(selected_gateway.get("id") or "")
        panel_active = _panel_is_active(panel)
        if result.role_messages is not None:
            state["role_messages"] = result.role_messages
        if panel_active and selected_gateway is not None and not (auto and panel.is_user_interacting()):
            panel_changed = (
                _panel_manager_signature(previous_manager) != _panel_manager_signature(state["manager"])
                or previous_plans != state["plans"]
                or previous_context != state["context"]
                or previous_role_messages != state["role_messages"]
            )
            if panel_changed:
                panel.set_actions(_panel_actions(
                    selected_gateway,
                    state_root,
                    desktop,
                    manager,
                    tray,
                    tray_available,
                    refresh,
                    state["plugin_catalog"],
                    desktop_extensions,
                    execute_plugin_handler,
                ))
                _render_panel(
                    panel,
                    state["manager"],
                    selected_gateway,
                    state["plans"],
                    state["context"],
                    state["role_messages"],
                )
        tray.setToolTip(_tooltip(state["manager"], state["plans"]))
        status_action.setText(_status_text(state["manager"]))
        if (
            previous_manager.connected != state["manager"].connected
            or _persona_menu_signature(previous_manager) != _persona_menu_signature(state["manager"])
        ):
            _rebuild_persona_chat_menu(
                menu,
                persona_actions_end,
                more_personas_menu,
                state["manager"],
                selected_gateway_id,
                open_chat,
            )

    def execute_plugin_handler(
        handler_id: str,
        services: dict[str, Callable[[], None]] | None = None,
    ) -> None:
        command_services = {
            "desktop.capture-screenshot": system_screenshot.request_capture,
            "desktop.pin-clipboard-image": system_screenshot.request_clipboard_pin,
            "desktop.system-selection": system_selection.start,
        }
        if services:
            command_services.update(services)
        try:
            desktop_extensions.invoke_command(
                handler_id,
                DesktopCommandContext(
                    manager_url=manager.manager_url,
                    open_url=desktop.open_url,
                    services=command_services,
                ),
            )
        except Exception as error:
            _show_message(
                tray,
                tray_available,
                "插件操作失败",
                str(error) or error.__class__.__name__,
                QSystemTrayIcon.Warning,
                5000,
            )

    def refresh_plugin_catalog() -> None:
        nonlocal plugin_catalog_task
        if plugin_catalog_task is not None:
            return

        def completed(completed_task: QtAsyncTask, catalog: DesktopPluginCatalog) -> None:
            nonlocal plugin_catalog_task
            if plugin_catalog_task is not completed_task:
                return
            def apply_catalog() -> None:
                nonlocal plugin_catalog_task
                if plugin_catalog_task is not completed_task:
                    return
                try:
                    state["plugin_catalog"] = catalog
                    if desktop_extensions.lifecycle_capability_active(catalog, "desktop.system-selection"):
                        system_selection.start()
                    else:
                        system_selection.stop()
                    system_screenshot.set_plugin_hotkeys(
                        _desktop_plugin_hotkeys(catalog, desktop_extensions)
                    )
                    apply_desktop_theme(state["theme"], state["theme_definition"])
                    _rebuild_plugin_menu(
                        menu,
                        plugin_menu,
                        refresh_action,
                        catalog,
                        execute_plugin_handler,
                        desktop_extensions,
                    )
                    selected_gateway = (
                        _gateway_by_id(state["manager"].gateways, selected_gateway_id)
                        or state["manager"].selected_gateway
                    )
                    if _panel_is_active(panel) and selected_gateway is not None:
                        panel.set_actions(_panel_actions(
                            selected_gateway,
                            state_root,
                            desktop,
                            manager,
                            tray,
                            tray_available,
                            refresh,
                            catalog,
                            desktop_extensions,
                            execute_plugin_handler,
                        ))
                    _warm_menu_layout(menu)
                finally:
                    plugin_catalog_task = None

            _run_when_menu_idle(menu, apply_catalog)

        plugin_catalog_task = _start_desktop_plugin_catalog(manager, completed)

    def refresh(auto: bool = False) -> None:
        if not refresh_gate.request(auto):
            return

        def completed(completed_task: QtAsyncTask, result: DesktopRefreshResult) -> None:
            def apply_completed_result() -> None:
                manual_refresh_queued = refresh_gate.completed(completed_task)
                try:
                    apply_refresh(result, auto)
                except Exception as error:
                    _show_message(
                        tray,
                        tray_available,
                        "RabiRoute / 状态刷新",
                        f"状态刷新失败：{error}",
                        QSystemTrayIcon.Warning,
                        5000,
                    )
                finally:
                    if manual_refresh_queued:
                        QTimer.singleShot(0, lambda: refresh(auto=False))

            _run_when_menu_idle(menu, apply_completed_result)

        _start_desktop_refresh(
            refresh_service,
            state["manager"],
            selected_gateway_id,
            _panel_is_active(panel),
            completed,
            refresh_gate.started,
        )

    refresh_action.triggered.connect(refresh)
    refresh_action.triggered.connect(lambda _checked=False: refresh_plugin_catalog())
    webgui_action.triggered.connect(lambda: desktop.open_url(manager.manager_url))
    quit_action.triggered.connect(lambda: _quit(app, tray, tray_available, lifecycle))

    def selection_delivery_targets() -> list[SelectionDeliveryTarget]:
        return active_selection_delivery_targets(state["manager"].gateways, selected_gateway_id)

    def notify_selection_action(title: str, message: str, is_error: bool) -> None:
        _show_message(
            tray,
            tray_available,
            title,
            message,
            QSystemTrayIcon.Warning if is_error else QSystemTrayIcon.Information,
            5000 if is_error else 2200,
        )

    system_selection = SystemSelectionController(
        manager,
        selection_delivery_targets,
        notify_selection_action,
        settings_path=state_root / "data" / "speech" / "selection-reader-settings.json",
    )
    app.aboutToQuit.connect(system_selection.stop)

    system_screenshot = SystemScreenshotController(
        manager,
        state_root,
        selection_delivery_targets,
        notify_selection_action,
        settings_path=state_root / "data" / "desktop" / "settings.json",
        host_executable=host_executable,
        extension_registry=desktop_extensions,
        execute_command=execute_plugin_handler,
    )
    app.aboutToQuit.connect(system_screenshot.stop)
    app.aboutToQuit.connect(_wait_for_background_tasks)
    system_screenshot.start()

    timer = QTimer()

    def refresh_tick() -> None:
        refresh(auto=True)
        refresh_plugin_catalog()
        refresh_desktop_theme()

    timer.timeout.connect(refresh_tick)
    timer.start(10_000)

    apply_desktop_theme("system")
    _prewarm_panel(ensure_panel(), app)
    refresh()
    refresh_plugin_catalog()
    refresh_desktop_theme()
    if tray_available:
        tray.show()
    _show_message(
        tray,
        tray_available,
        "RabiRoute / 当前人格",
        "桌面入口已启动。点击托盘菜单中的人格即可打开聊天。",
        QSystemTrayIcon.Information,
        3000,
    )
    _host_lifecycle_socket = _connect_host_lifecycle(
        app,
        host_lifecycle_pipe,
        application_generation_id,
        manager_instance_id,
    )
    if bool(app.property("rabirouteHostShutdownRequested")):
        QTimer.singleShot(0, app.quit)
    return app.exec()


def _connect_host_lifecycle(
    app: QApplication,
    pipe_name: str,
    application_generation_id: str,
    manager_instance_id: str,
) -> QLocalSocket:
    socket = QLocalSocket(app)
    pending = bytearray()

    def publish_ready() -> None:
        ready = {
            "protocolVersion": 1,
            "applicationGenerationId": application_generation_id,
            "managerInstanceId": manager_instance_id,
            "pid": os.getpid(),
        }
        socket.write(("RABIROUTE_TRAY_READY:" + json.dumps(ready, separators=(",", ":")) + "\n").encode("utf-8"))
        socket.flush()

    def request_shutdown() -> None:
        app.setProperty("rabirouteHostShutdownRequested", True)
        QTimer.singleShot(0, app.quit)

    def receive_commands() -> None:
        pending.extend(bytes(socket.readAll()))
        while b"\n" in pending:
            raw_command, _, remaining = pending.partition(b"\n")
            pending[:] = remaining
            if raw_command.strip().lower() == b"shutdown":
                request_shutdown()
                return

    socket.connected.connect(publish_ready)
    socket.readyRead.connect(receive_commands)
    socket.connectToServer(pipe_name, QIODevice.OpenModeFlag.ReadWrite)
    return socket


def _show_tray_context_menu(menu: QMenu, reason) -> bool:
    return show_tray_menu_for_activation(menu, reason)


def _panel_is_active(panel: TaskWindow | None) -> bool:
    return panel is not None and panel.isVisible()


def _show_panel_for_user_action(panel: TaskWindow) -> None:
    panel.showNormal()
    panel.raise_()
    panel.activateWindow()
    window_handle = panel.windowHandle()
    if window_handle is not None:
        window_handle.requestActivate()


def _present_panel_immediately(panel: TaskWindow, render_callback) -> None:
    _show_panel_for_user_action(panel)
    QTimer.singleShot(0, render_callback)


def _prewarm_panel(panel: TaskWindow, app: QApplication) -> None:
    """Pay the first native QWidget layout cost before the tray becomes clickable."""
    previous_opacity = panel.windowOpacity()
    show_without_activating = panel.testAttribute(Qt.WA_ShowWithoutActivating)
    panel.setAttribute(Qt.WA_ShowWithoutActivating, True)
    panel.setWindowOpacity(0.0)
    panel.showNormal()
    app.processEvents(QEventLoop.ExcludeUserInputEvents)
    panel.hide()
    app.processEvents(QEventLoop.ExcludeUserInputEvents)
    panel.setWindowOpacity(previous_opacity)
    panel.setAttribute(Qt.WA_ShowWithoutActivating, show_without_activating)


def _run_when_menu_idle(menu: QMenu, callback, retry_ms: int = 25) -> None:
    if menu.isVisible():
        QTimer.singleShot(retry_ms, lambda: _run_when_menu_idle(menu, callback, retry_ms))
        return
    callback()


def _desktop_plugin_hotkeys(
    catalog: DesktopPluginCatalog,
    registry: DesktopExtensionRegistry,
) -> tuple[DesktopPluginHotkey, ...]:
    return tuple(item for item in catalog.hotkeys if registry.has_hotkey_contract(item))


def _desktop_plugin_theme(
    catalog: DesktopPluginCatalog,
    requested_theme: object,
    registry: DesktopExtensionRegistry,
) -> DesktopPluginTheme | None:
    theme_id = requested_theme if isinstance(requested_theme, str) else "system"
    return next(
        (
            item for item in catalog.themes
            if item.theme_id == theme_id
            and registry.has_theme_resource(
                item.theme_id, item.desktop_resource_id, item.plugin_id, item.instance_id
            )
        ),
        None,
    )


def _rebuild_plugin_menu(
    root_menu: QMenu,
    plugin_menu: QMenu,
    insert_before: QAction,
    catalog: DesktopPluginCatalog,
    execute_handler,
    registry: DesktopExtensionRegistry,
) -> None:
    items = tuple(
        item for item in catalog.menu_items
        if item.handler_id not in FIXED_TRAY_COMMAND_HANDLER_IDS
        if registry.has_command_handler(item.handler_id, item.plugin_id, item.instance_id)
    )
    signature = tuple(
        (item.plugin_id, item.instance_id, item.contribution_id, item.handler_id, item.label)
        for item in items
    )
    menu_action = plugin_menu.menuAction()
    is_inserted = menu_action in root_menu.actions()
    if signature == getattr(plugin_menu, "_rabiroute_plugin_signature", ()) and is_inserted == bool(items):
        return
    root_menu.removeAction(menu_action)
    plugin_menu.clear()
    plugin_menu._rabiroute_plugin_signature = signature
    for item in items:
        action = plugin_menu.addAction(item.label)
        action.setObjectName(f"rabiroutePluginAction:{item.contribution_id}")
        action.triggered.connect(
            lambda checked=False, handler_id=item.handler_id: execute_handler(handler_id)
        )
    if items:
        root_menu.insertMenu(insert_before, plugin_menu)


def _quit(
    app: QApplication,
    tray: QSystemTrayIcon,
    tray_available: bool,
    lifecycle: LifecycleController,
) -> None:
    if bool(app.property("rabirouteQuitPending")):
        return
    app.setProperty("rabirouteQuitPending", True)
    _show_message(
        tray,
        tray_available,
        "RabiRoute / 当前人格",
        "正在退出 RabiRoute...",
        QSystemTrayIcon.Information,
        2500,
    )
    def completed(_task: QtAsyncTask, quit_requested: bool) -> None:
        if not quit_requested:
            app.setProperty("rabirouteQuitPending", False)
            _show_message(
                tray,
                tray_available,
                "RabiRoute / 当前人格",
                "RabiRoute Host 未接受退出请求，桌面入口保持运行。请检查 Host 状态后再退出。",
                QSystemTrayIcon.Warning,
                5000,
            )
            return
        app.quit()

    _start_application_quit(lifecycle, completed)


def _show_message(tray: QSystemTrayIcon, tray_available: bool, title: str, message: str, icon, timeout: int) -> None:
    if tray_available:
        tray.showMessage(title, message, icon, timeout)


def _render_panel(
    panel: TaskWindow,
    manager_snapshot: ManagerSnapshot,
    gateway: dict,
    plan_snapshot,
    context_snapshot,
    role_messages: list[dict],
) -> None:
    panel.render(manager_snapshot, gateway, plan_snapshot, context_snapshot, role_messages)


def _send_role_panel_message(
    manager: ManagerClient,
    gateway_id: str,
    text: str,
    attachments: list[dict],
    panel: TaskWindow,
    tray: QSystemTrayIcon,
    tray_available: bool,
    refresh_callback,
    pending_tasks: set[QtAsyncTask],
) -> None:
    if not gateway_id:
        _show_message(tray, tray_available, "RabiRoute", "请先选择一条航线。", QSystemTrayIcon.Warning, 2500)
        return
    panel.set_message_send_pending(True)

    def completed(completed_task: QtAsyncTask, result) -> None:
        pending_tasks.discard(completed_task)
        panel.complete_message_send(bool(result.ok))
        if result.ok:
            _show_message(tray, tray_available, "角色面板", "消息已发送给 Agent。", QSystemTrayIcon.Information, 1800)
            refresh_callback()
            return
        detail = f"\n{result.message}" if result.message else ""
        _show_message(tray, tray_available, "角色面板", f"发送失败。{detail}", QSystemTrayIcon.Warning, 5000)

    _start_role_panel_send(manager, gateway_id, text, attachments, completed, pending_tasks.add)


def _send_plan_feedback(
    manager: ManagerClient,
    gateway_id: str,
    role_id: str,
    plan_id: str,
    step_id: str,
    feedback_id: str,
    text: str,
    panel: TaskWindow,
    tray: QSystemTrayIcon,
    tray_available: bool,
    refresh_callback,
    pending_tasks: set[QtAsyncTask],
) -> None:
    if not gateway_id or not role_id or not plan_id:
        panel.complete_plan_feedback(plan_id, False, "当前计划缺少可用的 Route 或人格绑定。", "error")
        return
    panel.set_plan_feedback_pending(plan_id, True)

    def completed(completed_task: QtAsyncTask, result: PlanFeedbackSubmitResult) -> None:
        pending_tasks.discard(completed_task)
        if result.ok:
            pending = result.delivery_status == "pending"
            message = "审批建议已记录，正在后台通知 Agent。" if pending else "审批建议已记录并交给 Agent 处理。"
            panel.complete_plan_feedback(plan_id, True, message, "success")
            _show_message(tray, tray_available, "计划审批", message, QSystemTrayIcon.Information, 2200)
            refresh_callback()
            return
        if result.delivery_status == "failed":
            detail = f" {result.message}" if result.message else ""
            panel.complete_plan_feedback(
                plan_id,
                False,
                f"审批建议已记录，但通知 Agent 失败；请确认计划当前状态后再提交新建议。{detail}",
                "warning",
                retire=True,
            )
            return
        if result.uncertain:
            detail = f" {result.message}" if result.message else ""
            panel.complete_plan_feedback(
                plan_id,
                False,
                f"提交结果尚未确认；已保留同一提交标识，恢复连接后可安全重试。{detail}",
                "warning",
            )
            return
        if result.revision_conflict:
            panel.complete_plan_feedback(
                plan_id,
                False,
                "计划已更新，正在重新读取当前版本；确认内容后将创建新的版本化提交。",
                "warning",
                retire=True,
            )
            refresh_callback()
            return
        panel.complete_plan_feedback(plan_id, False, result.message or "审批建议提交失败。", "error")

    _start_plan_feedback_send(
        manager,
        role_id,
        plan_id,
        gateway_id,
        step_id,
        feedback_id,
        text,
        completed,
        pending_tasks.add,
    )


def _panel_actions(
    gateway: dict,
    state_root: Path,
    desktop: DesktopAdapter,
    manager: ManagerClient,
    tray: QSystemTrayIcon,
    tray_available: bool,
    refresh_callback,
    catalog: DesktopPluginCatalog,
    registry: DesktopExtensionRegistry,
    execute_handler,
) -> list[tuple[str, object, bool]]:
    role_id = role_id_from_gateway(gateway, "未指定人格")
    role_dir = role_dir_from_gateway(state_root, gateway, role_id)
    services = {
        "desktop.open-role-directory": lambda: desktop.open_path(role_dir),
        "desktop.open-plan-directory": lambda: desktop.open_path(role_dir / "plans"),
        "desktop.open-memory-directory": lambda: desktop.open_path(role_dir / "memory"),
        "desktop.open-project-directory": lambda: desktop.open_path(project_dir_from_gateway(state_root, gateway)),
        "desktop.open-runtime-directory": lambda: desktop.open_path(runtime_dir_from_gateway(state_root, gateway)),
    }
    manual_actions: list[DesktopPanelAction] = []
    for index, rule in enumerate(_manual_trigger_rules(gateway)):
        rule_name = str(rule.get("name") or rule.get("id") or "未命名手动规则")
        rule_id = str(rule.get("id") or rule_name)
        route_kind = _manual_trigger_route_kind(rule)
        enabled = rule.get("enabled") is not False
        manual_actions.append(DesktopPanelAction(
            f"触发：{rule_name}",
            lambda item=gateway, rid=rule_id, name=rule_name, kind=route_kind: _manual_trigger(
                manager,
                item,
                rid,
                name,
                kind,
                _manual_trigger_message(name, rid),
                tray,
                tray_available,
                refresh_callback,
            ),
            enabled,
            index,
        ))
    context = DesktopPanelActionContext(
        invoke=lambda handler_id: execute_handler(handler_id, services),
        action_groups={"desktop.manual-trigger": tuple(manual_actions)},
    )
    return [
        (
            action.label,
            lambda checked=False, callback=action.callback: callback(),
            action.enabled,
        )
        for action in registry.panel_actions(catalog, context)
    ]


def _rebuild_persona_chat_menu(
    menu: QMenu,
    insert_before: QAction,
    more_personas_menu: QMenu,
    manager_snapshot: ManagerSnapshot,
    selected_gateway_id: str,
    open_chat_callback,
) -> None:
    for action in getattr(menu, "_rabiroute_persona_chat_actions", []):
        menu.removeAction(action)
        action.deleteLater()
    menu.removeAction(more_personas_menu.menuAction())
    more_personas_menu.clear()
    more_personas_menu._rabiroute_pending_personas = []
    more_personas_menu._rabiroute_open_chat_callback = open_chat_callback
    if not getattr(more_personas_menu, "_rabiroute_lazy_population_connected", False):
        more_personas_menu.aboutToShow.connect(lambda: _populate_more_personas_menu(more_personas_menu))
        more_personas_menu._rabiroute_lazy_population_connected = True

    direct_actions: list[QAction] = []
    if not manager_snapshot.connected:
        offline_action = QAction("Manager 离线，无法读取人格")
        offline_action.setEnabled(False)
        menu.insertAction(insert_before, offline_action)
        menu._rabiroute_persona_chat_actions = [offline_action]
        _warm_menu_layout(menu)
        return
    if not manager_snapshot.gateways:
        empty_action = QAction("暂无可用的人格航线")
        empty_action.setEnabled(False)
        menu.insertAction(insert_before, empty_action)
        menu._rabiroute_persona_chat_actions = [empty_action]
        _warm_menu_layout(menu)
        return

    selected_gateway = _gateway_by_id(manager_snapshot.gateways, selected_gateway_id) or manager_snapshot.selected_gateway
    gateways = list(manager_snapshot.gateways)
    if selected_gateway is not None:
        selected_id = str(selected_gateway.get("id") or "")
        gateways.sort(key=lambda gateway: 0 if str(gateway.get("id") or "") == selected_id else 1)

    for index, gateway in enumerate(gateways):
        is_selected = gateway is selected_gateway or (
            selected_gateway is not None and str(gateway.get("id") or "") == str(selected_gateway.get("id") or "")
        )
        label = route_menu_label(gateway)
        action_text = f"继续聊天 · {label}" if is_selected else label
        if index >= MAX_DIRECT_PERSONA_CHATS:
            continue
        action = _action(
            action_text,
            menu,
            lambda checked=False, item=gateway: open_chat_callback(item),
        )
        action.setIcon(_route_state_icon(route_state(gateway)))
        action.setToolTip(_route_label(gateway))
        menu.insertAction(insert_before, action)
        direct_actions.append(action)

    overflow_gateways = gateways[MAX_DIRECT_PERSONA_CHATS:]
    if overflow_gateways:
        more_personas_menu._rabiroute_pending_personas = overflow_gateways
        loading_action = more_personas_menu.addAction("展开以加载更多人格")
        loading_action.setEnabled(False)
        menu.insertMenu(insert_before, more_personas_menu)
    menu._rabiroute_persona_chat_actions = direct_actions
    _warm_menu_layout(menu)


def _persona_menu_signature(manager_snapshot: ManagerSnapshot) -> tuple:
    return tuple(
        (
            str(gateway.get("id") or ""),
            route_menu_label(gateway),
            route_state(gateway),
            _route_label(gateway),
        )
        for gateway in manager_snapshot.gateways
    )


def _panel_manager_signature(manager_snapshot: ManagerSnapshot) -> tuple:
    return (
        manager_snapshot.connected,
        manager_snapshot.manager_url,
        manager_snapshot.error,
        tuple(
            (
                str(gateway.get("id") or ""),
                route_status_label(gateway),
            )
            for gateway in manager_snapshot.gateways
        ),
    )


def _populate_more_personas_menu(more_personas_menu: QMenu) -> None:
    gateways = getattr(more_personas_menu, "_rabiroute_pending_personas", [])
    if not gateways:
        return
    open_chat_callback = getattr(more_personas_menu, "_rabiroute_open_chat_callback", None)
    more_personas_menu._rabiroute_pending_personas = []
    more_personas_menu.clear()
    for gateway in gateways:
        action = _action(
            route_menu_label(gateway),
            more_personas_menu,
            lambda checked=False, item=gateway: open_chat_callback(item),
        )
        action.setIcon(_route_state_icon(route_state(gateway)))
        action.setToolTip(_route_label(gateway))
        more_personas_menu.addAction(action)
    _warm_menu_layout(more_personas_menu)


def _warm_menu_layout(menu: QMenu):
    menu.ensurePolished()
    size = menu.sizeHint()
    menu.winId()
    return size


def _route_state_icon(state: str) -> QIcon:
    cached_icon = _ROUTE_STATE_ICONS.get(state)
    if cached_icon is not None:
        return cached_icon
    colors = {
        "running": "#16a34a",
        "stopped": "#eab308",
        "disabled": "#94a3b8",
    }
    pixmap = QPixmap(16, 16)
    pixmap.fill(Qt.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.Antialiasing)
    painter.setBrush(QColor(colors.get(state, "#94a3b8")))
    painter.setPen(Qt.NoPen)
    painter.drawEllipse(3, 3, 10, 10)
    painter.end()
    icon = QIcon(pixmap)
    _ROUTE_STATE_ICONS[state] = icon
    return icon


def _action(text: str, parent, callback) -> QAction:
    action = QAction(text, parent)
    action.triggered.connect(callback)
    return action


def _manual_trigger_rules(gateway: dict) -> list[dict]:
    rules = gateway.get("notificationRules")
    if not isinstance(rules, list):
        return []
    result = []
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        route_kinds = rule.get("routeKinds")
        if isinstance(route_kinds, list) and ("manual_trigger" in route_kinds or "heartbeat" in route_kinds):
            result.append(rule)
    return result


def _manual_trigger_route_kind(rule: dict) -> str:
    route_kinds = rule.get("routeKinds")
    if isinstance(route_kinds, list) and "manual_trigger" in route_kinds:
        return "manual_trigger"
    return "heartbeat"


def _manual_trigger_message(trigger_name: str, trigger_id: str) -> str:
    return f"手动触发：{trigger_name} ({trigger_id})。请按这条手动触发规则的模板执行。"


def _manual_trigger(
    manager: ManagerClient,
    gateway: dict,
    trigger_id: str,
    trigger_name: str,
    route_kind: str,
    message: str,
    tray: QSystemTrayIcon,
    tray_available: bool,
    refresh_callback,
) -> None:
    gateway_id = str(gateway.get("id") or "")
    if not gateway_id:
        _show_message(tray, tray_available, "RabiRoute", "这条航线没有可触发的 ID。", QSystemTrayIcon.Warning, 2500)
        return
    def completed(_task: QtAsyncTask, result: ManualTriggerResult) -> None:
        if result.ok:
            _show_message(tray, tray_available, "RabiRoute", f"已触发 {trigger_name}：{_gateway_label(gateway)}", QSystemTrayIcon.Information, 2500)
            refresh_callback()
            return
        detail = f"\n{result.message}" if result.message else ""
        _show_message(tray, tray_available, "RabiRoute", f"{trigger_name} 触发失败：{_gateway_label(gateway)}{detail}", QSystemTrayIcon.Warning, 5000)

    _start_manual_trigger(
        manager,
        gateway_id,
        trigger_id,
        trigger_name,
        message,
        route_kind,
        completed,
    )


def _gateway_label(gateway: dict, role_id: str | None = None) -> str:
    if role_id:
        running = "运行中" if gateway.get("running") else "已停止"
        return f"{route_menu_label(gateway)} / {running}"
    return route_status_label(gateway)


def _route_label(gateway: dict) -> str:
    return route_status_label(gateway)


def _tooltip(manager_snapshot, plan_snapshot) -> str:
    current_count = len(plan_snapshot.current)
    active_count = len(plan_snapshot.active)
    manager_text = "已连接" if manager_snapshot.connected else "离线"
    warning = "\nGateway 状态：刷新失败，显示上次结果" if manager_snapshot.error and manager_snapshot.gateways else ""
    return f"RabiRoute / {plan_snapshot.role_id}\nManager：{manager_text}\n进行中计划：{current_count}\n未归档计划：{active_count}{warning}"


def _status_text(manager_snapshot) -> str:
    if not manager_snapshot.connected:
        return "状态：Manager 离线"
    if manager_snapshot.error and manager_snapshot.gateways:
        return "状态：Manager 已连接 / Gateway 刷新失败（显示上次结果）"
    gateway = manager_snapshot.selected_gateway
    if not gateway:
        return "状态：Manager 已连接 / 无 gateway"
    running = "运行中" if gateway.get("running") else "已停止"
    return f"状态：Manager 已连接 / Gateway {running}"
