from __future__ import annotations

import sys
import unittest
from pathlib import Path

TRAY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAY_ROOT))

from rabiroute_tray.display_helpers import role_display_name, role_label


class DisplayHelpersTest(unittest.TestCase):
    def test_role_label_uses_manager_persona_content_without_local_files(self) -> None:
        gateway = {
            "agentRoleId": "builder",
            "rolesDir": "Z:/path-that-must-not-be-read",
            "roleRouteNames": {"builder": "Builder"},
            "roleInfo": {"selectedRoleContent": "\ufeff# 星海\n\n由 Manager 返回的角色内容。"},
        }

        self.assertEqual(role_label(gateway), "星海")

    def test_role_label_falls_back_to_manager_route_fields(self) -> None:
        gateway = {
            "agentRoleId": "builder",
            "roleRouteNames": {"builder": "Builder"},
        }

        self.assertEqual(role_label(gateway), "Builder")

    def test_role_label_uses_lightweight_manager_persona_title(self) -> None:
        gateway = {
            "agentRoleId": "builder",
            "roleRouteNames": {"builder": "Builder"},
            "roleInfo": {"selectedRoleTitle": "星海"},
        }

        self.assertEqual(role_label(gateway), "星海")

    def test_role_display_name_drops_the_route_name_a_delivery_target_does_not_address(self) -> None:
        # Real Route label is "星海建造师 策划 程序"; the role itself is "星海建造师".
        gateway = {
            "agentRoleId": "XinghaiBuilder",
            "roleRouteNames": {"XinghaiBuilder-main": "星海建造师 策划 程序"},
            "roleInfo": {"selectedRoleTitle": "星海建造师"},
        }

        self.assertEqual(role_label(gateway), "星海建造师 策划 程序")
        self.assertEqual(role_display_name(gateway), "星海建造师")

    def test_role_display_name_falls_back_to_the_role_label_without_a_persona_title(self) -> None:
        gateway = {"agentRoleId": "builder", "roleRouteNames": {"builder": "Builder"}}

        self.assertEqual(role_display_name(gateway), "Builder")


if __name__ == "__main__":
    unittest.main()
