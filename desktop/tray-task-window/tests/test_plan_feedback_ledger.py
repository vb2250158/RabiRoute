from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rabiroute_tray.plan_feedback_ledger import (
    PlanFeedbackLedger,
    PlanFeedbackLedgerError,
    default_plan_feedback_ledger_path,
)


class PlanFeedbackLedgerTest(unittest.TestCase):
    def test_pending_feedback_id_survives_a_new_ledger_instance_without_plaintext(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger_path = Path(temp_dir) / "pending-plan-feedback.json"
            scope = "YeYu\0plan-private"
            signature = "signature-private-approval-body"

            first_id = PlanFeedbackLedger(ledger_path).reserve(scope, signature)
            restarted_id = PlanFeedbackLedger(ledger_path).reserve(scope, signature)

            self.assertEqual(restarted_id, first_id)
            serialized = ledger_path.read_text(encoding="utf-8")
            self.assertNotIn("YeYu", serialized)
            self.assertNotIn("plan-private", serialized)
            self.assertNotIn("private-approval-body", serialized)
            payload = json.loads(serialized)
            self.assertEqual(payload["version"], 1)
            scope_hash, entry = next(iter(payload["entries"].items()))
            self.assertEqual(len(scope_hash), 64)
            self.assertEqual(set(entry), {"signatureHash", "feedbackId", "createdAt"})
            self.assertEqual(len(entry["signatureHash"]), 64)
            self.assertEqual(entry["feedbackId"], first_id)

    def test_definitive_retirement_creates_a_new_id_for_a_later_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger_path = Path(temp_dir) / "pending-plan-feedback.json"
            ledger = PlanFeedbackLedger(ledger_path)
            first_id = ledger.reserve("YeYu\0plan-1", "signature-1")

            self.assertTrue(ledger.retire("YeYu\0plan-1", "signature-1", first_id))
            second_id = PlanFeedbackLedger(ledger_path).reserve("YeYu\0plan-1", "signature-1")

            self.assertNotEqual(second_id, first_id)

    def test_changed_payload_cannot_create_a_second_pending_id_for_the_same_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger_path = Path(temp_dir) / "pending-plan-feedback.json"
            scope = "YeYu\0plan-1"
            first_signature = "signature-a"
            first_id = PlanFeedbackLedger(ledger_path).reserve(scope, first_signature)

            with self.assertRaisesRegex(PlanFeedbackLedgerError, "already has a pending"):
                PlanFeedbackLedger(ledger_path).reserve(scope, "signature-b")

            persisted = json.loads(ledger_path.read_text(encoding="utf-8"))
            self.assertEqual(len(persisted["entries"]), 1)
            self.assertEqual(next(iter(persisted["entries"].values()))["feedbackId"], first_id)

            self.assertTrue(PlanFeedbackLedger(ledger_path).retire(scope, first_signature, first_id))
            second_id = PlanFeedbackLedger(ledger_path).reserve(scope, "signature-b")
            self.assertNotEqual(second_id, first_id)

    def test_corrupt_durable_ledger_fails_closed_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger_path = Path(temp_dir) / "pending-plan-feedback.json"
            ledger_path.write_text("not-json", encoding="utf-8")

            with self.assertRaises(PlanFeedbackLedgerError):
                PlanFeedbackLedger(ledger_path).reserve("YeYu\0plan-1", "signature-1")

            self.assertEqual(ledger_path.read_text(encoding="utf-8"), "not-json")

    def test_default_path_is_local_to_the_current_windows_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ, {"LOCALAPPDATA": temp_dir}, clear=False
        ):
            self.assertEqual(
                default_plan_feedback_ledger_path(),
                Path(temp_dir) / "RabiRoute" / "state" / "desktop" / "pending-plan-feedback.json",
            )


if __name__ == "__main__":
    unittest.main()
