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
        if path.endswith("/plans"):
            return {"code": 0, "data": [{"id": "plan-1"}]}
        if path.endswith("/memory"):
            return {"code": 0, "data": {"recent": [], "consolidated": []}}
        if "/role-panel/messages" in path:
            return {"messages": [{"id": "message-1"}]}
        return {"data": {"manager": [{"id": "route-1"}]}}

    def _get_bytes(self, path: str) -> bytes:
        self.paths.append(path)
        return b"avatar"


class ManagerSnapshotTest(unittest.TestCase):
    def test_snapshot_requests_lightweight_gateway_summary(self) -> None:
        client = _RecordingManagerClient()

        snapshot = client.snapshot()

        self.assertEqual(client.paths, ["/meta", "/gateways?summary=1"])
        self.assertEqual(snapshot.gateways, [{"id": "route-1"}])

    def test_desktop_read_models_use_manager_role_apis(self) -> None:
        client = _RecordingManagerClient()

        plans = client.role_plans("Rabi / 测试")
        memory = client.role_memory("Rabi / 测试")
        messages = client.role_panel_messages_snapshot("Rabi / 测试")
        avatar = client.role_avatar("Rabi / 测试")

        self.assertEqual(plans, [{"id": "plan-1"}])
        self.assertEqual(memory, {"recent": [], "consolidated": []})
        self.assertEqual(messages, [{"id": "message-1"}])
        self.assertEqual(avatar, b"avatar")
        self.assertEqual(
            client.paths,
            [
                "/api/roles/Rabi%20%2F%20%E6%B5%8B%E8%AF%95/plans",
                "/api/roles/Rabi%20%2F%20%E6%B5%8B%E8%AF%95/memory",
                "/api/roles/Rabi%20%2F%20%E6%B5%8B%E8%AF%95/role-panel/messages?limit=120",
                "/api/roles/Rabi%20%2F%20%E6%B5%8B%E8%AF%95/avatar",
            ],
        )

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
