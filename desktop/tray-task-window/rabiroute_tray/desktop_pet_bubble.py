from __future__ import annotations

import math
from pathlib import Path

from PySide6.QtCore import QPoint, QRect, QRectF, QSize, Qt
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWidgets import QLabel, QScrollArea, QVBoxLayout, QWidget


DEFAULT_BUBBLE_STYLE = dict(skin="cat-paw", fontFamily="", fontSize=14, textColor="#504650",
                           backgroundColor="#fffaf3", borderColor="#a58b98", maxWidth=320,
                           opacity=1.0, displaySeconds=8)


def normalize_bubble_style(value: object) -> dict:
    row = value if isinstance(value, dict) else {}
    result = dict(DEFAULT_BUBBLE_STYLE)
    result["skin"] = "plain" if row.get("skin") == "plain" else "cat-paw"
    result["fontFamily"] = "".join(c for c in str(row.get("fontFamily") or "") if ord(c) >= 32 and ord(c) != 127)[:80]
    for key in ("textColor", "backgroundColor", "borderColor"):
        color = str(row.get(key) or "")
        if len(color) == 7 and color.startswith("#") and all(c in "0123456789abcdefABCDEF" for c in color[1:]):
            result[key] = color.lower()
    for key, low, high in (("fontSize", 12, 24), ("maxWidth", 220, 480), ("opacity", .5, 1), ("displaySeconds", 2, 30)):
        try:
            number = float(row.get(key, result[key]))
            if math.isfinite(number):
                result[key] = max(low, min(high, number))
        except (TypeError, ValueError):
            pass
    return result


TAIL_HEIGHT = 14


