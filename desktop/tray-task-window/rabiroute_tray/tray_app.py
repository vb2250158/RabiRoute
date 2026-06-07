from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import QDir, QLockFile, QTimer
from PySide6.QtGui import QAction
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

from .app_paths import project_dir_from_gateway, role_dir_from_gateway, role_id_from_gateway, runtime_dir_from_gateway
from .desktop_adapter import DesktopAdapter
from .lifecycle_controller import LifecycleController
from .manager_client import ManagerClient
from .role_context_repository import RoleContextRepository
from .task_repository import TaskRepository
from .task_window import TaskWindow


def run(
    project_root: Path,
    manager_url: str = "http://127.0.0.1:8790",
    owns_manager: bool = False,
    manager_proc: "subprocess.Popen[bytes] | None" = None,
) -> int:
    app = QApplication(sys.argv)
    lock = _app_lock(project_root)
    if not lock.tryLock(100):
        print(
            "这个项目的 RabiRoute Qt 任务面板已经在运行。\n"
            "请使用现有托盘图标或窗口，不要重复启动。",
            file=sys.stderr,
        )
        return 0

    tray_available = QSystemTrayIcon.isSystemTrayAvailable()
    app.setQuitOnLastWindowClosed(not tray_available)

    manager = ManagerClient(manager_url=manager_url)
    lifecycle = LifecycleController(manager=manager, owns_manager=owns_manager)
    desktop = DesktopAdapter(project_root)
    tasks = TaskRepository(project_root, "Rabi")
    role_context = RoleContextRepository(project_root)
    window = TaskWindow()

    tray = QSystemTrayIcon(desktop.app_icon(), app)
    tray.setToolTip("RabiRoute / Rabi 桌面分诊台")

    refresh_action = QAction("刷新")
    webgui_action = QAction("打开 RabiRoute WebGUI")
    window_action = QAction("显示 Rabi 桌面面板")
    status_action = QAction("状态：加载中")
    routes_menu = QMenu("航线")
    quit_action = QAction(lifecycle.exit_label)
    status_action.setEnabled(False)

    menu = QMenu()
    menu.addAction(status_action)
    menu.addSeparator()
    menu.addAction(webgui_action)
    menu.addAction(window_action)
    menu.addAction(refresh_action)
    menu.addSeparator()
    menu.addMenu(routes_menu)
    menu.addSeparator()
    menu.addAction(quit_action)
    tray.setContextMenu(menu)

    initial_manager = manager.snapshot()
    initial_role_id = role_id_from_gateway(initial_manager.selected_gateway)
    initial_role_dir = role_dir_from_gateway(project_root, initial_manager.selected_gateway, initial_role_id)
    initial_route_dir = runtime_dir_from_gateway(project_root, initial_manager.selected_gateway)
    state = {
        "manager": initial_manager,
        "tasks": tasks.load(initial_role_dir, initial_role_id),
        "context": role_context.load(initial_role_dir, initial_route_dir),
    }
    lifecycle.observe(initial_manager)

    def refresh() -> None:
        state["manager"] = manager.snapshot()
        if lifecycle.observe(state["manager"]):
            status_action.setText("状态：Manager 已离线，正在退出面板")
            _show_message(
                tray,
                tray_available,
                "RabiRoute / 当前人格",
                "RabiRoute manager 已离线，任务面板将退出。",
                QSystemTrayIcon.Warning,
                3000,
            )
            QTimer.singleShot(1500, app.quit)
        role_id = role_id_from_gateway(state["manager"].selected_gateway)
        role_dir = role_dir_from_gateway(project_root, state["manager"].selected_gateway, role_id)
        route_dir = runtime_dir_from_gateway(project_root, state["manager"].selected_gateway)
        state["tasks"] = tasks.load(role_dir, role_id)
        state["context"] = role_context.load(role_dir, route_dir)
        window.render(state["manager"], state["tasks"], state["context"])
        tray.setToolTip(_tooltip(state["manager"], state["tasks"]))
        status_action.setText(_status_text(state["manager"]))
        _rebuild_routes_menu(routes_menu, state["manager"], project_root, desktop, manager, tray, tray_available, refresh)

    def toggle_window() -> None:
        refresh()
        if window.isVisible():
            window.hide()
            window_action.setText("显示 Rabi 桌面面板")
        else:
            window.show()
            window.raise_()
            window_action.setText("隐藏 Rabi 桌面面板")

    refresh_action.triggered.connect(refresh)
    webgui_action.triggered.connect(lambda: desktop.open_url(manager.manager_url))
    window_action.triggered.connect(toggle_window)
    quit_action.triggered.connect(lambda: _quit(app, tray, tray_available, lifecycle, manager_proc))
    window.refresh_button.clicked.connect(refresh)
    tray.activated.connect(lambda reason: toggle_window() if reason == QSystemTrayIcon.Trigger else None)

    timer = QTimer()
    timer.timeout.connect(refresh)
    timer.start(10_000)

    refresh()
    if tray_available:
        tray.show()
    window.show()
    window.raise_()
    window.activateWindow()
    window_action.setText("隐藏 Rabi 桌面面板")
    _show_message(
        tray,
        tray_available,
        "RabiRoute / 当前人格",
        "桌面分诊面板已启动。点击托盘图标可显示或隐藏。",
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
    if lifecycle.owns_manager:
        _show_message(
            tray,
            tray_available,
            "RabiRoute / 当前人格",
            "正在关闭 RabiRoute manager 和任务面板...",
            QSystemTrayIcon.Information,
            2500,
        )
        lifecycle.request_exit()
        # Always terminate the proc directly — HTTP shutdown may be slow or fail.
        if manager_proc is not None and manager_proc.poll() is None:
            manager_proc.terminate()
    app.quit()


def _show_message(tray: QSystemTrayIcon, tray_available: bool, title: str, message: str, icon, timeout: int) -> None:
    if tray_available:
        tray.showMessage(title, message, icon, timeout)


def _rebuild_routes_menu(
    routes_menu: QMenu,
    manager_snapshot,
    project_root: Path,
    desktop: DesktopAdapter,
    manager: ManagerClient,
    tray: QSystemTrayIcon,
    tray_available: bool,
    refresh_callback,
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
        role_id = role_id_from_gateway(gateway, "未指定人格")
        route_menu = QMenu(_route_label(gateway), routes_menu)
        routes_menu.addMenu(route_menu)
        menu_refs.append(route_menu)
        role_menu = QMenu(str(role_id), route_menu)
        route_menu.addMenu(role_menu)
        menu_refs.append(role_menu)
        role_menu.addAction(_action("打开人格目录", role_menu, lambda checked=False, item=gateway: desktop.open_path(
            role_dir_from_gateway(project_root, item, role_id_from_gateway(item, "未指定人格"))
        )))
        role_menu.addAction(_action("打开任务目录", role_menu, lambda checked=False, item=gateway: desktop.open_path(
            role_dir_from_gateway(project_root, item, role_id_from_gateway(item, "未指定人格")) / "tasks"
        )))
        role_menu.addAction(_action("打开项目目录", role_menu, lambda checked=False, item=gateway: desktop.open_path(
            project_dir_from_gateway(project_root, item)
        )))
        role_menu.addAction(_action("打开运行状态目录", role_menu, lambda checked=False, item=gateway: desktop.open_path(
            runtime_dir_from_gateway(project_root, item)
        )))
        role_menu.addSeparator()
        manual_menu = QMenu("手动触发", role_menu)
        role_menu.addMenu(manual_menu)
        menu_refs.append(manual_menu)
        manual_rules = _manual_trigger_rules(gateway)
        if not manual_rules:
            empty_action = QAction("暂无手动触发规则", manual_menu)
            empty_action.setEnabled(False)
            manual_menu.addAction(empty_action)
            continue
        for rule in manual_rules:
            rule_name = str(rule.get("name") or rule.get("id") or "未命名手动规则")
            rule_id = str(rule.get("id") or rule_name)
            enabled = rule.get("enabled") is not False
            route_kind = _manual_trigger_route_kind(rule)
            action = _action(rule_name, manual_menu, lambda checked=False, item=gateway, rid=rule_id, name=rule_name, kind=route_kind: _manual_trigger(
                manager,
                item,
                rid,
                name,
                kind,
                _manual_trigger_message(name, rid),
                tray,
                tray_available,
                refresh_callback,
            ))
            action.setEnabled(enabled)
            if not enabled:
                action.setText(f"{rule_name}（已停用）")
            manual_menu.addAction(action)

    routes_menu._rabiroute_menu_refs = menu_refs


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
    name = str(gateway.get("routeName") or gateway.get("name") or gateway.get("configName") or gateway.get("id") or "未命名航线")
    role = role_id or str(gateway.get("agentRoleId") or "")
    running = "运行中" if gateway.get("running") else "已停止"
    return f"{name} / {role} / {running}" if role else f"{name} / {running}"


def _route_label(gateway: dict) -> str:
    name = str(gateway.get("routeName") or gateway.get("name") or gateway.get("configName") or gateway.get("id") or "未命名航线")
    running = "运行中" if gateway.get("running") else "已停止"
    return f"{name} / {running}"


def _tooltip(manager_snapshot, task_snapshot) -> str:
    current_count = len(task_snapshot.current)
    short_count = len(task_snapshot.short_term)
    long_count = len(task_snapshot.long_term)
    manager_text = "已连接" if manager_snapshot.connected else "离线"
    return f"RabiRoute / {task_snapshot.role_id}\nManager：{manager_text}\n当前任务：{current_count}\n短期任务：{short_count}\n长期任务：{long_count}"


def _status_text(manager_snapshot) -> str:
    if not manager_snapshot.connected:
        return "状态：Manager 离线"
    gateway = manager_snapshot.selected_gateway
    if not gateway:
        return "状态：Manager 已连接 / 无 gateway"
    running = "运行中" if gateway.get("running") else "已停止"
    return f"状态：Manager 已连接 / Gateway {running}"
