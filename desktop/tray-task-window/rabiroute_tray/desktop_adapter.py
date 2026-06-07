from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QUrl
from PySide6.QtGui import QDesktopServices, QIcon


class DesktopAdapter:
    def __init__(self, project_root: Path) -> None:
        self.project_root = project_root

    def app_icon(self) -> QIcon:
        icon_path = self.project_root / "assets" / "rabiroute-icon.png"
        return QIcon(str(icon_path)) if icon_path.exists() else QIcon()

    def open_url(self, url: str) -> None:
        QDesktopServices.openUrl(QUrl(url))

    def open_path(self, path: Path) -> None:
        target = path if path.exists() else path.parent if path.parent.exists() else Path.cwd()
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(target)))
