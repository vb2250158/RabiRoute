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


def _runtime_logs_dir(project_root: Path) -> Path:
    logs_dir = project_root / "data" / "route" / "default-main" / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    return logs_dir


def _newer_than(target_time: float, paths: list[Path], suffixes: tuple[str, ...]) -> bool:
    for source_path in paths:
        if not source_path.exists():
            continue
        if source_path.is_file():
            if source_path.stat().st_mtime > target_time:
                return True
            continue
        for child in source_path.rglob("*"):
            if child.is_file() and child.suffix.lower() in suffixes and child.stat().st_mtime > target_time:
                return True
    return False


def _backend_needs_build(project_root: Path) -> bool:
    dist_manager = project_root / "dist" / "manager.js"
    if not dist_manager.exists():
        return True
    return _newer_than(
        dist_manager.stat().st_mtime,
        [project_root / "src"],
        (".ts", ".tsx"),
    )


def _webgui_needs_build(project_root: Path) -> bool:
    webgui_index = project_root / "ribiwebgui" / "dist" / "index.html"
    webgui_assets = project_root / "ribiwebgui" / "dist" / "assets"
    if not webgui_index.exists() or not webgui_assets.exists():
        return True
    return _newer_than(
        webgui_index.stat().st_mtime,
        [
            project_root / "ribiwebgui" / "src",
            project_root / "ribiwebgui" / "index.html",
            project_root / "ribiwebgui" / "vite.config.ts",
            project_root / "ribiwebgui" / "tsconfig.json",
        ],
        (".ts", ".tsx", ".vue", ".html", ".json"),
    )


def _npm_command() -> str | None:
    return shutil.which("npm.cmd") or shutil.which("npm")


def _run_npm_script(project_root: Path, script_name: str) -> bool:
    npm = _npm_command()
    if not npm:
        _append_startup_log(project_root, f"npm was not found; cannot run npm run {script_name}.")
        return False

    try:
        logs_dir = _runtime_logs_dir(project_root)
        log_path = logs_dir / f"tray-npm-{script_name.replace(':', '-')}.log"
        _append_startup_log(project_root, f"Running npm run {script_name}: {npm}")
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        with log_path.open("ab") as handle:
            handle.write(f"\n[{time.strftime('%Y-%m-%dT%H:%M:%S')}] > {npm} run {script_name}\n".encode("utf-8"))
            result = subprocess.run(
                [npm, "run", script_name],
                cwd=str(project_root),
                stdout=handle,
                stderr=subprocess.STDOUT,
                creationflags=flags,
                check=False,
            )
        if result.returncode != 0:
            _append_startup_log(project_root, f"npm run {script_name} failed with code {result.returncode}. See {log_path}.")
            return False
        _append_startup_log(project_root, f"npm run {script_name} finished.")
        return True
    except Exception as error:
        _append_startup_log(project_root, f"npm run {script_name} failed: {error}")
        return False


def _ensure_runtime_build(project_root: Path, manager_running: bool) -> None:
    if manager_running:
        if _webgui_needs_build(project_root):
            _run_npm_script(project_root, "webgui:build")
        return
    if _backend_needs_build(project_root) or _webgui_needs_build(project_root):
        _run_npm_script(project_root, "build")


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

    manager_running = _manager_alive(args.manager_url)
    if getattr(sys, "frozen", False):
        _ensure_runtime_build(project_root, manager_running)

    # Frozen desktop entry auto-starts manager if it is not running.
    proc: "subprocess.Popen[bytes] | None" = None
    if getattr(sys, "frozen", False) and not manager_running:
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
