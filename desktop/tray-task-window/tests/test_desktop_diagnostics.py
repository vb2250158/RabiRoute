from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


TRAY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAY_ROOT))

from rabiroute_tray.desktop_diagnostics import DesktopDiagnostics


class DesktopDiagnosticsTest(unittest.TestCase):
    def test_exception_is_written_to_the_current_run_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            reporter = DesktopDiagnostics.start(Path(temp_dir))
            reporter.record_exception("unhandled_exception", RuntimeError("desktop host failed"))
            reporter.close()

            run = json.loads(reporter.run_path.read_text(encoding="utf-8"))
            events = [json.loads(line) for line in reporter.events_path.read_text(encoding="utf-8").splitlines()]

            self.assertEqual(run["status"], "failed")
            exception = next(event for event in events if event["event"] == "unhandled_exception")
            self.assertEqual(exception["details"]["exceptionType"], "RuntimeError")
            self.assertIn("desktop host failed", exception["details"]["traceback"])

    def test_normal_exit_is_recorded_with_its_exit_code(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            reporter = DesktopDiagnostics.start(Path(temp_dir))
            reporter.mark_clean_exit(0)
            reporter.close()

            run = json.loads(reporter.run_path.read_text(encoding="utf-8"))

            self.assertEqual(run["status"], "exited")
            self.assertEqual(run["exitCode"], 0)
            self.assertIn("endedAt", run)

    def test_next_start_reports_an_unclosed_previous_run_without_mutating_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = DesktopDiagnostics.start(root)
            first.close()
            second = DesktopDiagnostics.start(root)
            second.close()

            first_run = json.loads(first.run_path.read_text(encoding="utf-8"))
            events = [json.loads(line) for line in second.events_path.read_text(encoding="utf-8").splitlines()]
            unclosed = next(event for event in events if event["event"] == "previous_run_unclosed")

            self.assertEqual(first_run["status"], "running")
            self.assertEqual(unclosed["details"]["previousSessionId"], first.session_id)


if __name__ == "__main__":
    unittest.main()
