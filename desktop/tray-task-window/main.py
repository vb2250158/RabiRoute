from __future__ import annotations

import argparse
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def _resolve_project_root() -> Path:
    """
    Frozen (PyInstaller onefile/onedir): exe lives at <project_root>/RabiRoute-Tray.exe,
    so sys.executable.parent is the project root.
    Script mode: __file__ is desktop/tray-task-window/main.py — 3 levels up.
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def _manager_alive(manager_url: str) -> bool:
    try:
        urllib.request.urlopen(f"{manager_url}/meta", timeout=2)
        return True
    except Exception:
        return False


def _start_manager(project_root: Path, manager_url: str) -> "subprocess.Popen[bytes] | None":
    """Start node dist/manager.js and wait up to 15 s for it to answer."""
    dist_manager = project_root / "dist" / "manager.js"
    if not dist_manager.exists():
        print(f"[RabiRoute] dist/manager.js not found at {dist_manager}", file=sys.stderr)
        return None

    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    proc = subprocess.Popen(
        ["node", str(dist_manager)],
        cwd=str(project_root),
        creationflags=flags,
    )

    for _ in range(30):
        time.sleep(0.5)
        if _manager_alive(manager_url):
            return proc

    print("[RabiRoute] Manager did not respond within 15 s.", file=sys.stderr)
    return proc


def main() -> int:
    parser = argparse.ArgumentParser(description="RabiRoute Qt 任务面板")
    parser.add_argument("--manager-url", default="http://127.0.0.1:8790")
    parser.add_argument("--owns-manager", action="store_true", help="退出面板时同时关闭本次托管的 manager。")
    args = parser.parse_args()

    project_root = _resolve_project_root()

    # When packaged as an exe, auto-start the manager if it's not running.
    owns_manager = args.owns_manager
    proc: "subprocess.Popen[bytes] | None" = None
    if getattr(sys, "frozen", False) and not _manager_alive(args.manager_url):
        proc = _start_manager(project_root, args.manager_url)
        if proc is not None:
            owns_manager = True

    try:
        from rabiroute_tray.tray_app import run
    except ModuleNotFoundError as error:
        if error.name == "PySide6":
            print(
                "RabiRoute Qt 任务面板需要 PySide6。\n"
                "请手动安装：\n"
                "  py -m pip install -r desktop\\tray-task-window\\requirements.txt\n"
                "\n"
                "RabiRoute manager / WebGUI 仍可通过跨平台 Node 入口启动：\n"
                "  npm run start:manager",
                file=sys.stderr,
            )
            return 1
        raise
    return run(project_root, manager_url=args.manager_url, owns_manager=owns_manager, manager_proc=proc if owns_manager else None)


if __name__ == "__main__":
    raise SystemExit(main())
