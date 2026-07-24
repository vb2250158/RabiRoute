from __future__ import annotations

import unittest

from rabiroute_tray.display_helpers import role_label


class DisplayHelpersTest(unittest.TestCase):
    def test_role_label_uses_manager_persona_content_without_local_files(self) -> None:
        gateway = {
            "agentRoleId": "builder",
            "rolesDir": "Z:/path-that-must-not-be-read",
            "roleRouteNames": {"builder": "Builder"},
            "roleInfo": {"selectedRoleContent": "\ufeff# 星海\n\n由 Manager 返回的人格内容。"},
        }

        self.assertEqual(role_label(gateway), "星海")

    def test_role_label_falls_back_to_manager_route_fields(self) -> None:
        gateway = {
            "agentRoleId": "builder",
            "roleRouteNames": {"builder": "Builder"},
        }

        self.assertEqual(role_label(gateway), "Builder")


if __name__ == "__main__":
    unittest.main()
