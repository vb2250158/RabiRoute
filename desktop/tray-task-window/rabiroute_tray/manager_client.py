from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
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
        for gateway in self.gateways:
            if gateway.get("agentRoleId") == "Rabi":
                return gateway
        return self.gateways[0]


@dataclass(frozen=True)
class ManualTriggerResult:
    ok: bool
    message: str = ""


class ManagerClient:
    def __init__(self, manager_url: str = "http://127.0.0.1:8790", timeout_seconds: float = 1.5) -> None:
        self.manager_url = manager_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def snapshot(self) -> ManagerSnapshot:
        try:
            meta = self._get_json("/meta")
            gateway_payload = self._get_json("/gateways")
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
                connected=False,
                manager_url=self.manager_url,
                meta={},
                gateways=[],
                error=str(error),
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
            self._post_json(
                f"/gateways/{gateway_id}/manual-trigger",
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

    def _get_json(self, path: str) -> dict[str, Any]:
        with urlopen(f"{self.manager_url}{path}", timeout=self.timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))

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
