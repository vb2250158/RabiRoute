# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for RabiRoute-Tray.exe
# Build: cd <repo> && pyinstaller RabiRoute-Tray.spec
# Output: dist/RabiRoute-Tray.exe  →  copy to <repo>/RabiRoute-Tray.exe

import sys
from pathlib import Path

repo_root = Path(SPECPATH)
tray_dir = repo_root / "desktop" / "tray-task-window"

a = Analysis(
    [str(tray_dir / "main.py")],
    pathex=[str(tray_dir)],
    binaries=[],
    datas=[],
    hiddenimports=[
        "PySide6.QtCore",
        "PySide6.QtGui",
        "PySide6.QtWidgets",
        "rabiroute_tray.app_paths",
        "rabiroute_tray.desktop_adapter",
        "rabiroute_tray.desktop_models",
        "rabiroute_tray.desktop_read_model",
        "rabiroute_tray.desktop_refresh",
        "rabiroute_tray.lifecycle_controller",
        "rabiroute_tray.manager_client",
        "rabiroute_tray.qt_async",
        "rabiroute_tray.task_window",
        "rabiroute_tray.tray_app",
        "rabiroute_tray.windows_app_identity",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="RabiRoute-Tray",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # no console window; errors go to stderr (silently dropped in GUI mode)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    version=str(tray_dir / "version_info.txt"),
    icon=str(repo_root / "assets" / "rabiroute-icon.ico"),
)
