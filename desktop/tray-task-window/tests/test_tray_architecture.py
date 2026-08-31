from __future__ import annotations

import unittest
from pathlib import Path


TRAY_ROOT = Path(__file__).resolve().parents[1]


class TrayArchitectureTest(unittest.TestCase):
    def test_surface_child_has_no_manager_supervisor_or_dynamic_extension_loader(self) -> None:
        package_root = TRAY_ROOT / "rabiroute_tray"
        launcher = (TRAY_ROOT / "main.py").read_text(encoding="utf-8")
        plugin_catalog = (package_root / "plugin_catalog.py").read_text(encoding="utf-8")

        self.assertFalse((package_root / "manager_endpoint.py").exists())
        self.assertFalse((package_root / "startup_window.py").exists())
        self.assertNotIn("subprocess", launcher)
        self.assertNotIn("importlib.metadata", plugin_catalog)
        self.assertNotIn("entry_points", plugin_catalog)

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

    def test_task_window_cannot_create_an_unfenced_manager_client(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "task_window.py").read_text(encoding="utf-8")

        self.assertNotIn("ManagerClient(", source)
        self.assertIn("Host-fenced plugin Manager client factory", source)

    def test_local_role_repositories_are_removed_from_runtime_and_imports(self) -> None:
        package_root = TRAY_ROOT / "rabiroute_tray"
        removed_modules = ("task_repository", "role_context_repository")
        for module_name in removed_modules:
            self.assertFalse((package_root / f"{module_name}.py").exists())
        for source_path in package_root.glob("*.py"):
            source = source_path.read_text(encoding="utf-8")
            for module_name in removed_modules:
                self.assertNotIn(module_name, source, source_path.name)

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
        self.assertNotIn("quit_requested = lifecycle.request_exit()", source)
        self.assertIn("_start_manual_trigger(", source)
        self.assertIn("_start_application_quit(", source)

    def test_packaged_tray_never_kills_or_shuts_down_manager_directly(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "tray_app.py").read_text(encoding="utf-8")

        quit_helper = source[source.index("def _quit("):source.index("def _show_message(")]
        self.assertNotIn(".terminate()", quit_helper)
        self.assertNotIn("taskkill", quit_helper)
        self.assertNotIn("/manager/shutdown", source)

    def test_periodic_refresh_retries_plugin_catalog_after_manager_recovery(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "tray_app.py").read_text(encoding="utf-8")

        refresh_tick = source[source.index("    def refresh_tick() -> None:"):source.index("    timer.timeout.connect(refresh_tick)")]
        self.assertIn("refresh_plugin_catalog()", refresh_tick)

        catalog_refresh = source[source.index("    def refresh_plugin_catalog() -> None:"):source.index("    def refresh(auto: bool = False) -> None:")]
        self.assertIn("if plugin_catalog_task is not completed_task", catalog_refresh)
        self.assertIn("finally:\n                    plugin_catalog_task = None", catalog_refresh)

    def test_role_panel_is_prewarmed_before_the_tray_becomes_clickable(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "tray_app.py").read_text(encoding="utf-8")

        self.assertLess(source.index("_prewarm_panel(ensure_panel(), app)"), source.index("tray.show()"))
        self.assertIn("_present_panel_immediately(active_panel, render_selected_gateway)", source)
        helper = source[source.index("def _present_panel_immediately"):source.index("def _prewarm_panel")]
        self.assertLess(helper.index("_show_panel_for_user_action(panel)"), helper.index("QTimer.singleShot"))

    def test_shutdown_stops_long_lived_features_before_waiting_for_qt_tasks(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "tray_app.py").read_text(encoding="utf-8")

        wait = source.index("app.aboutToQuit.connect(_wait_for_background_tasks)")
        self.assertLess(source.index("app.aboutToQuit.connect(system_selection.stop)"), wait)
        self.assertLess(source.index("app.aboutToQuit.connect(system_screenshot.stop)"), wait)
        self.assertLess(source.index("app.aboutToQuit.connect(dispose)"), wait)

        run_source = source[source.index("def run("):source.index("def _connect_host_lifecycle(")]
        self.assertLess(run_source.index("tray.show()"), run_source.index("_connect_host_lifecycle("))


if __name__ == "__main__":
    unittest.main()
