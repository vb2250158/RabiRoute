from __future__ import annotations

import atexit
import faulthandler
import json
import os
import sys
import tempfile
import threading
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO


def local_desktop_diagnostics_root() -> Path:
    """Return the local-only evidence store for desktop host runs."""
    local_app_data = os.environ.get("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path(tempfile.gettempdir())
    return base / "RabiRoute" / "diagnostics" / "desktop"


class _TeeStream:
    def __init__(self, original: TextIO | None, destination: TextIO) -> None:
        self._original = original
        self._destination = destination

    @property
    def encoding(self) -> str:
        return "utf-8"

    def write(self, text: str) -> int:
        if self._original is not None:
            try:
                self._original.write(text)
            except (OSError, ValueError):
                pass
        self._destination.write(text)
        self._destination.flush()
        return len(text)

    def flush(self) -> None:
        if self._original is not None:
            try:
                self._original.flush()
            except (OSError, ValueError):
                pass
        self._destination.flush()

    def isatty(self) -> bool:
        return False


class DesktopDiagnostics:
    """Local, append-only evidence for a single RabiRoute Desktop process."""

    def __init__(self, diagnostics_root: Path, session_id: str, started_at: str) -> None:
        self.diagnostics_root = diagnostics_root
        self.session_id = session_id
        self.started_at = started_at
        self.session_dir = diagnostics_root / started_at[:10] / session_id
        self.events_path = self.session_dir / "events.jsonl"
        self.run_path = self.session_dir / "run.json"
        self.stdout_path = self.session_dir / "stdout.log"
        self.stderr_path = self.session_dir / "stderr.log"
        self.fault_path = self.session_dir / "faulthandler.log"
        self._lock = threading.Lock()
        self._status = "running"
        self._original_stdout: TextIO | None = None
        self._original_stderr: TextIO | None = None
        self._stdout_handle: TextIO | None = None
        self._stderr_handle: TextIO | None = None
        self._fault_handle: Any = None
        self._original_excepthook = None
        self._original_threading_excepthook = None
        self._closed = False

    @classmethod
    def start(cls, diagnostics_root: Path | None = None) -> "DesktopDiagnostics":
        started_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        session_id = f"desktop-{started_at.replace(':', '').replace('-', '')}-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        reporter = cls(diagnostics_root or local_desktop_diagnostics_root(), session_id, started_at)
        reporter.session_dir.mkdir(parents=True, exist_ok=False)
        reporter._write_run_record()
        reporter._record_previous_unclosed_run()
        reporter.record_event("desktop_started", {"pid": os.getpid()})
        atexit.register(reporter.close)
        return reporter

    def record_event(self, event: str, details: dict[str, Any] | None = None) -> None:
        record: dict[str, Any] = {
            "timestamp": self._timestamp(),
            "sessionId": self.session_id,
            "event": event,
        }
        if details:
            record["details"] = details
        self._append_jsonl(record)

    def record_exception(self, event: str, error: BaseException, trace: str | None = None) -> None:
        self._status = "failed"
        self._write_run_record()
        self.record_event(
            event,
            {
                "exceptionType": type(error).__name__,
                "message": str(error),
                "traceback": trace or "".join(traceback.format_exception(type(error), error, error.__traceback__)),
            },
        )

    def mark_clean_exit(self, exit_code: int) -> None:
        self._status = "exited"
        self._write_run_record(exit_code=exit_code)
        self.record_event("desktop_exited", {"exitCode": exit_code})

    def install(self) -> None:
        """Capture Python/Qt diagnostics before the UI imports or starts."""
        self._original_stdout = sys.stdout
        self._original_stderr = sys.stderr
        self._stdout_handle = self.stdout_path.open("a", encoding="utf-8", buffering=1)
        self._stderr_handle = self.stderr_path.open("a", encoding="utf-8", buffering=1)
        sys.stdout = _TeeStream(self._original_stdout, self._stdout_handle)
        sys.stderr = _TeeStream(self._original_stderr, self._stderr_handle)
        self._fault_handle = self.fault_path.open("ab", buffering=0)
        try:
            faulthandler.enable(file=self._fault_handle, all_threads=True)
        except (OSError, RuntimeError):
            self.record_event("faulthandler_unavailable")
        self._install_exception_hooks()

    def install_qt_message_handler(self) -> None:
        """Persist Qt warnings and fatal messages without changing Qt behaviour."""
        try:
            from PySide6.QtCore import qInstallMessageHandler
        except ModuleNotFoundError:
            return

        def handler(_message_type: object, context: object, message: str) -> None:
            category = getattr(context, "category", "")
            self.record_event("qt_message", {"category": category, "message": message})

        qInstallMessageHandler(handler)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            faulthandler.disable()
        except (OSError, RuntimeError):
            pass
        if self._original_stdout is not None:
            sys.stdout = self._original_stdout
        if self._original_stderr is not None:
            sys.stderr = self._original_stderr
        if self._original_excepthook is not None:
            sys.excepthook = self._original_excepthook
        if self._original_threading_excepthook is not None and hasattr(threading, "excepthook"):
            threading.excepthook = self._original_threading_excepthook
        for handle in (self._stdout_handle, self._stderr_handle, self._fault_handle):
            if handle is not None:
                try:
                    handle.close()
                except OSError:
                    pass

    def _install_exception_hooks(self) -> None:
        self._original_excepthook = sys.excepthook

        def exception_hook(error_type: type[BaseException], error: BaseException, trace: object) -> None:
            self.record_exception("unhandled_exception", error, "".join(traceback.format_exception(error_type, error, trace)))
            if self._original_excepthook is not None:
                self._original_excepthook(error_type, error, trace)

        sys.excepthook = exception_hook
        if not hasattr(threading, "excepthook"):
            return
        self._original_threading_excepthook = threading.excepthook

        def threading_exception_hook(args: Any) -> None:
            error = args.exc_value
            if error is not None:
                self.record_exception(
                    "unhandled_thread_exception",
                    error,
                    "".join(traceback.format_exception(args.exc_type, error, args.exc_traceback)),
                )
            if self._original_threading_excepthook is not None:
                self._original_threading_excepthook(args)

        threading.excepthook = threading_exception_hook

    def _record_previous_unclosed_run(self) -> None:
        pointer_path = self.diagnostics_root / "latest-run.json"
        try:
            pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
            previous_run = Path(str(pointer["runPath"]))
            previous = json.loads(previous_run.read_text(encoding="utf-8"))
        except (FileNotFoundError, KeyError, OSError, json.JSONDecodeError):
            previous = None
        if isinstance(previous, dict) and previous.get("status") == "running":
            self.record_event(
                "previous_run_unclosed",
                {
                    "previousSessionId": previous.get("sessionId"),
                    "previousStartedAt": previous.get("startedAt"),
                },
            )
        self._atomic_json_write(pointer_path, {"sessionId": self.session_id, "runPath": str(self.run_path)})

    def _write_run_record(self, exit_code: int | None = None) -> None:
        record: dict[str, Any] = {
            "schemaVersion": 1,
            "recordClass": "run-receipt",
            "sessionId": self.session_id,
            "startedAt": self.started_at,
            "pid": os.getpid(),
            "status": self._status,
        }
        if exit_code is not None:
            record["exitCode"] = exit_code
            record["endedAt"] = self._timestamp()
        self._atomic_json_write(self.run_path, record)

    def _append_jsonl(self, record: dict[str, Any]) -> None:
        with self._lock:
            try:
                with self.events_path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
                    handle.flush()
                    os.fsync(handle.fileno())
            except OSError:
                pass

    @staticmethod
    def _atomic_json_write(path: Path, value: dict[str, Any]) -> None:
        temporary = path.with_suffix(path.suffix + ".tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(path)
        except OSError:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
