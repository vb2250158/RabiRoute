from __future__ import annotations

import math
from pathlib import Path

from PySide6.QtCore import QEasingCurve, QPoint, QPropertyAnimation, QRect, QRectF, QSize, Qt, QVariantAnimation
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWidgets import QFrame, QLabel, QScrollArea, QSizePolicy, QVBoxLayout, QWidget


from .theme import rabi_scrollbar_stylesheet


DEFAULT_BUBBLE_STYLE = dict(skin="cat-paw", fontFamily="", fontSize=14, textColor="#504650",
                           backgroundColor="#fffaf3", borderColor="#a58b98", maxWidth=320,
                           opacity=1.0, displaySeconds=12, maxVisible=3)


def normalize_bubble_style(value: object) -> dict:
    row = value if isinstance(value, dict) else {}
    result = dict(DEFAULT_BUBBLE_STYLE)
    result["skin"] = "plain" if row.get("skin") == "plain" else "cat-paw"
    result["fontFamily"] = "".join(c for c in str(row.get("fontFamily") or "") if ord(c) >= 32 and ord(c) != 127)[:80]
    for key in ("textColor", "backgroundColor", "borderColor"):
        color = str(row.get(key) or "")
        if len(color) == 7 and color.startswith("#") and all(c in "0123456789abcdefABCDEF" for c in color[1:]):
            result[key] = color.lower()
    for key, low, high in (("fontSize", 12, 24), ("maxWidth", 220, 480), ("opacity", .5, 1), ("displaySeconds", 2, 30), ("maxVisible", 1, 6)):
        try:
            number = float(row.get(key, result[key]))
            if math.isfinite(number):
                result[key] = max(low, min(high, number))
        except (TypeError, ValueError):
            pass
    result["maxVisible"] = int(result["maxVisible"])
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


