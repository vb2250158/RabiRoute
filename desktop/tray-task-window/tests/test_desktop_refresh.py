from __future__ import annotations

import unittest
from pathlib import Path

from rabiroute_tray.desktop_refresh import DesktopRefreshService
from rabiroute_tray.manager_client import ManagerSnapshot


class _ApiManager:
    manager_url = "http://127.0.0.1:8790"

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.fail_plans = False

    def snapshot(self) -> ManagerSnapshot:
        self.calls.append(("snapshot", ""))
        return ManagerSnapshot(
            connected=True,
            manager_url=self.manager_url,
            meta={},
            gateways=[{"id": "route-1", "agentRoleId": "Rabi", "enabled": True, "running": True}],
        )

    def role_plans(self, role_id: str) -> list[dict]:
        self.calls.append(("plans", role_id))
        if self.fail_plans:
            raise OSError("plans unavailable")
        return [
            {
                "id": "plan-1",
                "title": "API plan",
                "status": "进行中",
                "presentation": {"status": "阻塞中", "tone": "blocked"},
                "steps": [],
                "keywords": [],
            },
            {
                "id": "plan-2",
                "title": "API QA plan",
                "status": "进行中",
                "presentation": {
                    "status": "待QA测试",
                    "tone": "qa",
                    "approval": {
                        "enabled": True,
                        "label": "审批建议",
                        "helper": "由 Manager 记录",
                        "stepId": "verify",
                    },
                },
                "approval": {
                    "count": 1,
                    "latest": {
                        "text": "补充回归范围",
                        "createdAt": "2026-07-24T12:00:00.000Z",
                        "deliveryStatus": "delivered",
                    },
                },
                "steps": [],
                "keywords": [],
            },
        ]

    def role_memory(self, role_id: str) -> dict:
        self.calls.append(("memory", role_id))
        return {
            "recent": [{"id": "memory-1", "title": "API memory", "content": "detail", "keywords": []}],
            "consolidated": [],
        }

    def role_panel_messages_snapshot(self, role_id: str) -> list[dict]:
        self.calls.append(("messages", role_id))
        return [{"id": "message-1"}]

    def role_avatar(self, role_id: str) -> bytes | None:
        self.calls.append(("avatar", role_id))
        return b"avatar-bytes"


class DesktopRefreshServiceTest(unittest.TestCase):
    def test_builds_tray_read_model_exclusively_from_manager_apis(self) -> None:
        manager = _ApiManager()
        service = DesktopRefreshService(manager, Path("C:/repo"))  # type: ignore[arg-type]

        result = service.load(
            ManagerSnapshot(False, manager.manager_url, {}, []),
            "route-1",
            include_role_messages=True,
        )

        self.assertTrue(result.manager.connected)
        self.assertEqual(result.plan_snapshot and result.plan_snapshot.current[0].title, "API plan")
        self.assertEqual(result.plan_snapshot and result.plan_snapshot.current[0].display_status, "阻塞中")
        self.assertEqual(
            result.plan_snapshot and [plan.title for plan in result.plan_snapshot.active],
            ["API plan", "API QA plan"],
        )
        qa_plan = result.plan_snapshot and result.plan_snapshot.active[1]
        self.assertTrue(qa_plan and qa_plan.approval_enabled)
        self.assertEqual(qa_plan and qa_plan.approval_step_id, "verify")
        self.assertEqual(qa_plan and qa_plan.latest_approval_text, "补充回归范围")
        self.assertEqual(result.context_snapshot and result.context_snapshot.recent_memory[0].title, "API memory")
        self.assertEqual(result.role_messages, [{"id": "message-1"}])
        self.assertEqual(result.context_snapshot and result.context_snapshot.avatar_data, b"avatar-bytes")
        self.assertEqual(
            manager.calls,
            [
                ("snapshot", ""),
                ("plans", "Rabi"),
                ("memory", "Rabi"),
                ("messages", "Rabi"),
                ("avatar", "Rabi"),
            ],
        )

    def test_hidden_panel_skips_chat_api(self) -> None:
        manager = _ApiManager()
        service = DesktopRefreshService(manager, Path("C:/repo"))  # type: ignore[arg-type]

        result = service.load(
            ManagerSnapshot(False, manager.manager_url, {}, []),
            "route-1",
            include_role_messages=False,
        )

        self.assertIsNone(result.role_messages)
        self.assertNotIn(("messages", "Rabi"), manager.calls)
        self.assertNotIn(("avatar", "Rabi"), manager.calls)

    def test_role_api_failure_keeps_manager_online_and_preserves_cached_ui_data(self) -> None:
        manager = _ApiManager()
        manager.fail_plans = True
        service = DesktopRefreshService(manager, Path("C:/repo"))  # type: ignore[arg-type]

        result = service.load(
            ManagerSnapshot(False, manager.manager_url, {}, []),
            "route-1",
            include_role_messages=True,
        )

        self.assertTrue(result.manager.connected)
        self.assertIn("plans unavailable", result.manager.error)
        self.assertIsNone(result.plan_snapshot)
        self.assertIsNone(result.context_snapshot)


if __name__ == "__main__":
    unittest.main()
