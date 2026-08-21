from __future__ import annotations

from PySide6.QtGui import QPalette

MENU_STYLESHEET = """
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

THEME = {
    "menu_stylesheet": MENU_STYLESHEET,
    "color_replacements": {},
    "application_palette": {
        QPalette.ColorRole.Window: "#f6f8fb",
        QPalette.ColorRole.WindowText: "#112033",
        QPalette.ColorRole.Base: "#fbfdff",
        QPalette.ColorRole.AlternateBase: "#f5f8fa",
        QPalette.ColorRole.ToolTipBase: "#ffffff",
        QPalette.ColorRole.ToolTipText: "#112033",
        QPalette.ColorRole.Text: "#112033",
        QPalette.ColorRole.Button: "#ffffff",
        QPalette.ColorRole.ButtonText: "#112033",
        QPalette.ColorRole.BrightText: "#ffffff",
        QPalette.ColorRole.Highlight: "#19bfc1",
        QPalette.ColorRole.HighlightedText: "#0c2a4a",
        QPalette.ColorRole.Link: "#0f8b8d",
    },
}
