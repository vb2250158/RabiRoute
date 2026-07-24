from __future__ import annotations

import unittest
from pathlib import Path


TRAY_ROOT = Path(__file__).resolve().parents[1]


class TrayArchitectureTest(unittest.TestCase):
    def test_backend_refresh_service_has_no_qt_dependency(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "desktop_refresh.py").read_text(encoding="utf-8")

        self.assertNotIn("PySide6", source)
        self.assertNotIn("PlanRepository", source)
        self.assertNotIn("RoleContextRepository", source)

    def test_tray_ui_does_not_read_role_files_or_call_role_data_apis_directly(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "tray_app.py").read_text(encoding="utf-8")

        self.assertNotIn("PlanRepository", source)
        self.assertNotIn("RoleContextRepository", source)
        self.assertNotIn("manager.role_plans", source)
        self.assertNotIn("manager.role_memory", source)
        self.assertNotIn("manager.role_panel_messages", source)
        self.assertNotIn("setContextMenu(", source)

    def test_packaged_tray_does_not_force_local_role_repositories_into_runtime(self) -> None:
        spec = (TRAY_ROOT.parent.parent / "RabiRoute-Tray.spec").read_text(encoding="utf-8")

        self.assertNotIn('"rabiroute_tray.task_repository"', spec)
        self.assertNotIn('"rabiroute_tray.role_context_repository"', spec)

    def test_qt_async_layer_contains_no_manager_or_role_business_logic(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "qt_async.py").read_text(encoding="utf-8")

        self.assertNotIn("ManagerClient", source)
        self.assertNotIn("Plan", source)
        self.assertNotIn("Memory", source)

    def test_tray_menu_controller_is_presentation_only(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "tray_menu_controller.py").read_text(encoding="utf-8")

        self.assertNotIn("Manager", source)
        self.assertNotIn("Repository", source)
        self.assertNotIn("setContextMenu", source)

    def test_display_helpers_derive_labels_from_manager_dto_without_file_io(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "display_helpers.py").read_text(encoding="utf-8")

        self.assertNotIn("from pathlib", source)
        self.assertNotIn(".open(", source)
        self.assertNotIn("read_text", source)

    def test_tray_ui_does_not_probe_attachment_files_on_qt_thread(self) -> None:
        task_window = (TRAY_ROOT / "rabiroute_tray" / "task_window.py").read_text(encoding="utf-8")
        manager_client = (TRAY_ROOT / "rabiroute_tray" / "manager_client.py").read_text(encoding="utf-8")

        self.assertNotIn(".stat(", task_window)
        self.assertNotIn("attachment_from_path", manager_client)

    def test_ui_actions_do_not_call_manager_network_operations_inline(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "tray_app.py").read_text(encoding="utf-8")

        self.assertNotIn("result = manager.manual_trigger(", source)
        self.assertNotIn("shutdown_requested = lifecycle.request_exit()", source)
        self.assertIn("_start_manual_trigger(", source)
        self.assertIn("_start_manager_shutdown(", source)

    def test_role_panel_is_prewarmed_before_the_tray_becomes_clickable(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "tray_app.py").read_text(encoding="utf-8")

        self.assertLess(source.index("_prewarm_panel(ensure_panel(), app)"), source.index("tray.show()"))
        self.assertIn("_present_panel_immediately(active_panel, render_selected_gateway)", source)
        helper = source[source.index("def _present_panel_immediately"):source.index("def _prewarm_panel")]
        self.assertLess(helper.index("_show_panel_for_user_action(panel)"), helper.index("QTimer.singleShot"))


if __name__ == "__main__":
    unittest.main()
