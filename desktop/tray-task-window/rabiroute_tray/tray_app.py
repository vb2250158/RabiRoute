from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import QDir, QLockFile, QTimer, Qt
from PySide6.QtGui import QAction, QColor, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

from .app_paths import project_dir_from_gateway, role_dir_from_gateway, role_id_from_gateway, runtime_dir_from_gateway
from .desktop_adapter import DesktopAdapter
from .display_helpers import route_enabled_label, route_menu_label, route_running_label, route_state, route_status_label
from .lifecycle_controller import LifecycleController
from .manager_client import ManagerClient, ManagerSnapshot
from .role_context_repository import RoleContextRepository
from .task_repository import PlanRepository
from .task_window import TaskWindow


def run(
    project_root: Path,
    manager_url: str = "http://127.0.0.1:8790",
    manager_proc: "subprocess.Popen[bytes] | None" = None,
) -> int:
    app = QApplication(sys.argv)
    lock = _app_lock(project_root)
    if not lock.tryLock(100):
        print(
            "这个项目的 RabiRoute Qt 计划与记忆面板已经在运行。\n"
            "请使用现有托盘图标或窗口，不要重复启动。",
            file=sys.stderr,
        )
        return 0

    tray_available = QSystemTrayIcon.isSystemTrayAvailable()
    app.setQuitOnLastWindowClosed(not tray_available)

    manager = ManagerClient(manager_url=manager_url)
    lifecycle = LifecycleController(manager=manager)
    desktop = DesktopAdapter(project_root)
    plans = PlanRepository(project_root, "Rabi")
    role_context = RoleContextRepository(project_root)
    app_icon = desktop.app_icon()

    tray = QSystemTrayIcon(app_icon, app)
    tray.setToolTip("RabiRoute / Rabi 桌面分诊台")

    refresh_action = QAction("刷新")
    webgui_action = QAction("打开 RabiRoute WebGUI")
    status_action = QAction("状态：加载中")
    routes_menu = QMenu("航线")
    quit_action = QAction(lifecycle.exit_label)
    status_action.setEnabled(False)

    menu = QMenu()
    menu.addAction(status_action)
    menu.addSeparator()
    menu.addAction(webgui_action)
    menu.addAction(refresh_action)
    menu.addSeparator()
    menu.addMenu(routes_menu)
    menu.addSeparator()
    menu.addAction(quit_action)
    tray.setContextMenu(menu)

    initial_manager = manager.snapshot()
    panel: TaskWindow | None = None
    selected_gateway_id = str(initial_manager.selected_gateway.get("id") or "") if initial_manager.selected_gateway else ""
    initial_role_id = role_id_from_gateway(initial_manager.selected_gateway)
    initial_role_dir = role_dir_from_gateway(project_root, initial_manager.selected_gateway, initial_role_id)
    initial_route_dir = runtime_dir_from_gateway(project_root, initial_manager.selected_gateway)
    state = {
        "manager": initial_manager,
        "plans": plans.load(initial_role_dir, initial_role_id),
        "context": role_context.load(initial_role_dir, initial_route_dir),
    }
    lifecycle.observe(initial_manager)

    def open_panel(gateway: dict | None = None) -> None:
        nonlocal panel, selected_gateway_id
        if gateway is None:
            gateway = _gateway_by_id(state["manager"].gateways, selected_gateway_id) or state["manager"].selected_gateway
        if gateway is None:
            return
        selected_gateway_id = str(gateway.get("id") or selected_gateway_id)
        role_id = role_id_from_gateway(gateway, "未指定人格")
        role_dir = role_dir_from_gateway(project_root, gateway, role_id)
        route_dir = runtime_dir_from_gateway(project_root, gateway)
        if panel is None:
            panel = TaskWindow(app_icon)
            panel.refresh_button.clicked.connect(refresh)
            panel.route_selected.connect(lambda item_id: open_panel(_gateway_by_id(state["manager"].gateways, item_id)))
            panel.send_message_requested.connect(lambda text, attachments: _send_role_panel_message(
                manager,
                selected_gateway_id,
                str(text),
                attachments if isinstance(attachments, list) else [],
                tray,
                tray_available,
                refresh,
            ))
        panel.set_actions(_panel_actions(gateway, project_root, desktop, manager, tray, tray_available, refresh))
        _render_panel(
            panel,
            state["manager"],
            gateway,
            plans.load(role_dir, role_id),
            role_context.load(role_dir, route_dir),
            manager.role_panel_messages(role_id),
        )
        panel.show()
        panel.raise_()
        panel.activateWindow()

    def refresh(auto: bool = False) -> None:
        state["manager"] = manager.snapshot()
        if lifecycle.observe(state["manager"]):
            status_action.setText("状态：Manager 已离线，正在退出 RabiRoute 桌面入口")
            _show_message(
                tray,
                tray_available,
                "RabiRoute / 当前人格",
                "RabiRoute manager 已离线，桌面入口将退出。",
                QSystemTrayIcon.Warning,
                3000,
            )
            QTimer.singleShot(1500, app.quit)
        selected_gateway = _gateway_by_id(state["manager"].gateways, selected_gateway_id) or state["manager"].selected_gateway
        role_id = role_id_from_gateway(selected_gateway)
        role_dir = role_dir_from_gateway(project_root, selected_gateway, role_id)
        route_dir = runtime_dir_from_gateway(project_root, selected_gateway)
        state["plans"] = plans.load(role_dir, role_id)
        state["context"] = role_context.load(role_dir, route_dir)
        if panel is not None and selected_gateway is not None and not (auto and panel.is_user_interacting()):
            panel_role_id = role_id_from_gateway(selected_gateway, "未指定人格")
            panel_role_dir = role_dir_from_gateway(project_root, selected_gateway, panel_role_id)
            panel_route_dir = runtime_dir_from_gateway(project_root, selected_gateway)
            panel.set_actions(_panel_actions(selected_gateway, project_root, desktop, manager, tray, tray_available, refresh))
            _render_panel(
                panel,
                state["manager"],
                selected_gateway,
                plans.load(panel_role_dir, panel_role_id),
                role_context.load(panel_role_dir, panel_route_dir),
                manager.role_panel_messages(panel_role_id),
            )
        tray.setToolTip(_tooltip(state["manager"], state["plans"]))
        status_action.setText(_status_text(state["manager"]))
        _rebuild_routes_menu(routes_menu, state["manager"], open_panel)

    refresh_action.triggered.connect(refresh)
    webgui_action.triggered.connect(lambda: desktop.open_url(manager.manager_url))
    quit_action.triggered.connect(lambda: _quit(app, tray, tray_available, lifecycle, manager_proc))

    timer = QTimer()
    timer.timeout.connect(lambda: refresh(auto=True))
    timer.start(10_000)

    refresh()
    if tray_available:
        tray.show()
    _show_message(
        tray,
        tray_available,
        "RabiRoute / 当前人格",
        "桌面入口已启动。请从托盘菜单的“航线”选择人格。",
        QSystemTrayIcon.Information,
        3000,
    )
    try:
        return app.exec()
    finally:
        lock.unlock()


