from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from PyInstaller.utils.win32.icon import CopyIcons_FromIco
from PyInstaller.utils.win32.versioninfo import (
    load_version_info_from_text_file,
    write_version_info_to_executable,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Create the RabiSpeech Windows launcher identity.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--version-file", required=True)
    parser.add_argument("--icon", required=True)
    args = parser.parse_args()

    source = Path(args.source).expanduser().resolve()
    destination = Path(args.destination).expanduser().resolve()
    version_file = Path(args.version_file).expanduser().resolve()
    icon = Path(args.icon).expanduser().resolve()
    for required in (source, version_file, icon):
        if not required.is_file():
            raise FileNotFoundError(required)

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".new.exe")
    shutil.copy2(source, temporary)
    info = load_version_info_from_text_file(str(version_file))
    write_version_info_to_executable(str(temporary), info)
    CopyIcons_FromIco(str(temporary), [str(icon)])
    temporary.replace(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
