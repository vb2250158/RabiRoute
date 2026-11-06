"""Set product identity on a build copy; preserve the interpreter's version/copyright."""
from __future__ import annotations

import argparse
import ctypes
import shutil
import pefile
from pathlib import Path
from uuid import uuid4

from PyInstaller.compat import win32api
from PyInstaller.utils.win32.icon import CopyIcons_FromIco
from PyInstaller.utils.win32.versioninfo import (
    StringFileInfo, StringStruct, load_version_info_from_text_file,
    read_version_info_from_executable, write_version_info_to_executable,
)


def patch(source: Path, destination: Path, icon: Path, description: str,
          version_file: Path | None = None, original_filename: str | None = None) -> None:
    for required in (source, icon, *([version_file] if version_file else [])):
        if not required.is_file():
            raise FileNotFoundError(required)
    if source.resolve() == destination.resolve():
        raise ValueError("Identity input and output must be different build files")
    info = (load_version_info_from_text_file(str(version_file)) if version_file
            else read_version_info_from_executable(str(source)))
    if info is None:
        raise ValueError("The executable has no version information")
    filename = original_filename or destination.name
    updates = {"FileDescription": description, "ProductName": "RabiRoute",
               "InternalName": Path(filename).stem, "OriginalFilename": filename}
    for group in info.kids:
        if isinstance(group, StringFileInfo):
            for table in group.kids:
                table.kids = [item for item in table.kids if item.name not in updates]
                table.kids.extend(StringStruct(key, value) for key, value in updates.items())
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.stem}-{uuid4().hex}.exe")
    try:
        shutil.copy2(source, temporary)
        # Remove all old icon groups, including vendor groups with IDs other than 1.
        module = win32api.LoadLibraryEx(str(temporary), 0, 2)
        try:
            resources = [(kind, name, language)
                         for kind in (3, 14, 16)
                         for name in win32api.EnumResourceNames(module, kind)
                         for language in win32api.EnumResourceLanguages(module, kind, name)]
        finally:
            win32api.FreeLibrary(module)
        handle = win32api.BeginUpdateResource(str(temporary), False)
        try:
            remove = ctypes.WinDLL("kernel32", use_last_error=True).UpdateResourceW
            remove.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                               ctypes.c_ushort, ctypes.c_void_p, ctypes.c_uint]
            remove.restype = ctypes.c_bool
            for kind, name, language in resources:
                resource_name = (ctypes.cast(ctypes.c_wchar_p(name), ctypes.c_void_p)
                                 if isinstance(name, str) else ctypes.c_void_p(name))
                if not remove(handle, kind, resource_name, language, None, 0):
                    raise ctypes.WinError(ctypes.get_last_error())
        except BaseException:
            win32api.EndUpdateResource(handle, True)
            raise
        win32api.EndUpdateResource(handle, False)
        write_version_info_to_executable(str(temporary), info)
        CopyIcons_FromIco(str(temporary), [str(icon)])
        # Modified resources cannot retain the upstream publisher's signature.
        image = pefile.PE(str(temporary), fast_load=True)
        try:
            certificate = image.OPTIONAL_HEADER.DATA_DIRECTORY[4]
            certificate.VirtualAddress = 0
            certificate.Size = 0
            unsigned_image = image.write()
        finally:
            image.close()
        temporary.write_bytes(unsigned_image)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--icon", type=Path, required=True)
    parser.add_argument("--description", default="RabiSpeech")
    parser.add_argument("--version-file", type=Path)
    parser.add_argument("--original-filename")
    args = parser.parse_args()
    patch(args.source.resolve(), args.destination.resolve(), args.icon.resolve(),
          args.description, args.version_file, args.original_filename)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
