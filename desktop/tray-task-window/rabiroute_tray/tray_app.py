from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import QDir, QEventLoop, QLockFile, QTimer, Qt
from PySide6.QtGui import QAction, QColor, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

from .app_paths import project_dir_from_gateway, role_dir_from_gateway, role_id_from_gateway, runtime_dir_from_gateway
from .desktop_adapter import DesktopAdapter
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
from .qt_async import QtAsyncTask, start_qt_task, wait_for_qt_tasks
from .task_window import TaskWindow
from .theme import apply_rabi_menu_theme
from .tray_menu_controller import TrayMenuController, show_tray_menu_for_activation
from .windows_app_identity import apply_qt_app_metadata


MAX_DIRECT_PERSONA_CHATS = 5
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


def _start_manager_shutdown(
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
    project_root: Path,
    manager_url: str = "http://127.0.0.1:8790",
    manager_proc: "subprocess.Popen[bytes] | None" = None,
) -> int:
    app = QApplication(sys.argv)
    apply_qt_app_metadata(app)
    app.aboutToQuit.connect(_wait_for_background_tasks)
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
    refresh_service = DesktopRefreshService(manager, project_root)
    app_icon = desktop.app_icon()

    tray = QSystemTrayIcon(app_icon, app)
    tray.setToolTip("RabiRoute / Rabi 桌面分诊台")

    refresh_action = QAction("刷新")
    webgui_action = QAction("打开 RabiRoute WebGUI")
    status_action = QAction("状态：加载中")
    persona_heading_action = QAction("人格聊天")
    more_personas_menu = QMenu("更多人格")
    quit_action = QAction(lifecycle.exit_label)
    status_action.setEnabled(False)
    persona_heading_action.setEnabled(False)

    menu = QMenu()
    apply_rabi_menu_theme(menu, more_personas_menu)
    menu.addAction(status_action)
    menu.addSeparator()
    menu.addAction(persona_heading_action)
    persona_actions_end = menu.addSeparator()
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
        project_root,
        initial_manager.selected_gateway,
        initial_role_id,
    )
    state = {
        "manager": initial_manager,
        "plans": initial_plans,
        "context": initial_context,
        "role_messages": [],
        "loaded_gateway_id": selected_gateway_id,
    }
    pending_role_panel_sends: set[QtAsyncTask] = set()
    pending_plan_feedback_sends: set[QtAsyncTask] = set()
    refresh_gate = _SnapshotRefreshGate()
    lifecycle.observe(initial_manager)

    def ensure_panel() -> TaskWindow:
        nonlocal panel
        if panel is not None:
            return panel
        panel = TaskWindow(app_icon)
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
                state["plans"], state["context"] = empty_desktop_read_model(project_root, gateway, role_id)
                state["role_messages"] = []
                state["loaded_gateway_id"] = active_gateway_id
            active_panel.set_actions(
                _panel_actions(gateway, project_root, desktop, manager, tray, tray_available, refresh)
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

    def apply_refresh(result: DesktopRefreshResult, auto: bool) -> None:
        previous_manager = state["manager"]
        previous_plans = state["plans"]
        previous_context = state["context"]
        previous_role_messages = state["role_messages"]
        state["manager"] = result.manager
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
                panel.set_actions(_panel_actions(selected_gateway, project_root, desktop, manager, tray, tray_available, refresh))
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
    webgui_action.triggered.connect(lambda: desktop.open_url(manager.manager_url))
    quit_action.triggered.connect(lambda: _quit(app, tray, tray_available, lifecycle, manager_proc))

    timer = QTimer()
    timer.timeout.connect(lambda: refresh(auto=True))
    timer.start(10_000)

    _prewarm_panel(ensure_panel(), app)
    refresh()
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


def _quit(
    app: QApplication,
    tray: QSystemTrayIcon,
    tray_available: bool,
    lifecycle: LifecycleController,
    manager_proc: "subprocess.Popen[bytes] | None" = None,
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
    def completed(_task: QtAsyncTask, shutdown_requested: bool) -> None:
        if manager_proc is not None and manager_proc.poll() is None:
            # HTTP shutdown may be slow or fail for the manager started by this process.
            manager_proc.terminate()
            shutdown_requested = True
        if not shutdown_requested:
            app.setProperty("rabirouteQuitPending", False)
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

    _start_manager_shutdown(lifecycle, completed)


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
            panel.complete_plan_feedback(plan_id, True, "审批建议已记录并交给 Agent 处理。", "success")
            _show_message(tray, tray_available, "计划审批", "审批建议已记录并交给 Agent。", QSystemTrayIcon.Information, 2200)
            refresh_callback()
            return
        if result.delivery_status == "failed":
            detail = f" {result.message}" if result.message else ""
            panel.complete_plan_feedback(plan_id, False, f"审批建议已记录，但通知 Agent 失败；可以重试。{detail}", "warning")
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
