from __future__ import annotations

from PySide6.QtWidgets import QMenu


RABI_MENU_STYLESHEET = """
QMenu {
    background: #ffffff;
    border: 1px solid #d6e2e8;
    border-radius: 8px;
    color: #112033;
    font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
    font-size: 13px;
    padding: 6px;
}
QMenu::item {
    border-radius: 6px;
    padding: 8px 28px 8px 12px;
}
QMenu::item:selected {
    background: #eaf8f9;
    color: #0c2a4a;
}
QMenu::item:disabled {
    color: #a9b4be;
}
QMenu::separator {
    background: #e5ebef;
    height: 1px;
    margin: 5px 8px;
}
"""


def apply_rabi_menu_theme(*menus: QMenu) -> None:
    for menu in menus:
        menu.setStyleSheet(RABI_MENU_STYLESHEET)
