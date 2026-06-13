from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path

APP_NAME = "RabiRoute"
APP_DISPLAY_NAME = "RabiRoute"
APP_ORGANIZATION = "CottonProject"
APP_USER_MODEL_ID = "CottonProject.RabiRoute.Tray"


def configure_process_app_identity() -> None:
    """Give Windows notifications one stable sender identity in script and exe mode."""
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
    except Exception as error:
        print(f"[RabiRoute] Failed to set Windows AppUserModelID: {error}", file=sys.stderr)


def apply_qt_app_metadata(app: object) -> None:
    app.setOrganizationName(APP_ORGANIZATION)
    app.setApplicationName(APP_NAME)
    if hasattr(app, "setApplicationDisplayName"):
        app.setApplicationDisplayName(APP_DISPLAY_NAME)
    if hasattr(app, "setDesktopFileName"):
        app.setDesktopFileName(APP_USER_MODEL_ID)


def ensure_start_menu_shortcut(project_root: Path) -> None:
    """Register a Start Menu shortcut so Windows can show the friendly app name."""
    if sys.platform != "win32":
        return
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return

    shortcut_dir = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / APP_NAME
    shortcut_path = shortcut_dir / f"{APP_NAME}.lnk"
    target_path, arguments = _shortcut_target(project_root)
    icon_path = _shortcut_icon(project_root, target_path)

    try:
        shortcut_dir.mkdir(parents=True, exist_ok=True)
        _create_windows_shortcut(
            shortcut_path=shortcut_path,
            target_path=target_path,
            arguments=arguments,
            working_dir=project_root,
            icon_path=icon_path,
            app_user_model_id=APP_USER_MODEL_ID,
        )
    except Exception as error:
        print(f"[RabiRoute] Failed to register Windows shortcut identity: {error}", file=sys.stderr)


def _shortcut_target(project_root: Path) -> tuple[Path, str]:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve(), ""
    launcher = project_root / "Start-RabiRoute-Tray.bat"
    if launcher.exists():
        return launcher, ""
    tray_main = project_root / "desktop" / "tray-task-window" / "main.py"
    return Path(sys.executable).resolve(), f'"{tray_main}"'


def _shortcut_icon(project_root: Path, target_path: Path) -> Path:
    exe_icon = project_root / "RabiRoute-Tray.exe"
    if exe_icon.exists():
        return exe_icon
    return target_path


def _create_windows_shortcut(
    shortcut_path: Path,
    target_path: Path,
    arguments: str,
    working_dir: Path,
    icon_path: Path,
    app_user_model_id: str,
) -> None:
    from ctypes import POINTER, Structure, byref, c_long, c_ubyte, c_void_p, wintypes

    class GUID(Structure):
        _fields_ = [
            ("Data1", wintypes.DWORD),
            ("Data2", wintypes.WORD),
            ("Data3", wintypes.WORD),
            ("Data4", c_ubyte * 8),
        ]

    class PROPERTYKEY(Structure):
        _fields_ = [("fmtid", GUID), ("pid", wintypes.DWORD)]

    class PROPVARIANT(Structure):
        _fields_ = [
            ("vt", wintypes.USHORT),
            ("wReserved1", wintypes.USHORT),
            ("wReserved2", wintypes.USHORT),
            ("wReserved3", wintypes.USHORT),
            ("pwszVal", wintypes.LPWSTR),
        ]

    def guid(value: str) -> GUID:
        import uuid

        parsed = uuid.UUID(value)
        data4 = (c_ubyte * 8).from_buffer_copy(parsed.bytes[8:])
        return GUID(parsed.time_low, parsed.time_mid, parsed.time_hi_version, data4)

    def check(hr: int, operation: str) -> None:
        if hr < 0:
            raise OSError(f"{operation} failed with HRESULT 0x{hr & 0xFFFFFFFF:08X}")

    def method(ptr: c_void_p, index: int, *argtypes: object) -> object:
        vtable = ctypes.cast(ptr, POINTER(POINTER(c_void_p))).contents
        return ctypes.WINFUNCTYPE(c_long, c_void_p, *argtypes)(vtable[index])

    CLSID_SHELL_LINK = guid("00021401-0000-0000-C000-000000000046")
    IID_ISHELL_LINK_W = guid("000214F9-0000-0000-C000-000000000046")
    IID_IPERSIST_FILE = guid("0000010B-0000-0000-C000-000000000046")
    IID_IPROPERTY_STORE = guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")
    PKEY_APP_USER_MODEL_ID = PROPERTYKEY(guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5)
    CLSCTX_INPROC_SERVER = 1
    VT_LPWSTR = 31

    ole32 = ctypes.windll.ole32
    shell_link = c_void_p()
    property_store = c_void_p()
    persist_file = c_void_p()
    initialized = False

    try:
        hr = ole32.CoInitialize(None)
        initialized = hr >= 0
        hr = ole32.CoCreateInstance(
            byref(CLSID_SHELL_LINK),
            None,
            CLSCTX_INPROC_SERVER,
            byref(IID_ISHELL_LINK_W),
            byref(shell_link),
        )
        check(hr, "CoCreateInstance(IShellLink)")

        check(method(shell_link, 20, wintypes.LPCWSTR)(shell_link, str(target_path)), "IShellLink.SetPath")
        check(method(shell_link, 11, wintypes.LPCWSTR)(shell_link, arguments), "IShellLink.SetArguments")
        check(method(shell_link, 9, wintypes.LPCWSTR)(shell_link, str(working_dir)), "IShellLink.SetWorkingDirectory")
        check(method(shell_link, 17, wintypes.LPCWSTR, ctypes.c_int)(shell_link, str(icon_path), 0), "IShellLink.SetIconLocation")

        query_interface = method(shell_link, 0, POINTER(GUID), POINTER(c_void_p))
        check(query_interface(shell_link, byref(IID_IPROPERTY_STORE), byref(property_store)), "QueryInterface(IPropertyStore)")
        variant = PROPVARIANT(VT_LPWSTR, 0, 0, 0, app_user_model_id)
        check(
            method(property_store, 6, POINTER(PROPERTYKEY), POINTER(PROPVARIANT))(
                property_store,
                byref(PKEY_APP_USER_MODEL_ID),
                byref(variant),
            ),
            "IPropertyStore.SetValue(AppUserModelID)",
        )
        check(method(property_store, 7)(property_store), "IPropertyStore.Commit")

        check(query_interface(shell_link, byref(IID_IPERSIST_FILE), byref(persist_file)), "QueryInterface(IPersistFile)")
        check(method(persist_file, 6, wintypes.LPCWSTR, wintypes.BOOL)(persist_file, str(shortcut_path), True), "IPersistFile.Save")
    finally:
        release = ctypes.WINFUNCTYPE(c_long, c_void_p)
        for ptr in (persist_file, property_store, shell_link):
            if ptr:
                vtable = ctypes.cast(ptr, POINTER(POINTER(c_void_p))).contents
                release(vtable[2])(ptr)
        if initialized:
            ole32.CoUninitialize()
