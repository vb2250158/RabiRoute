from __future__ import annotations

import unittest

from rabiroute_tray.manager_client import ManagerClient, ManagerSnapshot


class _RecordingManagerClient(ManagerClient):
    def __init__(self) -> None:
        super().__init__()
        self.paths: list[str] = []

    def _get_json(self, path: str) -> dict:
        self.paths.append(path)
        if path == "/meta":
            return {"version": "test"}
        return {"data": {"manager": [{"id": "route-1"}]}}


class ManagerSnapshotTest(unittest.TestCase):
    def test_snapshot_requests_lightweight_gateway_summary(self) -> None:
        client = _RecordingManagerClient()

        snapshot = client.snapshot()

        self.assertEqual(client.paths, ["/meta", "/gateways?summary=1"])
        self.assertEqual(snapshot.gateways, [{"id": "route-1"}])

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
