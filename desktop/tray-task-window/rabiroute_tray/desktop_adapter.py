from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QUrl
from PySide6.QtGui import QDesktopServices, QIcon


def project_app_icon(project_root: Path | None) -> QIcon:
    """Load the RabiRoute brand icon so every owned window can share one identity."""
    if project_root is None:
        return QIcon()
    for name in ("rabiroute-icon.png", "rabiroute-icon.ico"):
        icon_path = Path(project_root) / "assets" / name
        if icon_path.is_file():
            icon = QIcon(str(icon_path))
            if not icon.isNull():
                return icon
    return QIcon()


class DesktopAdapter:
    def __init__(self, project_root: Path) -> None:
        self.project_root = project_root

    def app_icon(self) -> QIcon:
        return project_app_icon(self.project_root)

    def open_url(self, url: str) -> None:
        QDesktopServices.openUrl(QUrl(url))

    def open_path(self, path: Path) -> None:
        target = path if path.exists() else path.parent if path.parent.exists() else Path.cwd()
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(target)))
