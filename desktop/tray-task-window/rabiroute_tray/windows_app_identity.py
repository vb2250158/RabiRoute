from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path

APP_NAME = "RabiRoute"
APP_DISPLAY_NAME = "RabiRoute"
APP_ORGANIZATION = "CottonProject"
APP_USER_MODEL_ID = "CottonProject.RabiRoute.Desktop"


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


def ensure_start_menu_shortcut(project_root: Path, host_executable: Path) -> None:
    """Register a Start Menu shortcut so Windows can show the friendly app name."""
    if sys.platform != "win32":
        return
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return

    shortcut_dir = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / APP_NAME
    shortcut_path = shortcut_dir / f"{APP_NAME}.lnk"
    target_path, arguments = _shortcut_target(project_root, host_executable)
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


def sync_startup_shortcut(project_root: Path, enabled: bool, host_executable: Path | None = None) -> None:
    """Keep the per-user Windows login shortcut in sync with the desktop setting."""
    if sys.platform != "win32":
        return
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return
    startup_dir = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    shortcut_path = startup_dir / f"{APP_NAME}.lnk"
    ownership = _startup_shortcut_ownership(shortcut_path, project_root, host_executable)
    if ownership == "foreign":
        raise RuntimeError(f"Refusing to overwrite or delete foreign startup shortcut: {shortcut_path}")
    if not enabled:
        if ownership == "owned":
            shortcut_path.unlink(missing_ok=True)
        return
    if host_executable is None:
        print("[RabiRoute] Refusing to register Windows startup without the Host executable.", file=sys.stderr)
        return
    target_path, arguments = _shortcut_target(project_root, host_executable)
    try:
        startup_dir.mkdir(parents=True, exist_ok=True)
        _create_windows_shortcut(
            shortcut_path=shortcut_path,
            target_path=target_path,
            arguments=arguments,
            working_dir=project_root,
            icon_path=_shortcut_icon(project_root, target_path),
            app_user_model_id=APP_USER_MODEL_ID,
        )
    except Exception as error:
        print(f"[RabiRoute] Failed to register Windows startup shortcut: {error}", file=sys.stderr)


def _same_windows_path(left: Path, right: Path) -> bool:
    return os.path.normcase(str(left.resolve())) == os.path.normcase(str(right.resolve()))


def _startup_shortcut_ownership(shortcut_path: Path, project_root: Path, host_executable: Path | None) -> str:
    if not shortcut_path.exists():
        return "absent"
    if host_executable is None:
        return "foreign"
    try:
        target, arguments, working_dir = _read_windows_shortcut(shortcut_path)
        if (
            not arguments.strip()
            and _same_windows_path(target, host_executable)
            and _same_windows_path(working_dir, project_root)
        ):
            return "owned"
    except (OSError, ValueError):
        pass
    return "foreign"


def _read_windows_shortcut(shortcut_path: Path) -> tuple[Path, str, Path]:
    if sys.platform != "win32":
        raise OSError("Windows ShellLink is unavailable on this platform.")
    from ctypes import POINTER, Structure, byref, c_long, c_ubyte, c_void_p, wintypes

    class GUID(Structure):
        _fields_ = [
            ("Data1", wintypes.DWORD),
            ("Data2", wintypes.WORD),
            ("Data3", wintypes.WORD),
            ("Data4", c_ubyte * 8),
        ]

    def guid(value: str) -> GUID:
        import uuid

        parsed = uuid.UUID(value)
        return GUID(parsed.time_low, parsed.time_mid, parsed.time_hi_version, (c_ubyte * 8).from_buffer_copy(parsed.bytes[8:]))

    def method(ptr: c_void_p, index: int, *argtypes: object) -> object:
        vtable = ctypes.cast(ptr, POINTER(POINTER(c_void_p))).contents
        return ctypes.WINFUNCTYPE(c_long, c_void_p, *argtypes)(vtable[index])

    def check(hr: int, operation: str) -> None:
        if hr < 0:
            raise OSError(f"{operation} failed with HRESULT 0x{hr & 0xFFFFFFFF:08X}")

    shell_link = c_void_p()
    persist_file = c_void_p()
    ole32 = ctypes.windll.ole32
    initialized = ole32.CoInitialize(None) >= 0
    try:
        clsid = guid("00021401-0000-0000-C000-000000000046")
        shell_iid = guid("000214F9-0000-0000-C000-000000000046")
        persist_iid = guid("0000010B-0000-0000-C000-000000000046")
        check(ole32.CoCreateInstance(byref(clsid), None, 1, byref(shell_iid), byref(shell_link)), "CoCreateInstance(IShellLink)")
        query_interface = method(shell_link, 0, POINTER(GUID), POINTER(c_void_p))
        check(query_interface(shell_link, byref(persist_iid), byref(persist_file)), "QueryInterface(IPersistFile)")
        check(method(persist_file, 5, wintypes.LPCWSTR, wintypes.DWORD)(persist_file, str(shortcut_path), 0), "IPersistFile.Load")
        target = ctypes.create_unicode_buffer(32768)
        arguments = ctypes.create_unicode_buffer(32768)
        working_dir = ctypes.create_unicode_buffer(32768)
        check(method(shell_link, 3, wintypes.LPWSTR, ctypes.c_int, c_void_p, wintypes.DWORD)(shell_link, target, len(target), None, 0), "IShellLink.GetPath")
        check(method(shell_link, 10, wintypes.LPWSTR, ctypes.c_int)(shell_link, arguments, len(arguments)), "IShellLink.GetArguments")
        check(method(shell_link, 8, wintypes.LPWSTR, ctypes.c_int)(shell_link, working_dir, len(working_dir)), "IShellLink.GetWorkingDirectory")
        if not target.value or not working_dir.value:
            raise ValueError("Shortcut target or working directory is empty.")
        return Path(target.value), arguments.value, Path(working_dir.value)
    finally:
        for ptr in (persist_file, shell_link):
            if ptr:
                vtable = ctypes.cast(ptr, POINTER(POINTER(c_void_p))).contents
                ctypes.WINFUNCTYPE(c_long, c_void_p)(vtable[2])(ptr)
        if initialized:
            ole32.CoUninitialize()


def _shortcut_target(project_root: Path, host_executable: Path) -> tuple[Path, str]:
    _ = project_root
    target = Path(host_executable).resolve()
    if not target.is_absolute() or not target.is_file():
        raise ValueError("RabiRoute Host executable is unavailable.")
    return target, ""


def _shortcut_icon(project_root: Path, target_path: Path) -> Path:
    asset_icon = project_root / "assets" / "rabiroute-icon.ico"
    if asset_icon.exists():
        return asset_icon
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