def _app_lock(project_root: Path) -> QLockFile:
    lock_dir = Path(QDir.tempPath()) / "rabiroute"
    lock_dir.mkdir(parents=True, exist_ok=True)
    project_key = str(project_root.resolve()).replace("\\", "_").replace("/", "_").replace(":", "")
    lock = QLockFile(str(lock_dir / f"{project_key}.tray.lock"))
    lock.setStaleLockTime(30_000)
    return lock


def _quit(
    app: QApplication,
    tray: QSystemTrayIcon,
    tray_available: bool,
    lifecycle: LifecycleController,
    manager_proc: "subprocess.Popen[bytes] | None" = None,
) -> None:
    _show_message(
        tray,
        tray_available,
        "RabiRoute / 当前人格",
        "正在退出 RabiRoute...",
        QSystemTrayIcon.Information,
        2500,
    )
    shutdown_requested = lifecycle.request_exit()
    if manager_proc is not None and manager_proc.poll() is None:
        # HTTP shutdown may be slow or fail for the manager started by this process.
        manager_proc.terminate()
        shutdown_requested = True
    if not shutdown_requested:
        _show_message(
            tray,
            tray_available,
            "RabiRoute / 当前人格",
            "未能关闭 RabiRoute manager，桌面入口保持运行。请检查 manager 状态后再退出。",
            QSystemTrayIcon.Warning,
            5000,
        )
        return
    app.quit()


def _show_message(tray: QSystemTrayIcon, tray_available: bool, title: str, message: str, icon, timeout: int) -> None:
    if tray_available:
        tray.showMessage(title, message, icon, timeout)


