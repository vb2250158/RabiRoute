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

    def test_packaged_tray_does_not_force_local_role_repositories_into_runtime(self) -> None:
        spec = (TRAY_ROOT.parent.parent / "RabiRoute-Tray.spec").read_text(encoding="utf-8")

        self.assertNotIn('"rabiroute_tray.task_repository"', spec)
        self.assertNotIn('"rabiroute_tray.role_context_repository"', spec)

    def test_qt_async_layer_contains_no_manager_or_role_business_logic(self) -> None:
        source = (TRAY_ROOT / "rabiroute_tray" / "qt_async.py").read_text(encoding="utf-8")

        self.assertNotIn("ManagerClient", source)
        self.assertNotIn("Plan", source)
        self.assertNotIn("Memory", source)


if __name__ == "__main__":
    unittest.main()
