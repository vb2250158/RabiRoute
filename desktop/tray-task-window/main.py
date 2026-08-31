from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import urlparse


def _configure_frozen_qt_dll_search_paths() -> None:
    """Register bundled Qt wheel directories before importing PySide6."""
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return
    runtime_root = Path(sys._MEIPASS)
    for relative in ("PySide6", "shiboken6"):
        directory = runtime_root / relative
        if directory.is_dir():
            os.add_dll_directory(str(directory))


_configure_frozen_qt_dll_search_paths()

from rabiroute_tray.desktop_diagnostics import DesktopDiagnostics
from rabiroute_tray.windows_app_identity import configure_process_app_identity


def _resolve_project_root() -> Path:
    """Resolve the installed product root without acquiring lifecycle ownership."""
    if getattr(sys, "frozen", False):
        runtime_dir = Path(sys.executable).resolve().parent
        if runtime_dir.name == "desktop-runtime":
            return runtime_dir.parent
        return runtime_dir
    script_path = Path(__file__).resolve()
    if script_path.parent.name == "desktop-runtime":
        return script_path.parent.parent
    return script_path.parents[2]


def _loopback_manager_url(value: str) -> str:
    normalized = str(value or "").strip().rstrip("/")
    parsed = urlparse(normalized)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.port is None
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise argparse.ArgumentTypeError("--manager-url must be a loopback HTTP origin with an explicit port")
    return normalized


def _required_identity(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > 160 or any(character in normalized for character in "\r\n\0"):
        raise argparse.ArgumentTypeError("lifecycle identity must be a non-empty value of at most 160 characters")
    return normalized


def _host_executable(value: str) -> Path:
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        raise argparse.ArgumentTypeError("--host-executable must be an absolute path")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise argparse.ArgumentTypeError(f"--host-executable is unavailable: {error}") from error
    if not resolved.is_file():
        raise argparse.ArgumentTypeError("--host-executable must name a file")
    return resolved


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="RabiRoute Tray surface child")
    parser.add_argument("--surface-child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--manager-url", required=True, type=_loopback_manager_url, help=argparse.SUPPRESS)
    parser.add_argument("--application-generation-id", required=True, type=_required_identity, help=argparse.SUPPRESS)
    parser.add_argument("--manager-instance-id", required=True, type=_required_identity, help=argparse.SUPPRESS)
    parser.add_argument("--host-executable", required=True, type=_host_executable, help=argparse.SUPPRESS)
    parser.add_argument("--host-lifecycle-pipe", required=True, type=_required_identity, help=argparse.SUPPRESS)
    parser.add_argument(
        "--show-desktop-pet",
        action="store_true",
        help="Show the configured desktop pet after the Qt host is ready.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    if not args.surface_child:
        parser.error("RabiRoute Tray can only be launched by RabiRoute Host (--surface-child is required)")

    project_root = _resolve_project_root()
    configure_process_app_identity()
    diagnostics = DesktopDiagnostics.start()
    diagnostics.install()
    try:
        diagnostics.record_event(
            "desktop_surface_child_started",
            {
                "frozen": bool(getattr(sys, "frozen", False)),
                "applicationGenerationId": args.application_generation_id,
                "managerInstanceId": args.manager_instance_id,
            },
        )
        try:
            from rabiroute_tray.tray_app import run

            diagnostics.install_qt_message_handler()
        except ModuleNotFoundError as error:
            if error.name != "PySide6":
                raise
            print("RabiRoute Tray requires the packaged PySide6 runtime.", file=sys.stderr)
            diagnostics.mark_clean_exit(1)
            return 1

        exit_code = run(
            project_root,
            manager_url=args.manager_url,
            application_generation_id=args.application_generation_id,
            manager_instance_id=args.manager_instance_id,
            host_executable=args.host_executable,
            host_lifecycle_pipe=args.host_lifecycle_pipe,
            show_desktop_pet=args.show_desktop_pet,
        )
        diagnostics.mark_clean_exit(exit_code)
        return exit_code
    except BaseException as error:
        diagnostics.record_exception("desktop_runtime_exception", error)
        raise
    finally:
        diagnostics.close()


if __name__ == "__main__":
    raise SystemExit(main())
