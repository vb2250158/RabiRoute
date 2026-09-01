from __future__ import annotations

import io
import json
import unittest
from urllib.error import HTTPError
from urllib.parse import unquote

from rabiroute_tray.manager_client import ManagerClient, ManagerSnapshot


class _RecordingManagerClient(ManagerClient):
    def __init__(self) -> None:
        super().__init__(
            "http://127.0.0.1:8790",
            application_generation_id="app-generation",
            manager_instance_id="manager-instance",
        )
        self.paths: list[str] = []
        self.posts: list[tuple[str, dict]] = []
        self.post_timeouts: list[float | None] = []
        self.post_headers: list[dict[str, str]] = []
        self.binary_posts: list[tuple[str, dict, float | None]] = []

    def _get_json(self, path: str) -> dict:
        self.paths.append(path)
        if path == "/meta":
            return {
                "version": "test",
                "health": {"pid": 321},
                "applicationGenerationId": "app-generation",
                "managerInstanceId": "manager-instance",
            }
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

    def _get_json_resource(self, path: str) -> tuple[dict, str]:
        self.paths.append(path)
        return {"code": 0, "data": {"count": 0, "records": []}}, '"plan-revision-1"'

    def _post_json(
        self,
        path: str,
        payload: dict | None = None,
        timeout_seconds: float | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict:
        self.posts.append((path, payload or {}))
        self.post_timeouts.append(timeout_seconds)
        self.post_headers.append(headers or {})
        return {"code": 0, "data": {"deliveryStatus": "delivered"}}

    def _post_json_resource(
        self,
        path: str,
        payload: dict | None = None,
        timeout_seconds: float | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[dict, dict[str, str]]:
        self.posts.append((path, payload or {}))
        self.post_timeouts.append(timeout_seconds)
        self.post_headers.append(headers or {})
        request_headers = headers or {}
        encoded_plan_id = path.split("/plans/", 1)[1].removesuffix("/feedback")
        return (
            {
                "code": 0,
                "data": {
                    "id": str((payload or {}).get("feedbackId") or ""),
                    "planId": unquote(encoded_plan_id),
                    "deliveryStatus": "delivered",
                },
            },
            {
                "Idempotency-Key": request_headers.get("Idempotency-Key", ""),
                "ETag": '"plan-revision-2"',
            },
        )

    def _post_binary(self, path: str, payload: dict, timeout_seconds: float | None = None) -> None:
        self.binary_posts.append((path, payload, timeout_seconds))


class ManagerSnapshotTest(unittest.TestCase):
    def test_desktop_settings_reads_shared_theme(self) -> None:
        client = _RecordingManagerClient()
        client._get_json = lambda path: {"data": {"theme": "dark", "screenshot": {"enabled": True}}}  # type: ignore[method-assign]

        settings = client.desktop_settings()

        self.assertTrue(settings.screenshot_enabled)
        self.assertEqual(settings.theme, "dark")
        self.assertFalse(settings.autostart_configured)

    def test_desktop_settings_preserves_explicit_autostart_tristate(self) -> None:
        client = _RecordingManagerClient()
        client._get_json = lambda path: {"data": {"autostart": False, "autostartConfigured": True}}  # type: ignore[method-assign]

        settings = client.desktop_settings()

        self.assertFalse(settings.autostart)
        self.assertTrue(settings.autostart_configured)

    def test_desktop_settings_reads_selected_custom_theme_definition(self) -> None:
        client = _RecordingManagerClient()
        custom = {"id": "custom:night-rain-green", "name": "夜雨绿", "baseTheme": "dark", "colors": {"accent": "#22c55e"}}
        client._get_json = lambda path: {"data": {"theme": custom["id"], "customThemes": [custom]}}  # type: ignore[method-assign]

        settings = client.desktop_settings()

        self.assertEqual(settings.theme, custom["id"])
        self.assertEqual(settings.custom_theme, custom)

    def test_snapshot_requests_lightweight_gateway_summary(self) -> None:
        client = _RecordingManagerClient()

        snapshot = client.snapshot()

        self.assertEqual(client.paths, ["/meta", "/gateways?summary=1"])
        self.assertEqual(snapshot.gateways, [{"id": "route-1"}])

    def test_snapshot_rejects_a_different_application_generation_before_reading_gateways(self) -> None:
        client = _RecordingManagerClient()
        client._get_json = lambda path: {  # type: ignore[method-assign]
            "applicationGenerationId": "stale-generation",
            "managerInstanceId": "manager-instance",
        }

        snapshot = client.snapshot()

        self.assertFalse(snapshot.connected)
        self.assertEqual(snapshot.gateways, [])
        self.assertIn("application generation mismatch", snapshot.error)

    def test_snapshot_rejects_a_different_manager_instance_before_reading_gateways(self) -> None:
        client = _RecordingManagerClient()
        client._get_json = lambda path: {  # type: ignore[method-assign]
            "applicationGenerationId": "app-generation",
            "managerInstanceId": "replacement-manager",
        }

        snapshot = client.snapshot()

        self.assertFalse(snapshot.connected)
        self.assertEqual(snapshot.gateways, [])
        self.assertIn("Manager instance mismatch", snapshot.error)

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
        self.assertEqual(client.post_headers, [{
            "Idempotency-Key": "plan-feedback:feedback-1",
            "If-Match": '"plan-revision-1"',
        }])
        self.assertEqual(client.paths, [
            "/meta",
            "/api/roles/Rabi%20%2F%20%E6%B5%8B%E8%AF%95/plans/plan%20%2F%201/feedback",
            "/meta",
            "/meta",
        ])

    def test_plan_feedback_surfaces_revision_conflict_for_reload_and_same_key_retry(self) -> None:
        client = _RecordingManagerClient()

        def conflict(*_args, **_kwargs):
            body = io.BytesIO(json.dumps({"message": "revision changed"}).encode("utf-8"))
            raise HTTPError("http://manager/feedback", 412, "Precondition Failed", {}, body)

        client._post_json_resource = conflict  # type: ignore[method-assign]
        result = client.submit_plan_feedback(
            "YeYu",
            "plan-1",
            "route-1",
            "verify",
            "feedback-1",
            "建议补充回归范围。",
        )

        self.assertFalse(result.ok)
        self.assertTrue(result.revision_conflict)
        self.assertFalse(result.uncertain)
        self.assertEqual(result.message, "revision changed")

    def test_plan_feedback_rejects_a_success_body_without_durable_receipt_headers(self) -> None:
        client = _RecordingManagerClient()
        client._post_json_resource = lambda *_args, **_kwargs: (  # type: ignore[method-assign]
            {"code": 0, "data": {"deliveryStatus": "delivered"}},
            {},
        )

        result = client.submit_plan_feedback(
            "YeYu", "plan-1", "route-1", "verify", "feedback-receipt", "批准。"
        )

        self.assertFalse(result.ok)
        self.assertTrue(result.uncertain)
        self.assertIn("Idempotency-Key", result.message)

    def test_plan_feedback_rejects_a_weak_committed_revision(self) -> None:
        client = _RecordingManagerClient()
        client._post_json_resource = lambda *_args, **_kwargs: (  # type: ignore[method-assign]
            {"code": 0, "data": {"deliveryStatus": "delivered"}},
            {"Idempotency-Key": "plan-feedback:feedback-weak", "ETag": 'W/"revision-2"'},
        )

        result = client.submit_plan_feedback(
            "YeYu", "plan-1", "route-1", "verify", "feedback-weak", "批准。"
        )

        self.assertFalse(result.ok)
        self.assertTrue(result.uncertain)
        self.assertIn("strong committed ETag", result.message)

    def test_plan_feedback_rejects_a_receipt_for_a_different_feedback_identity(self) -> None:
        client = _RecordingManagerClient()
        client._post_json_resource = lambda *_args, **_kwargs: (  # type: ignore[method-assign]
            {
                "code": 0,
                "data": {
                    "id": "different-feedback",
                    "planId": "plan-1",
                    "deliveryStatus": "delivered",
                },
            },
            {
                "Idempotency-Key": "plan-feedback:feedback-identity",
                "ETag": '"plan-revision-2"',
            },
        )

        result = client.submit_plan_feedback(
            "YeYu", "plan-1", "route-1", "verify", "feedback-identity", "批准。"
        )

        self.assertFalse(result.ok)
        self.assertTrue(result.uncertain)
        self.assertIn("feedback identity", result.message)

    def test_plan_feedback_rejects_a_receipt_for_a_different_plan_identity(self) -> None:
        client = _RecordingManagerClient()
        client._post_json_resource = lambda *_args, **_kwargs: (  # type: ignore[method-assign]
            {
                "code": 0,
                "data": {
                    "id": "feedback-plan-identity",
                    "planId": "different-plan",
                    "deliveryStatus": "delivered",
                },
            },
            {
                "Idempotency-Key": "plan-feedback:feedback-plan-identity",
                "ETag": '"plan-revision-2"',
            },
        )

        result = client.submit_plan_feedback(
            "YeYu", "plan-1", "route-1", "verify", "feedback-plan-identity", "批准。"
        )

        self.assertFalse(result.ok)
        self.assertTrue(result.uncertain)
        self.assertIn("feedback identity", result.message)

    def test_plan_feedback_keeps_the_operation_uncertain_when_manager_changes_after_commit(self) -> None:
        client = _RecordingManagerClient()
        meta_reads = 0

        def changing_meta(path: str) -> dict:
            nonlocal meta_reads
            if path != "/meta":
                return {"code": 0, "data": {}}
            meta_reads += 1
            return {
                "applicationGenerationId": "replacement-generation" if meta_reads >= 3 else "app-generation",
                "managerInstanceId": "replacement-manager" if meta_reads >= 3 else "manager-instance",
            }

        client._get_json = changing_meta  # type: ignore[method-assign]
        result = client.submit_plan_feedback(
            "YeYu", "plan-1", "route-1", "verify", "feedback-uncertain", "批准。"
        )

        self.assertFalse(result.ok)
        self.assertTrue(result.uncertain)
        self.assertIn("uncertain", result.message)

    def test_plan_feedback_keeps_the_operation_uncertain_when_post_commit_meta_is_unavailable(self) -> None:
        client = _RecordingManagerClient()
        meta_reads = 0

        def unavailable_meta(path: str) -> dict:
            nonlocal meta_reads
            if path != "/meta":
                return {"code": 0, "data": {}}
            meta_reads += 1
            if meta_reads >= 3:
                raise TimeoutError("post-commit meta timed out")
            return {
                "applicationGenerationId": "app-generation",
                "managerInstanceId": "manager-instance",
            }

        client._get_json = unavailable_meta  # type: ignore[method-assign]
        result = client.submit_plan_feedback(
            "YeYu", "plan-1", "route-1", "verify", "feedback-meta-timeout", "批准。"
        )

        self.assertFalse(result.ok)
        self.assertTrue(result.uncertain)
        self.assertIn("identity could not be confirmed", result.message)

    def test_plan_feedback_keeps_the_operation_uncertain_when_post_commit_meta_is_incomplete(self) -> None:
        client = _RecordingManagerClient()
        meta_reads = 0

        def incomplete_meta(path: str) -> dict:
            nonlocal meta_reads
            if path != "/meta":
                return {"code": 0, "data": {}}
            meta_reads += 1
            return {
                "applicationGenerationId": "app-generation",
                **({"managerInstanceId": "manager-instance"} if meta_reads < 3 else {}),
            }

        client._get_json = incomplete_meta  # type: ignore[method-assign]
        result = client.submit_plan_feedback(
            "YeYu", "plan-1", "route-1", "verify", "feedback-meta-incomplete", "批准。"
        )

        self.assertFalse(result.ok)
        self.assertTrue(result.uncertain)
        self.assertIn("<missing>", result.message)

    def test_plan_feedback_503_and_timeout_keep_the_operation_uncertain(self) -> None:
        for error in (
            HTTPError(
                "http://manager/feedback",
                503,
                "Service Unavailable",
                {},
                io.BytesIO(json.dumps({"message": "storage busy"}).encode("utf-8")),
            ),
            TimeoutError("response timed out"),
        ):
            with self.subTest(error=type(error).__name__):
                client = _RecordingManagerClient()

                def fail(*_args, **_kwargs):
                    raise error

                client._post_json_resource = fail  # type: ignore[method-assign]
                result = client.submit_plan_feedback(
                    "YeYu", "plan-1", "route-1", "verify", "feedback-retry", "批准。"
                )

                self.assertFalse(result.ok)
                self.assertTrue(result.uncertain)
                self.assertFalse(result.revision_conflict)

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
