from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class ManagerSnapshot:
    connected: bool
    manager_url: str
    meta: dict[str, Any]
    gateways: list[dict[str, Any]]
    error: str = ""

    @property
    def selected_gateway(self) -> dict[str, Any] | None:
        if not self.gateways:
            return None
        enabled_gateways = [gateway for gateway in self.gateways if gateway.get("enabled") is True]
        if len(enabled_gateways) == 1:
            return enabled_gateways[0]
        for gateway in self.gateways:
            if gateway.get("agentRoleId") == "Rabi":
                return gateway
        return self.gateways[0]


@dataclass(frozen=True)
class ManualTriggerResult:
    ok: bool
    message: str = ""


@dataclass(frozen=True)
class RolePanelSendResult:
    ok: bool
    message: str = ""


class ManagerClient:
    def __init__(self, manager_url: str = "http://127.0.0.1:8790", timeout_seconds: float = 3.0) -> None:
        self.manager_url = manager_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def snapshot(self) -> ManagerSnapshot:
        try:
            meta = self._get_json("/meta")
        except (OSError, URLError, TimeoutError, json.JSONDecodeError) as error:
            return ManagerSnapshot(
                connected=False,
                manager_url=self.manager_url,
                meta={},
                gateways=[],
                error=str(error),
            )

        try:
            gateway_payload = self._get_json("/gateways?summary=1")
            manager_rows = gateway_payload.get("data", {}).get("manager", [])
            gateways = manager_rows if isinstance(manager_rows, list) else []
            return ManagerSnapshot(
                connected=True,
                manager_url=self.manager_url,
                meta=meta if isinstance(meta, dict) else {},
                gateways=[row for row in gateways if isinstance(row, dict)],
            )
        except (OSError, URLError, TimeoutError, json.JSONDecodeError) as error:
            return ManagerSnapshot(
                connected=True,
                manager_url=self.manager_url,
                meta=meta if isinstance(meta, dict) else {},
                gateways=[],
                error=f"gateway status unavailable: {error}",
            )

    def shutdown(self) -> bool:
        try:
            self._post_json("/manager/shutdown")
            return True
        except (OSError, URLError, TimeoutError, json.JSONDecodeError):
            return False

    def manual_trigger(
        self,
        gateway_id: str,
        trigger_id: str,
        trigger_name: str,
        message: str,
        route_kind: str = "manual_trigger",
        rule_id: str | None = None,
    ) -> ManualTriggerResult:
        try:
            encoded_gateway_id = quote(gateway_id, safe="")
            self._post_json(
                f"/gateways/{encoded_gateway_id}/manual-trigger",
                {
                    "triggerId": trigger_id,
                    "triggerName": trigger_name,
                    "message": message,
                    "routeKind": route_kind,
                    "ruleId": rule_id or trigger_id,
                },
                timeout_seconds=45,
            )
            return ManualTriggerResult(ok=True)
        except HTTPError as error:
            return ManualTriggerResult(ok=False, message=self._error_message(error))
        except (OSError, URLError, TimeoutError, json.JSONDecodeError) as error:
            return ManualTriggerResult(ok=False, message=str(error))

    def role_panel_messages(self, role_id: str, limit: int = 120) -> list[dict[str, Any]]:
        try:
            return self.role_panel_messages_snapshot(role_id, limit)
        except (OSError, URLError, TimeoutError, json.JSONDecodeError, ValueError):
            return []

    def role_panel_messages_snapshot(self, role_id: str, limit: int = 120) -> list[dict[str, Any]]:
        encoded_role_id = quote(role_id, safe="")
        payload = self._get_json(f"/api/roles/{encoded_role_id}/role-panel/messages?limit={limit}")
        messages = payload.get("messages", [])
        if not isinstance(messages, list):
            raise ValueError("Manager role-panel response does not contain a messages list.")
        return [item for item in messages if isinstance(item, dict)]

    def role_plans(self, role_id: str) -> list[dict[str, Any]]:
        encoded_role_id = quote(role_id, safe="")
        payload = self._get_json(f"/api/roles/{encoded_role_id}/plans")
        data = payload.get("data")
        if not isinstance(data, list):
            raise ValueError("Manager plans response does not contain a data list.")
        return [item for item in data if isinstance(item, dict)]

    def role_memory(self, role_id: str) -> dict[str, Any]:
        encoded_role_id = quote(role_id, safe="")
        payload = self._get_json(f"/api/roles/{encoded_role_id}/memory")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise ValueError("Manager memory response does not contain a data object.")
        return data

    def role_avatar(self, role_id: str) -> bytes | None:
        encoded_role_id = quote(role_id, safe="")
        try:
            return self._get_bytes(f"/api/roles/{encoded_role_id}/avatar")
        except HTTPError as error:
            if error.code == 404:
                return None
            raise

    def send_role_panel_message(
        self,
        gateway_id: str,
        text: str,
        attachments: list[dict[str, Any]] | None = None,
    ) -> RolePanelSendResult:
        try:
            self._post_json(
                "/api/role-panel/messages",
                {
                    "gatewayId": gateway_id,
                    "text": text,
                    "attachments": attachments or [],
                },
                timeout_seconds=45,
            )
            return RolePanelSendResult(ok=True)
        except HTTPError as error:
            return RolePanelSendResult(ok=False, message=self._error_message(error))
        except (OSError, URLError, TimeoutError, json.JSONDecodeError) as error:
            return RolePanelSendResult(ok=False, message=str(error))

    @staticmethod
    def attachment_from_path(file_path: Path) -> dict[str, Any]:
        try:
            size = file_path.stat().st_size
        except OSError:
            size = 0
        return {
            "kind": "file",
            "name": file_path.name,
            "path": str(file_path),
            "size": size,
        }

    def _get_json(self, path: str) -> dict[str, Any]:
        with urlopen(f"{self.manager_url}{path}", timeout=self.timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))

    def _get_bytes(self, path: str) -> bytes:
        with urlopen(f"{self.manager_url}{path}", timeout=self.timeout_seconds) as response:
            return response.read()

    def _post_json(self, path: str, payload: dict[str, Any] | None = None, timeout_seconds: float | None = None) -> dict[str, Any]:
        data = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
        request = Request(f"{self.manager_url}{path}", data=data, method="POST")
        request.add_header("content-type", "application/json; charset=utf-8")
        with urlopen(request, timeout=timeout_seconds or self.timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))

    def _error_message(self, error: HTTPError) -> str:
        try:
            body = error.read().decode("utf-8")
            payload = json.loads(body)
            if isinstance(payload, dict) and payload.get("message"):
                return str(payload["message"])
            return body or str(error)
        except Exception:
            return str(error)