def _gateway_by_id(gateways: list[dict], gateway_id: str) -> dict | None:
    if not gateway_id:
        return None
    for gateway in gateways:
        if str(gateway.get("id") or "") == gateway_id:
            return gateway
    return None


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
    tray: QSystemTrayIcon,
    tray_available: bool,
    refresh_callback,
) -> None:
    if not gateway_id:
        _show_message(tray, tray_available, "RabiRoute", "请先选择一条航线。", QSystemTrayIcon.Warning, 2500)
        return
    result = manager.send_role_panel_message(gateway_id, text, attachments)
    if result.ok:
        _show_message(tray, tray_available, "角色面板", "消息已发送给 Agent。", QSystemTrayIcon.Information, 1800)
        refresh_callback()
    else:
        detail = f"\n{result.message}" if result.message else ""
        _show_message(tray, tray_available, "角色面板", f"发送失败。{detail}", QSystemTrayIcon.Warning, 5000)


def _panel_actions(
    gateway: dict,
    project_root: Path,
    desktop: DesktopAdapter,
    manager: ManagerClient,
    tray: QSystemTrayIcon,
    tray_available: bool,
    refresh_callback,
) -> list[tuple[str, object, bool]]:
    role_id = role_id_from_gateway(gateway, "未指定人格")
    role_dir = role_dir_from_gateway(project_root, gateway, role_id)
    actions: list[tuple[str, object, bool]] = [
        ("人格目录", lambda checked=False: desktop.open_path(role_dir), True),
        ("计划目录", lambda checked=False: desktop.open_path(role_dir / "plans"), True),
        ("记忆目录", lambda checked=False: desktop.open_path(role_dir / "memory"), True),
        ("项目目录", lambda checked=False: desktop.open_path(project_dir_from_gateway(project_root, gateway)), True),
        ("状态目录", lambda checked=False: desktop.open_path(runtime_dir_from_gateway(project_root, gateway)), True),
    ]
    rules = _manual_trigger_rules(gateway)
    if rules:
        for rule in rules:
            rule_name = str(rule.get("name") or rule.get("id") or "未命名手动规则")
            rule_id = str(rule.get("id") or rule_name)
            route_kind = _manual_trigger_route_kind(rule)
            enabled = rule.get("enabled") is not False
            actions.append((
                f"触发：{rule_name}",
                lambda checked=False, item=gateway, rid=rule_id, name=rule_name, kind=route_kind: _manual_trigger(
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
            ))
    else:
        actions.append(("暂无手动触发", lambda checked=False: None, False))
    return actions


def _rebuild_routes_menu(
    routes_menu: QMenu,
    manager_snapshot,
    open_panel_callback,
) -> None:
    routes_menu.clear()
    if not manager_snapshot.connected:
        offline_action = QAction("Manager 离线，无法读取航线")
        offline_action.setEnabled(False)
        routes_menu.addAction(offline_action)
        return
    if not manager_snapshot.gateways:
        empty_action = QAction("暂无航线")
        empty_action.setEnabled(False)
        routes_menu.addAction(empty_action)
        return

    menu_refs = []
    for gateway in manager_snapshot.gateways:
        action = _action(_route_menu_text(gateway), routes_menu, lambda checked=False, item=gateway: open_panel_callback(item))
        action.setIcon(_route_state_icon(route_state(gateway)))
        action.setToolTip(_route_label(gateway))
        routes_menu.addAction(action)

    routes_menu._rabiroute_menu_refs = menu_refs


def _route_menu_text(gateway: dict) -> str:
    return f"{route_menu_label(gateway)} · {route_enabled_label(gateway)} / {route_running_label(gateway)}"


def _route_state_icon(state: str) -> QIcon:
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
    return QIcon(pixmap)


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
    result = manager.manual_trigger(gateway_id, trigger_id, trigger_name, message, route_kind, trigger_id)
    if result.ok:
        _show_message(tray, tray_available, "RabiRoute", f"已触发 {trigger_name}：{_gateway_label(gateway)}", QSystemTrayIcon.Information, 2500)
        refresh_callback()
    else:
        detail = f"\n{result.message}" if result.message else ""
        _show_message(tray, tray_available, "RabiRoute", f"{trigger_name} 触发失败：{_gateway_label(gateway)}{detail}", QSystemTrayIcon.Warning, 5000)


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
    return f"RabiRoute / {plan_snapshot.role_id}\nManager：{manager_text}\n进行中计划：{current_count}\n未归档计划：{active_count}"


def _status_text(manager_snapshot) -> str:
    if not manager_snapshot.connected:
        return "状态：Manager 离线"
    gateway = manager_snapshot.selected_gateway
    if not gateway:
        return "状态：Manager 已连接 / 无 gateway"
    running = "运行中" if gateway.get("running") else "已停止"
    return f"状态：Manager 已连接 / Gateway {running}"
