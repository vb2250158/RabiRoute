from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

TRAY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAY_ROOT))

from PySide6.QtCore import QThread, Qt
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

from rabiroute_tray.desktop_refresh import DesktopRefreshService
from rabiroute_tray.manager_client import ManagerSnapshot, ManualTriggerResult, PlanFeedbackSubmitResult, RolePanelSendResult
from rabiroute_tray.tray_app import (
    MAX_DIRECT_PERSONA_CHATS,
    _SnapshotRefreshGate,
    _persona_menu_signature,
    _panel_is_active,
    _panel_manager_signature,
    _present_panel_immediately,
    _prewarm_panel,
    _run_when_menu_idle,
    _show_panel_for_user_action,
    _start_desktop_refresh,
    _rebuild_persona_chat_menu,
    _retain_last_gateway_snapshot,
    _start_manager_snapshot,
    _start_manager_shutdown,
    _start_manual_trigger,
    _start_plan_feedback_send,
    _start_role_panel_send,
    _status_text,
    _show_tray_context_menu,
    _warm_menu_layout,
    _wait_for_background_tasks,
)


class _SlowManager:
    def send_role_panel_message(self, gateway_id: str, text: str, attachments: list[dict]) -> RolePanelSendResult:
        time.sleep(0.3)
        return RolePanelSendResult(ok=True)

    def snapshot(self) -> ManagerSnapshot:
        time.sleep(0.15)
        return ManagerSnapshot(True, "http://127.0.0.1:8790", {}, [])

    def submit_plan_feedback(
        self,
        role_id: str,
        plan_id: str,
        gateway_id: str,
        step_id: str,
        feedback_id: str,
        text: str,
    ) -> PlanFeedbackSubmitResult:
        time.sleep(0.3)
        return PlanFeedbackSubmitResult(ok=True, delivery_status="delivered")

    def manual_trigger(
        self,
        gateway_id: str,
        trigger_id: str,
        trigger_name: str,
        message: str,
        route_kind: str,
        rule_id: str,
    ) -> ManualTriggerResult:
        time.sleep(0.3)
        return ManualTriggerResult(ok=True)


class _SlowLifecycle:
    def request_exit(self) -> bool:
        time.sleep(0.3)
        return True


class _FailingManager:
    manager_url = "http://127.0.0.1:8790"

    def send_role_panel_message(self, gateway_id: str, text: str, attachments: list[dict]) -> RolePanelSendResult:
        raise RuntimeError("send exploded")

    def snapshot(self) -> ManagerSnapshot:
        raise RuntimeError("snapshot exploded")


class TrayAppAsyncSendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_role_panel_send_returns_without_blocking_qt_thread(self) -> None:
        results: list[RolePanelSendResult] = []
        started_at = time.perf_counter()
        task = _start_role_panel_send(
            _SlowManager(),  # type: ignore[arg-type]
            "route-1",
            "hello",
            [],
            lambda _task, result: results.append(result),
        )
        elapsed = time.perf_counter() - started_at
        self.assertLess(elapsed, 0.15)
        deadline = time.perf_counter() + 1.0
        while not results and time.perf_counter() < deadline:
            self.app.processEvents()
            time.sleep(0.01)
        self.assertEqual(results, [RolePanelSendResult(ok=True)])

    def test_manager_snapshot_returns_without_blocking_qt_thread(self) -> None:
        results: list[ManagerSnapshot] = []
        callback_threads: list[QThread] = []
        started_at = time.perf_counter()
        _start_manager_snapshot(
            _SlowManager(),  # type: ignore[arg-type]
            lambda _task, snapshot: (callback_threads.append(QThread.currentThread()), results.append(snapshot)),
        )
        elapsed = time.perf_counter() - started_at
        self.assertLess(elapsed, 0.08)
        deadline = time.perf_counter() + 1.0
        while not results and time.perf_counter() < deadline:
            self.app.processEvents()
            time.sleep(0.01)
        self.assertEqual(results, [ManagerSnapshot(True, "http://127.0.0.1:8790", {}, [])])
        self.assertEqual(callback_threads, [self.app.thread()])

    def test_plan_feedback_send_returns_without_blocking_qt_thread(self) -> None:
        results: list[PlanFeedbackSubmitResult] = []
        started_at = time.perf_counter()
        _start_plan_feedback_send(
            _SlowManager(),  # type: ignore[arg-type]
            "Rabi",
            "plan-1",
            "route-1",
            "verify",
            "feedback-1",
            "建议补充回归范围。",
            lambda _task, result: results.append(result),
        )
        elapsed = time.perf_counter() - started_at
        self.assertLess(elapsed, 0.15)
        deadline = time.perf_counter() + 1.0
        while not results and time.perf_counter() < deadline:
            self.app.processEvents()
            time.sleep(0.01)
        self.assertEqual(results, [PlanFeedbackSubmitResult(ok=True, delivery_status="delivered")])

    def test_manual_trigger_returns_without_blocking_qt_thread(self) -> None:
        results: list[ManualTriggerResult] = []
        started_at = time.perf_counter()

        _start_manual_trigger(
            _SlowManager(),  # type: ignore[arg-type]
            "route-1",
            "trigger-1",
            "Trigger 1",
            "message",
            "manual_trigger",
            lambda _task, result: results.append(result),
        )

        self.assertLess(time.perf_counter() - started_at, 0.1)
        deadline = time.perf_counter() + 1.0
        while not results and time.perf_counter() < deadline:
            self.app.processEvents()
            time.sleep(0.01)
        self.assertEqual(results, [ManualTriggerResult(ok=True)])

    def test_manager_shutdown_returns_without_blocking_qt_thread(self) -> None:
        results: list[bool] = []
        started_at = time.perf_counter()

        _start_manager_shutdown(
            _SlowLifecycle(),  # type: ignore[arg-type]
            lambda _task, result: results.append(result),
        )

        self.assertLess(time.perf_counter() - started_at, 0.1)
        deadline = time.perf_counter() + 1.0
        while not results and time.perf_counter() < deadline:
            self.app.processEvents()
            time.sleep(0.01)
        self.assertEqual(results, [True])

    def test_complete_desktop_refresh_keeps_qt_thread_under_100ms(self) -> None:
        manager = _SlowManager()
        manager.manager_url = "http://127.0.0.1:8790"
        manager.snapshot = lambda: ManagerSnapshot(
            True,
            manager.manager_url,
            {},
            [{"id": "route-1", "agentRoleId": "Rabi", "dataDir": "data/route/default-main"}],
        )
        manager.role_plans = lambda _role_id: (time.sleep(0.15), [])[1]
        manager.role_memory = lambda _role_id: (time.sleep(0.15), {})[1]
        manager.role_panel_messages_snapshot = lambda _role_id: (time.sleep(0.15), [])[1]
        manager.role_avatar = lambda _role_id: (time.sleep(0.15), None)[1]
        results = []
        callback_threads: list[QThread] = []
        started_at = time.perf_counter()
        refresh_service = DesktopRefreshService(
            manager,  # type: ignore[arg-type]
            TRAY_ROOT.parent.parent,
        )

        _start_desktop_refresh(
            refresh_service,
            ManagerSnapshot(False, manager.manager_url, {}, []),
            "route-1",
            True,
            lambda _task, result: (callback_threads.append(QThread.currentThread()), results.append(result)),
        )

        elapsed = time.perf_counter() - started_at
        self.assertLess(elapsed, 0.1)
        deadline = time.perf_counter() + 1.5
        while not results and time.perf_counter() < deadline:
            self.app.processEvents()
            time.sleep(0.01)
        self.assertEqual(len(results), 1)
        self.assertEqual(callback_threads, [self.app.thread()])
        self.assertEqual(results[0].selected_gateway["id"], "route-1")

    def test_background_failures_return_terminal_results_instead_of_stranding_tasks(self) -> None:
        snapshots: list[ManagerSnapshot] = []
        sends: list[RolePanelSendResult] = []
        _start_manager_snapshot(
            _FailingManager(),  # type: ignore[arg-type]
            lambda _task, snapshot: snapshots.append(snapshot),
        )
        _start_role_panel_send(
            _FailingManager(),  # type: ignore[arg-type]
            "route-1",
            "hello",
            [],
            lambda _task, result: sends.append(result),
        )
        self.assertTrue(_wait_for_background_tasks())
        self.app.processEvents()

        self.assertEqual(len(snapshots), 1)
        self.assertFalse(snapshots[0].connected)
        self.assertIn("snapshot exploded", snapshots[0].error)
        self.assertEqual(len(sends), 1)
        self.assertFalse(sends[0].ok)
        self.assertIn("send exploded", sends[0].message)

    def test_snapshot_task_signals_outlive_the_qapplication_parent(self) -> None:
        task = _start_manager_snapshot(_SlowManager(), lambda _task, _snapshot: None)  # type: ignore[arg-type]
        self.assertIsNone(task.signals.parent())
        self.assertTrue(_wait_for_background_tasks())
        self.app.processEvents()

    def test_refresh_gate_queues_manual_refresh_behind_active_auto_refresh(self) -> None:
        gate = _SnapshotRefreshGate()
        active_task = object()

        self.assertTrue(gate.request(auto=True))
        gate.started(active_task)
        self.assertFalse(gate.request(auto=False))
        self.assertTrue(gate.completed(active_task))
        self.assertTrue(gate.request(auto=False))

    def test_transient_gateway_timeout_keeps_last_successful_gateway_snapshot(self) -> None:
        previous = ManagerSnapshot(
            True,
            "http://127.0.0.1:8790",
            {"version": "old"},
            [{"id": "route-1", "running": True}],
        )
        failed = ManagerSnapshot(
            True,
            "http://127.0.0.1:8790",
            {"version": "new"},
            [],
            "gateway status unavailable: timed out",
        )

        retained = _retain_last_gateway_snapshot(previous, failed)

        self.assertEqual(retained.gateways, previous.gateways)
        self.assertEqual(retained.meta, failed.meta)
        self.assertEqual(retained.error, failed.error)
        self.assertIn("显示上次结果", _status_text(retained))

    def test_manager_disconnect_does_not_retain_stale_gateways(self) -> None:
        previous = ManagerSnapshot(True, "http://127.0.0.1:8790", {}, [{"id": "route-1"}])
        disconnected = ManagerSnapshot(False, "http://127.0.0.1:8790", {}, [], "offline")

        retained = _retain_last_gateway_snapshot(previous, disconnected)

        self.assertEqual(retained, disconnected)

    def test_persona_chats_are_direct_and_overflow_into_more_menu(self) -> None:
        menu = QMenu()
        more_menu = QMenu("更多人格")
        insert_before = menu.addSeparator()
        opened: list[str] = []
        gateways = [
            {
                "id": f"route-{index}",
                "agentRoleId": f"Role{index}",
                "roleRouteNames": {f"route-{index}": f"人格 {index}"},
                "enabled": True,
                "running": index % 2 == 0,
            }
            for index in range(MAX_DIRECT_PERSONA_CHATS + 2)
        ]
        snapshot = ManagerSnapshot(True, "http://127.0.0.1:8790", {}, gateways)

        _rebuild_persona_chat_menu(
            menu,
            insert_before,
            more_menu,
            snapshot,
            "route-3",
            lambda gateway: opened.append(str(gateway["id"])),
        )

        direct_actions = [action for action in menu.actions() if not action.isSeparator() and action.menu() is None]
        self.assertEqual(len(direct_actions), MAX_DIRECT_PERSONA_CHATS)
        self.assertTrue(direct_actions[0].text().startswith("继续聊天 · 人格 3"))
        self.assertEqual(len(more_menu.actions()), 1)
        more_menu.aboutToShow.emit()
        self.assertEqual(len(more_menu.actions()), 2)
        self.assertIn(more_menu.menuAction(), menu.actions())

        direct_actions[0].trigger()
        self.assertEqual(opened, ["route-3"])

        more_menu.actions()[0].trigger()
        self.assertEqual(opened, ["route-3", "route-5"])

    def test_panel_activation_stays_inside_the_user_action(self) -> None:
        calls: list[str] = []

        class _WindowHandle:
            def requestActivate(self) -> None:
                calls.append("requestActivate")

        class _Panel:
            def showNormal(self) -> None:
                calls.append("showNormal")

            def raise_(self) -> None:
                calls.append("raise")

            def activateWindow(self) -> None:
                calls.append("activateWindow")

            def windowHandle(self):
                calls.append("windowHandle")
                return _WindowHandle()

        _show_panel_for_user_action(_Panel())  # type: ignore[arg-type]

        self.assertEqual(
            calls,
            ["showNormal", "raise", "activateWindow", "windowHandle", "requestActivate"],
        )

    def test_panel_is_presented_before_render_is_deferred(self) -> None:
        calls: list[str] = []

        class _WindowHandle:
            def requestActivate(self) -> None:
                calls.append("requestActivate")

        class _Panel:
            def showNormal(self) -> None:
                calls.append("showNormal")

            def raise_(self) -> None:
                calls.append("raise")

            def activateWindow(self) -> None:
                calls.append("activateWindow")

            def windowHandle(self):
                return _WindowHandle()

        _present_panel_immediately(_Panel(), lambda: calls.append("render"))  # type: ignore[arg-type]

        self.assertEqual(calls, ["showNormal", "raise", "activateWindow", "requestActivate"])
        self.app.processEvents()
        self.assertEqual(calls, ["showNormal", "raise", "activateWindow", "requestActivate", "render"])

    def test_panel_prewarm_is_invisible_and_restores_window_state(self) -> None:
        calls: list[object] = []

        class _Panel:
            opacity = 0.75
            show_without_activating = False

            def windowOpacity(self) -> float:
                return self.opacity

            def testAttribute(self, attribute) -> bool:
                self.assert_show_attribute(attribute)
                return self.show_without_activating

            def setAttribute(self, attribute, enabled: bool) -> None:
                self.assert_show_attribute(attribute)
                self.show_without_activating = enabled
                calls.append(("attribute", enabled))

            def setWindowOpacity(self, value: float) -> None:
                self.opacity = value
                calls.append(("opacity", value))

            def showNormal(self) -> None:
                calls.append("showNormal")

            def hide(self) -> None:
                calls.append("hide")

            @staticmethod
            def assert_show_attribute(attribute) -> None:
                if attribute != Qt.WA_ShowWithoutActivating:
                    raise AssertionError(f"unexpected attribute: {attribute}")

        class _App:
            def processEvents(self, flags) -> None:
                calls.append(("processEvents", flags))

        panel = _Panel()
        _prewarm_panel(panel, _App())  # type: ignore[arg-type]

        self.assertEqual(panel.opacity, 0.75)
        self.assertFalse(panel.show_without_activating)
        self.assertEqual(calls[0:3], [("attribute", True), ("opacity", 0.0), "showNormal"])
        self.assertIn("hide", calls)
        self.assertEqual(calls[-2:], [("opacity", 0.75), ("attribute", False)])

    def test_persona_chat_menu_explains_manager_offline_state(self) -> None:
        menu = QMenu()
        more_menu = QMenu("更多人格")
        insert_before = menu.addSeparator()
        snapshot = ManagerSnapshot(False, "http://127.0.0.1:8790", {}, [], "offline")

        _rebuild_persona_chat_menu(menu, insert_before, more_menu, snapshot, "", lambda _gateway: None)

        offline_action = menu.actions()[0]
        self.assertFalse(offline_action.isEnabled())
        self.assertIn("Manager 离线", offline_action.text())

    def test_persona_menu_signature_ignores_unrelated_refresh_fields(self) -> None:
        first = ManagerSnapshot(
            True,
            "http://127.0.0.1:8790",
            {},
            [{"id": "route-1", "agentRoleId": "Rabi", "enabled": True, "running": True, "tickCount": 1}],
        )
        second = ManagerSnapshot(
            True,
            "http://127.0.0.1:8790",
            {},
            [{"id": "route-1", "agentRoleId": "Rabi", "enabled": True, "running": True, "tickCount": 2}],
        )

        self.assertEqual(_persona_menu_signature(first), _persona_menu_signature(second))

    def test_panel_manager_signature_ignores_unrelated_refresh_fields(self) -> None:
        first = ManagerSnapshot(
            True,
            "http://127.0.0.1:8790",
            {},
            [{"id": "route-1", "agentRoleId": "Rabi", "enabled": True, "running": True, "tickCount": 1}],
        )
        second = ManagerSnapshot(
            True,
            "http://127.0.0.1:8790",
            {},
            [{"id": "route-1", "agentRoleId": "Rabi", "enabled": True, "running": True, "tickCount": 2}],
        )

        self.assertEqual(_panel_manager_signature(first), _panel_manager_signature(second))

    def test_panel_manager_signature_tracks_visible_route_state(self) -> None:
        running = ManagerSnapshot(
            True,
            "http://127.0.0.1:8790",
            {},
            [{"id": "route-1", "agentRoleId": "Rabi", "enabled": True, "running": True}],
        )
        stopped = ManagerSnapshot(
            True,
            "http://127.0.0.1:8790",
            {},
            [{"id": "route-1", "agentRoleId": "Rabi", "enabled": True, "running": False}],
        )

        self.assertNotEqual(_panel_manager_signature(running), _panel_manager_signature(stopped))

    def test_tray_context_activation_requests_popup_within_100ms(self) -> None:
        menu = QMenu()
        popup_calls = []
        menu.isVisible = lambda: False  # type: ignore[method-assign]
        menu.popup = lambda position: popup_calls.append(position)  # type: ignore[method-assign]
        started_at = time.perf_counter()

        handled = _show_tray_context_menu(menu, QSystemTrayIcon.Context)

        self.assertTrue(handled)
        self.assertEqual(len(popup_calls), 1)
        self.assertLess(time.perf_counter() - started_at, 0.1)

    def test_left_click_tray_activation_requests_popup_within_100ms(self) -> None:
        menu = QMenu()
        popup_calls = []
        menu.isVisible = lambda: False  # type: ignore[method-assign]
        menu.popup = lambda position: popup_calls.append(position)  # type: ignore[method-assign]
        started_at = time.perf_counter()

        handled = _show_tray_context_menu(menu, QSystemTrayIcon.Trigger)

        self.assertTrue(handled)
        self.assertEqual(len(popup_calls), 1)
        self.assertLess(time.perf_counter() - started_at, 0.1)

    def test_double_click_does_not_reopen_tray_menu(self) -> None:
        menu = QMenu()
        popup_calls = []
        menu.isVisible = lambda: False  # type: ignore[method-assign]
        menu.popup = lambda position: popup_calls.append(position)  # type: ignore[method-assign]

        handled = _show_tray_context_menu(menu, QSystemTrayIcon.DoubleClick)

        self.assertFalse(handled)
        self.assertEqual(popup_calls, [])

    def test_context_activation_does_not_reopen_visible_menu(self) -> None:
        menu = QMenu()
        popup_calls = []
        menu.isVisible = lambda: True  # type: ignore[method-assign]
        menu.popup = lambda position: popup_calls.append(position)  # type: ignore[method-assign]

        handled = _show_tray_context_menu(menu, QSystemTrayIcon.Context)

        self.assertTrue(handled)
        self.assertEqual(popup_calls, [])

    def test_hidden_panel_is_excluded_from_auto_refresh_work(self) -> None:
        class _Panel:
            def isVisible(self) -> bool:
                return False

        self.assertFalse(_panel_is_active(_Panel()))  # type: ignore[arg-type]
        self.assertFalse(_panel_is_active(None))

    def test_refresh_application_waits_until_tray_menu_is_hidden(self) -> None:
        menu = QMenu()
        visible = [True]
        applied = []
        menu.isVisible = lambda: visible[0]  # type: ignore[method-assign]

        _run_when_menu_idle(menu, lambda: applied.append(True), retry_ms=1)
        self.app.processEvents()
        self.assertEqual(applied, [])

        visible[0] = False
        deadline = time.perf_counter() + 0.5
        while not applied and time.perf_counter() < deadline:
            self.app.processEvents()
            time.sleep(0.005)
        self.assertEqual(applied, [True])

    def test_menu_layout_is_precomputed_under_100ms(self) -> None:
        menu = QMenu()
        for index in range(10):
            menu.addAction(f"人格 {index}")
        started_at = time.perf_counter()

        size = _warm_menu_layout(menu)

        self.assertGreater(size.width(), 0)
        self.assertGreater(size.height(), 0)
        self.assertNotEqual(int(menu.winId()), 0)
        self.assertFalse(menu.isVisible())
        self.assertLess(time.perf_counter() - started_at, 0.1)


if __name__ == "__main__":
    unittest.main()
