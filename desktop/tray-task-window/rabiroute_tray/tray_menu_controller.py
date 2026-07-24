from __future__ import annotations

from PySide6.QtCore import QObject
from PySide6.QtGui import QCursor
from PySide6.QtWidgets import QMenu, QSystemTrayIcon


TRAY_MENU_ACTIVATION_REASONS = frozenset(
    {
        QSystemTrayIcon.Trigger,
        QSystemTrayIcon.Context,
    }
)


def show_tray_menu_for_activation(menu: QMenu, reason) -> bool:
    """Open the prebuilt menu immediately for a left or right tray click."""
    if reason not in TRAY_MENU_ACTIVATION_REASONS:
        return False
    if not menu.isVisible():
        menu.popup(QCursor.pos())
    return True


class TrayMenuController(QObject):
    """Presentation-only adapter from QSystemTrayIcon activation to QMenu popup."""

    def __init__(self, tray: QSystemTrayIcon, menu: QMenu) -> None:
        super().__init__(tray)
        self.menu = menu
        tray.activated.connect(self.handle_activation)

    def handle_activation(self, reason) -> bool:
        return show_tray_menu_for_activation(self.menu, reason)
