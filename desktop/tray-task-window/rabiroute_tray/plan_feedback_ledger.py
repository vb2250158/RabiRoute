from __future__ import annotations

import hashlib
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


class PlanFeedbackLedgerError(RuntimeError):
    """Raised when a durable pending operation cannot be recovered safely."""


def default_plan_feedback_ledger_path() -> Path:
    local_app_data = str(os.environ.get("LOCALAPPDATA") or "").strip()
    base = Path(local_app_data) if local_app_data else Path.home() / ".local" / "share"
    return base / "RabiRoute" / "state" / "desktop" / "pending-plan-feedback.json"


class PlanFeedbackLedger:
    """Store only opaque operation hashes and feedback IDs for safe mutation replay."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path
        self._lock = threading.RLock()
        self._memory_entries: dict[str, dict[str, str]] = {}

    @classmethod
    def durable_default(cls) -> PlanFeedbackLedger:
        return cls(default_plan_feedback_ledger_path())

    def reserve(self, scope: str, signature: str) -> str:
        scope_hash = self._scope_hash(scope)
        signature_hash = self._signature_hash(signature)
        with self._lock:
            entries = self._read_entries()
            existing = entries.get(scope_hash)
            if existing:
                if str(existing.get("signatureHash") or "") != signature_hash:
                    raise PlanFeedbackLedgerError(
                        "This plan already has a pending feedback operation; 已有一笔尚未确认的提交，"
                        "请先重试或取得明确的 412 回执。"
                    )
                feedback_id = str(existing.get("feedbackId") or "").strip()
                if feedback_id:
                    self._memory_entries = entries
                    return feedback_id
                raise PlanFeedbackLedgerError("Pending plan feedback ledger contains an invalid feedback id.")

            feedback_id = str(uuid4())
            entries[scope_hash] = {
                "signatureHash": signature_hash,
                "feedbackId": feedback_id,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
            self._write_entries(entries)
            self._memory_entries = entries
            return feedback_id

    def retire(self, scope: str, signature: str, feedback_id: str) -> bool:
        scope_hash = self._scope_hash(scope)
        signature_hash = self._signature_hash(signature)
        with self._lock:
            entries = self._read_entries()
            existing = entries.get(scope_hash)
            if (
                not existing
                or str(existing.get("signatureHash") or "") != signature_hash
                or str(existing.get("feedbackId") or "") != feedback_id
            ):
                self._memory_entries = entries
                return False
            del entries[scope_hash]
            self._write_entries(entries)
            self._memory_entries = entries
            return True

    @staticmethod
    def _scope_hash(scope: str) -> str:
        return hashlib.sha256(f"plan-feedback-scope\0{scope}".encode("utf-8")).hexdigest()

    @staticmethod
    def _signature_hash(signature: str) -> str:
        return hashlib.sha256(f"plan-feedback-signature\0{signature}".encode("utf-8")).hexdigest()

    def _read_entries(self) -> dict[str, dict[str, str]]:
        if self._path is None:
            return dict(self._memory_entries)
        if not self._path.exists():
            return {}
        try:
            value = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise PlanFeedbackLedgerError(f"Pending plan feedback ledger is unreadable: {error}") from error
        if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("entries"), dict):
            raise PlanFeedbackLedgerError("Pending plan feedback ledger has an unsupported schema.")
        entries: dict[str, dict[str, str]] = {}
        for scope_hash, raw_entry in value["entries"].items():
            if not isinstance(scope_hash, str) or not isinstance(raw_entry, dict):
                raise PlanFeedbackLedgerError("Pending plan feedback ledger contains an invalid entry.")
            signature_hash = str(raw_entry.get("signatureHash") or "").strip()
            feedback_id = str(raw_entry.get("feedbackId") or "").strip()
            created_at = str(raw_entry.get("createdAt") or "").strip()
            if len(scope_hash) != 64 or len(signature_hash) != 64 or not feedback_id:
                raise PlanFeedbackLedgerError("Pending plan feedback ledger contains an invalid entry.")
            entries[scope_hash] = {
                "signatureHash": signature_hash,
                "feedbackId": feedback_id,
                "createdAt": created_at,
            }
        return entries

    def _write_entries(self, entries: dict[str, dict[str, str]]) -> None:
        if self._path is None:
            return
        temporary_path = self._path.with_name(f".{self._path.name}.{os.getpid()}.{uuid4().hex}.tmp")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with temporary_path.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump({"version": 1, "entries": entries}, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self._path)
        except OSError as error:
            raise PlanFeedbackLedgerError(f"Pending plan feedback ledger could not be persisted: {error}") from error
        finally:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
