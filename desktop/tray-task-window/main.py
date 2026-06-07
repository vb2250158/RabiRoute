from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="RabiRoute Qt 任务面板")
    parser.add_argument("--manager-url", default="http://127.0.0.1:8790")
    parser.add_argument("--owns-manager", action="store_true", help="退出面板时同时关闭本次托管的 manager。")
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[2]
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
    return run(project_root, manager_url=args.manager_url, owns_manager=args.owns_manager)


if __name__ == "__main__":
    raise SystemExit(main())
