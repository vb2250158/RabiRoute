from __future__ import annotations

import unittest

from rabiroute_tray.manager_client import ManagerSnapshot


class ManagerSnapshotTest(unittest.TestCase):
    def test_unique_enabled_gateway_is_the_default_selection(self) -> None:
        snapshot = ManagerSnapshot(
            connected=True,
            manager_url="http://127.0.0.1:8790",
            meta={},
            gateways=[
                {"id": "rabi-link", "agentRoleId": "RabiActive", "enabled": False},
                {"id": "night-rain", "agentRoleId": "YeYu", "enabled": True},
                {"id": "legacy-rabi", "agentRoleId": "Rabi", "enabled": False},
            ],
        )

        self.assertEqual(snapshot.selected_gateway and snapshot.selected_gateway.get("id"), "night-rain")

    def test_rabi_fallback_remains_when_enabled_selection_is_ambiguous(self) -> None:
        snapshot = ManagerSnapshot(
            connected=True,
            manager_url="http://127.0.0.1:8790",
            meta={},
            gateways=[
                {"id": "night-rain", "agentRoleId": "YeYu", "enabled": True},
                {"id": "legacy-rabi", "agentRoleId": "Rabi", "enabled": True},
            ],
        )

        self.assertEqual(snapshot.selected_gateway and snapshot.selected_gateway.get("id"), "legacy-rabi")


if __name__ == "__main__":
    unittest.main()