def place_transcript_bubble(anchor: QRect, size: QSize, area: QRect, occupied: list[QRect]) -> QPoint | None:
    """Fit a separate input window beside the pet and the animated reply stack."""
    if size.width() > area.width() or size.height() > area.height():
        return None
    obstacles = [rect.adjusted(-8, -8, 8, 8) for rect in (anchor, *occupied)]
    columns = [anchor.right() + 9, anchor.left() - size.width() - 8, anchor.center().x() - size.width() // 2]
    rows = [anchor.top()]
    for rect in obstacles:
        columns.extend((rect.right() + 1, rect.left() - size.width()))
        rows.extend((rect.bottom() + 1, rect.top() - size.height()))
    rows.sort(key=lambda y: abs(y - anchor.top()))
    for x in columns:
        x = max(area.left(), min(x, area.right() - size.width() + 1))
        for y in rows:
            y = max(area.top(), min(y, area.bottom() - size.height() + 1))
            box = QRect(QPoint(x, y), size)
            if not any(box.intersects(rect) for rect in obstacles):
                return box.topLeft()
    return None


class DesktopPetTranscriptBubble(QWidget):
    """A local read-only microphone preview, outside the dialogue queue."""

    def __init__(self, flags: Qt.WindowType) -> None:
        super().__init__(None, flags | Qt.WindowType.WindowTransparentForInput)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setWindowTitle("语音转写")
        self.setFixedWidth(248)
        frame = QFrame(self)
        frame.setObjectName("petTranscript")
        frame.setStyleSheet(
            "QFrame#petTranscript { background: #f0f6ff; border: 1px solid #9bb7e2; border-radius: 12px; }"
            "QLabel { color: #1e3152; font-size: 14px; }"
            "QLabel#petTranscriptStatus { color: #345782; font-size: 12px; font-weight: 600; }"
        )
        self.status = QLabel()
        self.status.setObjectName("petTranscriptStatus")
        self.text = QLabel()
        self.text.setTextFormat(Qt.TextFormat.PlainText)
        self.text.setWordWrap(True)
        self.text.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        inside = QVBoxLayout(frame)
        inside.setContentsMargins(12, 8, 12, 8)
        inside.setSpacing(3)
        inside.addWidget(self.status)
        inside.addWidget(self.text)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(frame)

    def set_preview(self, preview: tuple[str, bool] | None) -> None:
        if preview is None:
            self.hide()
            self.text.clear()
            self.status.clear()
            return
        text, final = preview
        text = " ".join(text.split())
        self.status.setText("你 · 转写完成" if final else "你 · 正在转写")
        self.text.setText("…" + text[-150:] if len(text) > 150 else text)
        self.text.setVisible(bool(text))
        self.adjustSize()


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
        self._style = {}
        self._tail_progress = 1.0
        self._tail_animation = QVariantAnimation(self)
        self._tail_animation.setDuration(160)
        self._tail_animation.setEasingCurve(QEasingCurve.Type.OutCubic)
        self._tail_animation.valueChanged.connect(self._set_tail_progress)
        self._motion = QPropertyAnimation(self, b"pos", self)
        self._motion.setDuration(260)
        self._motion.setEasingCurve(QEasingCurve.Type.OutCubic)
        self._motion_target = None
        self._fade = QPropertyAnimation(self, b"windowOpacity", self)
        self._fade.setDuration(180)
        self._fade.setEasingCurve(QEasingCurve.Type.OutCubic)
        self._fade.finished.connect(self._finish_exit)
        self._exiting = False
        self._delete_after_exit = False
        self._content_text = None
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
        style = normalize_bubble_style(value)
        if style == self._style:
            return
        self._style = style
        self.setFixedWidth(int(self._style["maxWidth"]))
        font = QFont(self._style["fontFamily"]) if self._style["fontFamily"] else QFont()
        font.setPixelSize(int(self._style["fontSize"]))
        self._text.setFont(font)
        palette = self._text.palette()
        palette.setColor(self._text.foregroundRole(), QColor(self._style["textColor"]))
        self._text.setPalette(palette)
        self._text.setStyleSheet(f"background: transparent; color: {self._style['textColor']};")
        self._scroll.setStyleSheet(
            "QScrollArea, QScrollArea > QWidget > QWidget {background: transparent;}"
            + rabi_scrollbar_stylesheet(foreground=self._style["textColor"])
        )
        self._scroll.viewport().setAutoFillBackground(False)
        self.setWindowOpacity(float(self._style["opacity"]))
        self._update_margins()
        self._content_text = None
        self.set_content(self._text.text())
        self.update()

    def _set_tail_progress(self, value: float) -> None:
        self._tail_progress = float(value)
        self.update()

    def set_tail_visible(self, visible: bool) -> None:
        target = 1.0 if visible else 0.0
        if self._tail_animation.endValue() == target:
            return
        self._tail_animation.stop()
        self._tail_animation.setStartValue(self._tail_progress)
        self._tail_animation.setEndValue(target)
        self._tail_animation.start()

    def placement_bounds(self) -> QRect:
        bounds = self.frameGeometry()
        if self._motion_target is not None:
            bounds = bounds.united(QRect(self._motion_target, self.size()))
        return bounds

    def transition_to(self, position: QPoint) -> None:
        entering = not self.isVisible() or self._exiting
        if entering:
            self._exiting = False
            self._fade.stop()
            if not self.isVisible():
                self.move(position + QPoint(0, 10))
                self.setWindowOpacity(0)
                self.show()
            self._fade.setStartValue(self.windowOpacity())
            self._fade.setEndValue(float(self._style["opacity"]))
            self._fade.start()
        if position == self._motion_target and not entering:
            return
        self._motion_target = QPoint(position)
        self._motion.stop()
        self._motion.setStartValue(self.pos())
        self._motion.setEndValue(position)
        self._motion.start()

    def dismiss(self, *, delete: bool = False) -> None:
        if self._exiting:
            return
        self._exiting, self._delete_after_exit = True, delete
        self._fade.stop()
        self._fade.setStartValue(self.windowOpacity())
        self._fade.setEndValue(0.0)
        self._fade.start()

    def _finish_exit(self) -> None:
        if self._exiting:
            self.hide()
            if self._delete_after_exit:
                self.deleteLater()

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
        value = str(text or "")[:4000]
        if value == self._content_text:
            return
        self._content_text = value
        self._text.setText(value)
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
        tail.lineTo(self._tail_x, base_y + (tip_y - base_y) * self._tail_progress)
        tail.lineTo(base_x + 10, base_y)
        if self._style["skin"] == "cat-paw" and not self._skin.isNull():
            painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
            for destination, source in nine_slice_rects(round(self._skin_rect.width()), round(self._skin_rect.height()), self.width(), body_height):
                destination.translate(0, body_y)
                source.translate(self._skin_rect.topLeft())
                painter.drawPixmap(destination, self._skin, source)
            if self._tail_progress > .001:
                painter.setOpacity(self._tail_progress)
                painter.fillPath(tail, self._skin_fill)
                painter.setPen(QPen(self._skin_border, 1.2))
                painter.drawPath(tail)
            return
        path = QPainterPath()
        path.addRoundedRect(QRectF(1, body_y + 1, self.width() - 2, body_height - 2), 16, 16)
        if self._tail_progress > .001:
            tail.closeSubpath()
            path = path.united(tail)
        painter.setPen(QPen(QColor(self._style["borderColor"]), 1.2))
        painter.setBrush(QColor(self._style["backgroundColor"]))
        painter.drawPath(path)
