from __future__ import annotations

from PySide6.QtGui import QPalette

MENU_STYLESHEET = """
QMenu {
    background: #19242e;
    border: 1px solid #31414f;
    border-radius: 8px;
    color: #e9f2f7;
    font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
    font-size: 13px;
    padding: 6px;
}
QMenu::item {
    border-radius: 6px;
    padding: 8px 28px 8px 12px;
}
QMenu::item:selected {
    background: #1b3a40;
    color: #f0f8fc;
}
QMenu::item:disabled {
    color: #708392;
}
QMenu::separator {
    background: #31414f;
    height: 1px;
    margin: 5px 8px;
}
"""

THEME = {
    "menu_stylesheet": MENU_STYLESHEET,
    "color_replacements": {
        "#ffffff": "#19242e", "#fbfdff": "#1d2934", "#f7fafc": "#202c37", "#f6f8fb": "#121a22",
        "#f5f8fa": "#202c37", "#f4f9fb": "#121a22", "#f2fbfc": "#1b3a40", "#f2f8fa": "#121a22",
        "#eef6f8": "#10161d", "#eef4f7": "#202c37", "#eaf8f9": "#1b3a40", "#e9f8f9": "#1b3a40",
        "#e0f4f5": "#1b3a40", "#f0f8f9": "#1b3a40", "#f1fbfb": "#1b3a40", "#eef8f9": "#1b3a40",
        "#dbe5ea": "#31414f", "#d6e2e8": "#31414f", "#e5ebef": "#31414f", "#e1e8ec": "#31414f",
        "#edf1f3": "#31414f", "#cad8e0": "#526779", "#d3dfe5": "#526779", "#d3e2e6": "#526779",
        "#112033": "#e9f2f7", "#0c2a4a": "#f0f8fc", "#102a43": "#f0f8fc", "#334e62": "#c4d3dd",
        "#36566b": "#c4d3dd", "#52677a": "#c4d3dd", "#667586": "#b1c3cf", "#718291": "#9db1bf",
        "#7b8996": "#9db1bf", "#8491a0": "#9db1bf", "#94a3b8": "#9db1bf", "#a4afb8": "#708392",
        "#a9b4be": "#708392", "#19bfc1": "#43d4d7", "#0f8b8d": "#88edef", "#087f91": "#88edef",
        "#0b7476": "#88edef", "#eaf8ef": "#1e3b2a", "#fff7e6": "#443617", "#fff8f1": "#443617",
        "#fff0d5": "#443617", "#fff1ed": "#46292f", "#fff0f0": "#46292f", "#eef9ff": "#1b374b",
        "#bdeced": "#3e6c73", "#bde4e6": "#3e6c73", "#c8e9ea": "#3e6c73", "#d2e9ea": "#3e6c73",
        "#d2eeee": "#3e6c73", "#a9dddf": "#3e6c73", "#9edbdd": "#3e6c73", "#bfe6e7": "#3e6c73",
        "#cfe5e6": "#3e6c73", "#7ccfd0": "#43d4d7", "#b9e3c8": "#3d7453", "#f4d293": "#80612a",
        "#f2d399": "#80612a", "#f1b87a": "#80612a", "#f0bcbc": "#834451", "#a9d5f7": "#3f7193",
        "#194466": "#2d5f74", "#f0f2f4": "#27323c", "#e3e8eb": "#405260",
    },
    "application_palette": {
        QPalette.ColorRole.Window: "#121a22",
        QPalette.ColorRole.WindowText: "#e9f2f7",
        QPalette.ColorRole.Base: "#1d2934",
        QPalette.ColorRole.AlternateBase: "#202c37",
        QPalette.ColorRole.ToolTipBase: "#19242e",
        QPalette.ColorRole.ToolTipText: "#e9f2f7",
        QPalette.ColorRole.Text: "#e9f2f7",
        QPalette.ColorRole.Button: "#19242e",
        QPalette.ColorRole.ButtonText: "#e9f2f7",
        QPalette.ColorRole.BrightText: "#ffffff",
        QPalette.ColorRole.Highlight: "#43d4d7",
        QPalette.ColorRole.HighlightedText: "#102a43",
        QPalette.ColorRole.Link: "#88edef",
    },
}
