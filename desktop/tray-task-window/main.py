from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from rabiroute_tray.windows_app_identity import configure_process_app_identity, ensure_start_menu_shortcut


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


def _append_startup_log(project_root: Path, message: str) -> None:
    try:
        logs_dir = project_root / "data" / "route" / "default-main" / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        with (logs_dir / "tray-startup.log").open("a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {message}\n")
    except OSError:
        pass


def _node_executable(project_root: Path) -> tuple[str, str]:
    env_node = os.environ.get("RABIROUTE_NODE")
    executable_name = "node.exe" if sys.platform == "win32" else "node"
    path_node = shutil.which("node")
    candidates: list[tuple[str, Path | None]] = [
        ("RABIROUTE_NODE", Path(env_node) if env_node else None),
        ("PATH", Path(path_node) if path_node else None),
        ("project portable node", project_root / executable_name),
        ("project .node", project_root / ".node" / executable_name),
        ("project tools/node", project_root / "tools" / "node" / executable_name),
        ("project tools/nodejs", project_root / "tools" / "nodejs" / executable_name),
        ("workspace tools/node", project_root.parent / "tools" / "node" / executable_name),
        ("workspace tools/nodejs", project_root.parent / "tools" / "nodejs" / executable_name),
    ]
    for source, candidate in candidates:
        if candidate and candidate.exists():
            return str(candidate), source

    tools_root = project_root.parent / "tools"
    if tools_root.exists():
        ignored_parts = {"node_modules", ".git", "build", "dist"}
        matches = (
            path
            for path in tools_root.rglob(executable_name)
            if not ignored_parts.intersection(path.parts)
        )
        for candidate in sorted(matches, key=lambda path: (len(path.parts), str(path).lower())):
            return str(candidate), "workspace tools search"
    return "node", "PATH fallback"


def _start_manager(project_root: Path, manager_url: str) -> "subprocess.Popen[bytes] | None":
    """Start node dist/manager.js and wait up to 15 s for it to answer."""
    dist_manager = project_root / "dist" / "manager.js"
    if not dist_manager.exists():
        print(f"[RabiRoute] dist/manager.js not found at {dist_manager}", file=sys.stderr)
        return None

    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    node, node_source = _node_executable(project_root)
    _append_startup_log(project_root, f"Using Node from {node_source}: {node}")
    proc = subprocess.Popen(
        [node, str(dist_manager)],
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
    parser = argparse.ArgumentParser(description="RabiRoute Qt 计划与记忆面板")
    parser.add_argument("--manager-url", default="http://127.0.0.1:8790")
    parser.add_argument("--owns-manager", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    project_root = _resolve_project_root()
    configure_process_app_identity()
    ensure_start_menu_shortcut(project_root)

    # Frozen desktop entry auto-starts manager if it is not running.
    proc: "subprocess.Popen[bytes] | None" = None
    if getattr(sys, "frozen", False) and not _manager_alive(args.manager_url):
        proc = _start_manager(project_root, args.manager_url)

    try:
        from rabiroute_tray.tray_app import run
    except ModuleNotFoundError as error:
        if error.name == "PySide6":
            print(
                "RabiRoute Qt 计划与记忆面板需要 PySide6。\n"
                "请手动安装：\n"
                "  py -m pip install -r desktop\\tray-task-window\\requirements.txt\n"
                "\n"
                "RabiRoute manager / WebGUI 仍可通过跨平台 Node 入口启动：\n"
                "  npm run start:manager",
                file=sys.stderr,
            )
            return 1
        raise
    return run(project_root, manager_url=args.manager_url, manager_proc=proc)


if __name__ == "__main__":
    raise SystemExit(main())
