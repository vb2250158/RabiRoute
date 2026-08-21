from __future__ import annotations

import unittest

from rabiroute_tray.manager_client import ManagerClient, ManagerSnapshot


class _RecordingManagerClient(ManagerClient):
    def __init__(self) -> None:
        super().__init__()
        self.paths: list[str] = []
        self.posts: list[tuple[str, dict]] = []
        self.post_timeouts: list[float | None] = []
        self.binary_posts: list[tuple[str, dict, float | None]] = []

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
        if path == "/api/speech/selection-reader/settings":
            return {"code": 0, "data": {"enabled": True, "advanced": True, "model": "tts/test"}}
        if path == "/api/speech/models":
            return {"code": 0, "data": {"models": [{"id": "tts/test", "capability": "tts"}]}}
        return {"data": {"manager": [{"id": "route-1"}]}}

    def _get_bytes(self, path: str) -> bytes:
        self.paths.append(path)
        return b"avatar"

    def _post_json(self, path: str, payload: dict | None = None, timeout_seconds: float | None = None) -> dict:
        self.posts.append((path, payload or {}))
        self.post_timeouts.append(timeout_seconds)
        return {"code": 0, "data": {"deliveryStatus": "delivered"}}

    def _post_binary(self, path: str, payload: dict, timeout_seconds: float | None = None) -> None:
        self.binary_posts.append((path, payload, timeout_seconds))


class ManagerSnapshotTest(unittest.TestCase):
    def test_shutdown_marks_an_explicit_desktop_exit(self) -> None:
        client = _RecordingManagerClient()

        self.assertTrue(client.shutdown())

        self.assertEqual(client.posts, [("/manager/shutdown", {"desktopExit": True})])

    def test_desktop_settings_reads_shared_theme(self) -> None:
        client = _RecordingManagerClient()
        client._get_json = lambda path: {"data": {"theme": "dark", "screenshot": {"enabled": True}}}  # type: ignore[method-assign]

        settings = client.desktop_settings()

        self.assertTrue(settings.screenshot_enabled)
        self.assertEqual(settings.theme, "dark")

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

    def test_plan_feedback_uses_manager_plan_endpoint(self) -> None:
        client = _RecordingManagerClient()

        result = client.submit_plan_feedback(
            "Rabi / 测试",
            "plan / 1",
            "route-1",
            "verify",
            "feedback-1",
            "建议补充回归范围。",
        )

        self.assertTrue(result.ok)
        self.assertEqual(result.delivery_status, "delivered")
        self.assertEqual(client.posts[0][0], "/api/roles/Rabi%20%2F%20%E6%B5%8B%E8%AF%95/plans/plan%20%2F%201/feedback")
        self.assertEqual(client.posts[0][1]["source"], "tray")
        self.assertEqual(client.posts[0][1]["stepId"], "verify")
        self.assertEqual(client.post_timeouts, [5])

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

    def test_selection_speech_uses_manager_settings_models_and_host_queue(self) -> None:
        client = _RecordingManagerClient()

        settings = client.selection_speech_settings()
        models = client.speech_models()
        result = client.synthesize_speech("划选文字", "tts/test")

        self.assertTrue(settings.enabled)
        self.assertTrue(settings.advanced)
        self.assertTrue(settings.read_aloud_enabled)
        self.assertEqual(settings.model, "tts/test")
        self.assertEqual(models, [{"id": "tts/test", "capability": "tts"}])
        self.assertTrue(result.ok)
        self.assertEqual(client.binary_posts[0][0], "/api/speech/tts")
        self.assertEqual(client.binary_posts[0][1]["input"], "划选文字")
        self.assertTrue(client.binary_posts[0][1]["play"])
        self.assertEqual(client.binary_posts[0][2], 120)

    def test_screenshot_message_keeps_text_and_image_on_role_panel_endpoint(self) -> None:
        client = _RecordingManagerClient()

        result = client.send_role_panel_message(
            "route-screenshot",
            "请查看这张截图。",
            [{"kind": "image", "name": "screenshot.png", "path": "C:/tmp/screenshot.png", "size": 128}],
        )

        self.assertTrue(result.ok)
        self.assertEqual(client.posts[0], (
            "/api/role-panel/messages",
            {
                "gatewayId": "route-screenshot",
                "text": "请查看这张截图。",
                "attachments": [{"kind": "image", "name": "screenshot.png", "path": "C:/tmp/screenshot.png", "size": 128}],
            },
        ))
        self.assertEqual(client.post_timeouts, [45])


if __name__ == "__main__":
    unittest.main()
