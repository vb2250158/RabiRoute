from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .plugin_catalog import (
    DesktopPluginCatalog,
    DesktopPluginCatalogCache,
    DesktopExtensionRegistry,
    DesktopPluginSettingsSection,
    DesktopPluginStatusCard,
    create_builtin_desktop_extension_registry,
)


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


@dataclass(frozen=True)
class SelectionSpeechSettings:
    enabled: bool = False
    advanced: bool = False
    model: str = ""
    read_aloud_enabled: bool = True


@dataclass(frozen=True)
class DesktopSettings:
    screenshot_enabled: bool = False
    screenshot_shortcut: str = "Ctrl+Shift+S"
    screenshot_clipboard_shortcut: str = "Ctrl+Alt+V"
    screenshot_auto_copy: bool = True
    autostart: bool = False
    autostart_configured: bool = False
    theme: str = "system"
    custom_theme: dict[str, Any] | None = None


@dataclass(frozen=True)
class DesktopPluginStatusResult:
    card: DesktopPluginStatusCard
    payload: dict[str, Any] | None = None
    error: str = ""


@dataclass(frozen=True)
class DesktopPluginSettingsResult:
    section: DesktopPluginSettingsSection
    settings: object | None = None
    error: str = ""


@dataclass(frozen=True)
class DesktopPluginSurfaceSnapshot:
    catalog: DesktopPluginCatalog
    statuses: tuple[DesktopPluginStatusResult, ...] = ()
    settings: tuple[DesktopPluginSettingsResult, ...] = ()




@dataclass(frozen=True)
class SpeechActionResult:
    ok: bool
    message: str = ""


@dataclass(frozen=True)
class PlanFeedbackSubmitResult:
    ok: bool
    delivery_status: str = ""
    message: str = ""
    revision_conflict: bool = False
    uncertain: bool = False