def place_dialogue_bubble(anchor: QRect, size: QSize, area: QRect):
    """Center on visible artwork, clamp the frame, then aim its independent tip."""
    x = max(area.left(), min(anchor.center().x() - size.width() // 2, area.right() - size.width() + 1))
    y = anchor.top() - size.height() - 8
    above = y >= area.top()
    if not above:
        y = anchor.bottom() + 9
    y = max(area.top(), min(y, area.bottom() - size.height() + 1))
    return QPoint(x, y), anchor.center().x() - x, not above


def nine_slice_rects(source_width: int, source_height: int, width: int, height: int):
    """Keep the paw fixed; the pointer is drawn independently from the skin."""
    sx = (0., source_width * .25, source_width * .65, float(source_width))
    sy = (0., source_height * .24, source_height * .72, float(source_height))
    dx = (0., 40., float(width - 84), float(width))
    dy = (0., 28., float(height - 50), float(height))
    for y in range(3):
        for x in range(3):
            yield (QRectF(dx[x], dy[y], dx[x + 1] - dx[x], dy[y + 1] - dy[y]),
                   QRectF(sx[x], sy[y], sx[x + 1] - sx[x], sy[y + 1] - sy[y]))


class DesktopPetBubble(QWidget):
    """Plain dialogue text over a nine-slice skin; speech remains owned by its FIFO."""

    def __init__(self, flags: Qt.WindowType) -> None:
        super().__init__(None, flags)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setWindowTitle("桌宠气泡")
        self._skin = QPixmap(str(Path(__file__).parent / "assets" / "bubble-cat-paw-body-v2.png"))
        self._skin_rect = QRectF(self._skin.rect())
        self._tail_x = 160
        self._tail_up = False
        self._skin_fill = QColor("#fffaf3")
        self._skin_border = QColor("#a58b98")
        if not self._skin.isNull():
            image = self._skin.toImage()
            # Read the continuous opaque body around its center. Transparent
            # padding belongs to the source texture, not the frame's geometry.
            cx, cy = image.width() // 2, image.height() // 2
            left = right = cx
            top = bottom = cy
            while left > 0 and image.pixelColor(left - 1, cy).alpha() >= 128: left -= 1
            while right < image.width() - 1 and image.pixelColor(right + 1, cy).alpha() >= 128: right += 1
            while top > 0 and image.pixelColor(cx, top - 1).alpha() >= 128: top -= 1
            while bottom < image.height() - 1 and image.pixelColor(cx, bottom + 1).alpha() >= 128: bottom += 1
            self._skin_rect = QRectF(max(0, left - 2), max(0, top - 2), right - left + 5, bottom - top + 5)
            self._skin_fill = image.pixelColor(cx, max(cy, bottom - 20))
            self._skin_border = image.pixelColor(cx, max(cy, bottom - 5))
        self._style = dict(DEFAULT_BUBBLE_STYLE)
        self._text = QLabel()
        self._text.setTextFormat(Qt.TextFormat.PlainText)
        self._text.setWordWrap(True)
        self._text.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        self._scroll = QScrollArea()
        self._scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        self._scroll.setWidgetResizable(True)
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._scroll.setWidget(self._text)
        self._layout = QVBoxLayout(self)
        self._layout.addWidget(self._scroll)
        self.apply_style({})

    @property
    def display_ms(self) -> int:
        return int(self._style["displaySeconds"] * 1000)

    def apply_style(self, value: object) -> None:
        self._style = normalize_bubble_style(value)
        self.setFixedWidth(int(self._style["maxWidth"]))
        font = QFont(self._style["fontFamily"]) if self._style["fontFamily"] else QFont()
        font.setPixelSize(int(self._style["fontSize"]))
        self._text.setFont(font)
        palette = self._text.palette()
        palette.setColor(self._text.foregroundRole(), QColor(self._style["textColor"]))
        self._text.setPalette(palette)
        self._text.setStyleSheet("background: transparent;")
        self._scroll.setStyleSheet("QScrollArea, QScrollArea > QWidget > QWidget {background: transparent;}")
        self._scroll.viewport().setAutoFillBackground(False)
        self.setWindowOpacity(float(self._style["opacity"]))
        self._update_margins()
        self.set_content(self._text.text())
        self.update()

    def set_tail_anchor(self, x: float, upward: bool = False) -> None:
        direction_changed = self._tail_up != bool(upward)
        self._tail_x = max(2, min(self.width() - 2, float(x)))
        self._tail_up = bool(upward)
        if direction_changed:
            self._update_margins()
        self.update()

    def _update_margins(self) -> None:
        bottom = 44 if self._style["skin"] == "cat-paw" else 14
        self._layout.setContentsMargins(20, 18 + (TAIL_HEIGHT if self._tail_up else 0),
                                       20, bottom + (0 if self._tail_up else TAIL_HEIGHT))

    def set_content(self, text: str) -> None:
        self._text.setText(str(text or "")[:4000])
        text_width = self.width() - 56
        self._text.setMinimumWidth(text_width)
        height = max(28, min(180, self._text.heightForWidth(text_width) + 6))
        self._scroll.setFixedHeight(height)
        self._scroll.verticalScrollBar().setValue(0)
        self.adjustSize()

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        body_y = TAIL_HEIGHT if self._tail_up else 0
        body_height = self.height() - TAIL_HEIGHT
        base_x = max(30, min(self.width() - 30, self._tail_x))
        base_y = body_y + 2 if self._tail_up else body_y + body_height - 2
        tip_y = 1 if self._tail_up else self.height() - 1
        tail = QPainterPath()
        tail.moveTo(base_x - 10, base_y)
        tail.lineTo(self._tail_x, tip_y)
        tail.lineTo(base_x + 10, base_y)
        if self._style["skin"] == "cat-paw" and not self._skin.isNull():
            painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
            for destination, source in nine_slice_rects(round(self._skin_rect.width()), round(self._skin_rect.height()), self.width(), body_height):
                destination.translate(0, body_y)
                source.translate(self._skin_rect.topLeft())
                painter.drawPixmap(destination, self._skin, source)
            painter.fillPath(tail, self._skin_fill)
            painter.setPen(QPen(self._skin_border, 1.2))
            painter.drawPath(tail)
            return
        path = QPainterPath()
        path.addRoundedRect(QRectF(1, body_y + 1, self.width() - 2, body_height - 2), 16, 16)
        tail.closeSubpath()
        path = path.united(tail)
        painter.setPen(QPen(QColor(self._style["borderColor"]), 1.2))
        painter.setBrush(QColor(self._style["backgroundColor"]))
        painter.drawPath(path)
