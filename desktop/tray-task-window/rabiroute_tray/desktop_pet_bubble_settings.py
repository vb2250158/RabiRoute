from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (QColorDialog, QComboBox, QDialog, QDialogButtonBox,
                              QFontComboBox, QFormLayout, QPushButton, QSpinBox, QVBoxLayout)

from .desktop_pet_bubble import DesktopPetBubble, normalize_bubble_style


class DesktopPetBubbleSettings(QDialog):
    """Edit a persona's presentation; the controller persists it through Manager."""

    def __init__(self, style: object, parent=None):
        super().__init__(parent)
        self.setWindowTitle("气泡样式")
        self.style = normalize_bubble_style(style)
        layout = QVBoxLayout(self)
        form = QFormLayout()
        layout.addLayout(form)
        skin = QComboBox()
        skin.addItem("猫爪", "cat-paw")
        skin.addItem("纯色", "plain")
        skin.setCurrentIndex(1 if self.style["skin"] == "plain" else 0)
        skin.currentIndexChanged.connect(lambda: self._change("skin", skin.currentData()))
        form.addRow("外观", skin)
        font = QFontComboBox()
        if self.style["fontFamily"]:
            font.setCurrentText(self.style["fontFamily"])
        font.currentFontChanged.connect(lambda value: self._change("fontFamily", value.family()))
        form.addRow("字体", font)
        for key, label, low, high, multiplier, suffix in (
            ("fontSize", "字号", 12, 24, 1, " px"),
            ("maxWidth", "宽度", 220, 480, 1, " px"),
            ("opacity", "不透明度", 50, 100, 100, " %"),
            ("displaySeconds", "停留时间", 2, 30, 1, " 秒"),
        ):
            control = QSpinBox()
            control.setRange(low, high)
            control.setSuffix(suffix)
            control.setValue(round(self.style[key] * multiplier))
            control.valueChanged.connect(lambda value, k=key, m=multiplier: self._change(k, value / m))
            form.addRow(label, control)
        for key, label in (("textColor", "文字颜色"), ("backgroundColor", "纯色背景"), ("borderColor", "纯色描边")):
            button = QPushButton(self.style[key])
            button.clicked.connect(lambda checked=False, k=key, b=button: self._color(k, b))
            form.addRow(label, button)
        self.preview = DesktopPetBubble(Qt.WindowType.Widget)
        self.preview.setParent(self)
        self.preview.set_content("今天也在这里陪你。\n一起看视频、玩游戏吧。")
        layout.addWidget(self.preview, alignment=Qt.AlignmentFlag.AlignCenter)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.button(QDialogButtonBox.StandardButton.Save).setText("保存")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self.preview.apply_style(self.style)

    def _change(self, key: str, value: object):
        self.style[key] = value
        if hasattr(self, "preview"):
            self.preview.apply_style(self.style)

    def _color(self, key: str, button: QPushButton):
        color = QColorDialog.getColor(QColor(self.style[key]), self, button.text())
        if color.isValid():
            button.setText(color.name())
            self._change(key, color.name())