class ManagerClient:
    def __init__(
        self,
        manager_url: str,
        *,
        application_generation_id: str,
        manager_instance_id: str,
        timeout_seconds: float = 3.0,
        extension_registry: DesktopExtensionRegistry | None = None,
    ) -> None:
        self.manager_url = manager_url.rstrip("/")
        self.application_generation_id = application_generation_id
        self.manager_instance_id = manager_instance_id
        self.timeout_seconds = timeout_seconds
        self.desktop_extension_registry = extension_registry or create_builtin_desktop_extension_registry()
        self._desktop_plugin_catalog_cache = DesktopPluginCatalogCache(self.desktop_extension_registry)
        self._desktop_plugin_catalog_cache.observe_manager_identity(
            f"{self.application_generation_id}:{self.manager_instance_id}"
        )

    def _identity_error(self, meta: object) -> str:
        if not isinstance(meta, dict):
            return "Manager /meta did not return an object."
        actual_generation = str(meta.get("applicationGenerationId") or "").strip()
        actual_manager = str(meta.get("managerInstanceId") or "").strip()
        if actual_generation != self.application_generation_id:
            return (
                "Manager application generation mismatch: "
                f"expected {self.application_generation_id}, received {actual_generation or '<missing>'}."
            )
        if actual_manager != self.manager_instance_id:
            return (
                "Manager instance mismatch: "
                f"expected {self.manager_instance_id}, received {actual_manager or '<missing>'}."
            )
        return ""

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

        identity_error = self._identity_error(meta)
        if identity_error:
            return ManagerSnapshot(
                connected=False,
                manager_url=self.manager_url,
                meta=meta if isinstance(meta, dict) else {},
                gateways=[],
                error=identity_error,
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

    def selection_speech_settings(self) -> SelectionSpeechSettings:
        payload = self._get_json("/api/speech/selection-reader/settings")
        data = payload.get("data")
        row = data if isinstance(data, dict) else {}
        return SelectionSpeechSettings(
            enabled=row.get("enabled") is True,
            advanced=row.get("advanced") is True,
            model=str(row.get("model") or "").strip()[:200],
            read_aloud_enabled=row.get("readAloudEnabled", True) is True,
        )

    def desktop_plugin_catalog(self) -> DesktopPluginCatalog:
        identity_revision = self._desktop_plugin_catalog_cache.request_identity_revision()
        try:
            payload = self._get_json("/api/plugins/catalog?host=desktop")
        except (OSError, URLError, TimeoutError, json.JSONDecodeError):
            return self._desktop_plugin_catalog_cache.fallback()
        return self._desktop_plugin_catalog_cache.accept_payload(payload, identity_revision)

    def desktop_plugin_status_payload(self, card: DesktopPluginStatusCard) -> dict[str, Any]:
        try:
            payload = self.desktop_extension_registry.query_status(card, self._get_json)
        except LookupError as error:
            raise ValueError(str(error)) from error
        if payload.get("code") != 0 or not isinstance(payload.get("data"), dict):
            raise ValueError(f"Manager plugin query returned an invalid response: {card.query_id}")
        return payload

    def desktop_plugin_settings_value(self, section: DesktopPluginSettingsSection) -> object:
        try:
            return self.desktop_extension_registry.read_settings(section, self.desktop_settings)
        except LookupError as error:
            raise ValueError(str(error)) from error

    def desktop_plugin_surface_snapshot(self) -> DesktopPluginSurfaceSnapshot:
        catalog = self.desktop_plugin_catalog()
        status_cache: dict[str, tuple[dict[str, Any] | None, str]] = {}
        statuses: list[DesktopPluginStatusResult] = []
        for card in catalog.status_cards:
            cached = status_cache.get(card.query_id)
            if cached is None:
                try:
                    cached = (self.desktop_plugin_status_payload(card), "")
                except (OSError, URLError, TimeoutError, json.JSONDecodeError, ValueError) as error:
                    cached = (None, str(error))
                status_cache[card.query_id] = cached
            payload, error = cached
            statuses.append(DesktopPluginStatusResult(card=card, payload=payload, error=error))

        settings_cache: dict[str, tuple[object | None, str]] = {}
        settings: list[DesktopPluginSettingsResult] = []
        for section in catalog.settings_sections:
            cached = settings_cache.get(section.read_command_id)
            if cached is None:
                try:
                    cached = (self.desktop_plugin_settings_value(section), "")
                except (OSError, URLError, TimeoutError, json.JSONDecodeError, ValueError) as error:
                    cached = (None, str(error))
                settings_cache[section.read_command_id] = cached
            value, error = cached
            settings.append(DesktopPluginSettingsResult(section=section, settings=value, error=error))

        return DesktopPluginSurfaceSnapshot(
            catalog=catalog,
            statuses=tuple(statuses),
            settings=tuple(settings),
        )

    def desktop_settings(self) -> DesktopSettings:
        payload = self._get_json("/api/desktop/settings")
        data = payload.get("data")
        row = data if isinstance(data, dict) else {}
        screenshot = row.get("screenshot") if isinstance(row.get("screenshot"), dict) else {}
        requested_theme = str(row.get("theme") or "system").strip().lower()
        custom_themes = row.get("customThemes") if isinstance(row.get("customThemes"), list) else []
        custom_theme = next(
            (item for item in custom_themes if isinstance(item, dict) and item.get("id") == requested_theme),
            None,
        )
        theme = requested_theme if requested_theme in {"system", "light", "dark"} or custom_theme is not None else "system"
        return DesktopSettings(
            screenshot_enabled=screenshot.get("enabled") is True,
            screenshot_shortcut=str(screenshot.get("shortcut") or "Ctrl+Shift+S").strip()[:80],
            screenshot_clipboard_shortcut=str(screenshot.get("clipboardShortcut") or "Ctrl+Alt+V").strip()[:80],
            screenshot_auto_copy=screenshot.get("autoCopy", True) is not False,
            autostart=row.get("autostart") is True,
            autostart_configured=row.get("autostartConfigured") is True,
            theme=theme,
            custom_theme=custom_theme,
        )

    def speech_models(self) -> list[dict[str, Any]]:
        payload = self._get_json("/api/speech/models")
        data = payload.get("data")
        rows = data.get("models") if isinstance(data, dict) else []
        return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []

    def synthesize_speech(self, text: str, model: str) -> SpeechActionResult:
        try:
            self._post_binary(
                "/api/speech/tts",
                {
                    "model": model,
                    "input": text,
                    "voice": "default",
                    "responseFormat": "wav",
                    "speed": 1,
                    "language": None,
                    "instructions": None,
                    "sampleRate": None,
                    "play": True,
                    "sessionId": None,
                    "routeId": None,
                },
                timeout_seconds=120,
            )
            return SpeechActionResult(ok=True)
        except HTTPError as error:
            return SpeechActionResult(ok=False, message=self._error_message(error))
        except (OSError, URLError, TimeoutError) as error:
            return SpeechActionResult(ok=False, message=str(error))

    def submit_plan_feedback(
        self,
        role_id: str,
        plan_id: str,
        gateway_id: str,
        step_id: str,
        feedback_id: str,
        text: str,
    ) -> PlanFeedbackSubmitResult:
        mutation_started = False
        try:
            encoded_role_id = quote(role_id, safe="")
            encoded_plan_id = quote(plan_id, safe="")
            path = f"/api/roles/{encoded_role_id}/plans/{encoded_plan_id}/feedback"
            identity_error = self._identity_error(self._get_json("/meta"))
            if identity_error:
                return PlanFeedbackSubmitResult(ok=False, message=identity_error)
            _, revision = self._get_json_resource(path)
            if not re.fullmatch(r'"[^"\r\n]+"', revision) or revision.startswith("W/"):
                return PlanFeedbackSubmitResult(
                    ok=False,
                    message="Manager did not return a strong plan storage ETag.",
                )
            identity_error = self._identity_error(self._get_json("/meta"))
            if identity_error:
                return PlanFeedbackSubmitResult(ok=False, message=identity_error)
            idempotency_key = f"plan-feedback:{feedback_id}"
            mutation_started = True
            payload, response_headers = self._post_json_resource(
                path,
                {
                    "feedbackId": feedback_id,
                    "gatewayId": gateway_id,
                    "stepId": step_id or None,
                    "text": text,
                    "source": "tray",
                    "kind": "approval_suggestion",
                    "author": "user",
                    "notifyAgent": True,
                },
                timeout_seconds=5,
                headers={
                    "Idempotency-Key": idempotency_key,
                    "If-Match": revision,
                },
            )
            try:
                identity_error = self._identity_error(self._get_json("/meta"))
            except (OSError, URLError, TimeoutError, json.JSONDecodeError) as error:
                return PlanFeedbackSubmitResult(
                    ok=False,
                    message=f"Feedback commit result is uncertain because Manager identity could not be confirmed: {error}",
                    uncertain=True,
                )
            if identity_error:
                return PlanFeedbackSubmitResult(
                    ok=False,
                    message=f"Feedback commit result is uncertain after Manager lifecycle changed: {identity_error}",
                    uncertain=True,
                )
            receipt_key = next(
                (value for name, value in response_headers.items() if name.lower() == "idempotency-key"),
                "",
            ).strip()
            committed_revision = next(
                (value for name, value in response_headers.items() if name.lower() == "etag"),
                "",
            ).strip()
            if receipt_key != idempotency_key:
                return PlanFeedbackSubmitResult(
                    ok=False,
                    message="Manager feedback receipt did not confirm the submitted Idempotency-Key.",
                    uncertain=True,
                )
            if not re.fullmatch(r'"[^"\r\n]+"', committed_revision) or committed_revision.startswith("W/"):
                return PlanFeedbackSubmitResult(
                    ok=False,
                    message="Manager feedback receipt did not include a strong committed ETag.",
                    uncertain=True,
                )
            data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
            delivery_status = str(data.get("deliveryStatus") or "")
            if str(data.get("id") or "") != feedback_id or str(data.get("planId") or "") != plan_id:
                return PlanFeedbackSubmitResult(
                    ok=False,
                    message="Manager feedback receipt body did not confirm the submitted feedback identity and plan.",
                    uncertain=True,
                )
            if payload.get("code") != 0 or delivery_status not in {"pending", "delivered", "failed"}:
                return PlanFeedbackSubmitResult(
                    ok=False,
                    message="Manager feedback receipt body is incomplete or invalid.",
                    uncertain=True,
                )
            return PlanFeedbackSubmitResult(
                ok=delivery_status in {"pending", "delivered"},
                delivery_status=delivery_status,
                message=str(data.get("deliveryMessage") or ""),
            )
        except HTTPError as error:
            return PlanFeedbackSubmitResult(
                ok=False,
                message=self._error_message(error),
                revision_conflict=error.code == 412,
                uncertain=mutation_started and error.code != 412,
            )
        except (OSError, URLError, TimeoutError, json.JSONDecodeError) as error:
            return PlanFeedbackSubmitResult(ok=False, message=str(error), uncertain=mutation_started)

    def _get_json(self, path: str) -> dict[str, Any]:
        with urlopen(f"{self.manager_url}{path}", timeout=self.timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))

    def _get_json_resource(self, path: str) -> tuple[dict[str, Any], str]:
        with urlopen(f"{self.manager_url}{path}", timeout=self.timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return payload, str(response.headers.get("ETag") or "").strip()

    def _get_bytes(self, path: str) -> bytes:
        with urlopen(f"{self.manager_url}{path}", timeout=self.timeout_seconds) as response:
            return response.read()

    def _post_json(
        self,
        path: str,
        payload: dict[str, Any] | None = None,
        timeout_seconds: float | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        return self._post_json_resource(path, payload, timeout_seconds, headers)[0]

    def _post_json_resource(
        self,
        path: str,
        payload: dict[str, Any] | None = None,
        timeout_seconds: float | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[dict[str, Any], dict[str, str]]:
        data = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
        request = Request(f"{self.manager_url}{path}", data=data, method="POST")
        request.add_header("content-type", "application/json; charset=utf-8")
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        with urlopen(request, timeout=timeout_seconds or self.timeout_seconds) as response:
            return (
                json.loads(response.read().decode("utf-8")),
                {str(name): str(value) for name, value in response.headers.items()},
            )

    def _post_binary(self, path: str, payload: dict[str, Any], timeout_seconds: float | None = None) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = Request(f"{self.manager_url}{path}", data=data, method="POST")
        request.add_header("content-type", "application/json; charset=utf-8")
        with urlopen(request, timeout=timeout_seconds or self.timeout_seconds):
            return

    def _error_message(self, error: HTTPError) -> str:
        try:
            body = error.read().decode("utf-8")
            payload = json.loads(body)
            if isinstance(payload, dict) and payload.get("message"):
                return str(payload["message"])
            return body or str(error)
        except Exception:
            return str(error)
