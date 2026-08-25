from __future__ import annotations

from PySide6.QtCore import QByteArray, QBuffer, QIODevice, QPoint, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QMouseEvent, QMovie, QPixmap
from PySide6.QtWidgets import QApplication, QLabel, QWidget

from .desktop_pet_client import DesktopPetPack, LoadedDesktopPetAnimation


class DesktopPetWindow(QWidget):
    double_clicked = Signal()
    animation_finished = Signal(str)
    placement_changed = Signal(object)
    context_menu_requested = Signal(object)

    def __init__(self) -> None:
        flags = (
            Qt.WindowType.Tool
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.WindowDoesNotAcceptFocus
        )
        super().__init__(None, flags)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setWindowTitle("夜雨桌宠")
        self._label = QLabel(self)
        self._label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._label.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self._drag_offset: QPoint | None = None
        self._movie: QMovie | None = None
        self._movie_buffer: QBuffer | None = None
        self._png_frames: tuple[QPixmap, ...] = ()
        self._png_index = 0
        self._png_loop = True
        self._png_next_state = ""
        self._png_timer = QTimer(self)
        self._png_timer.timeout.connect(self._advance_png_frame)
        self._bubble_timer = QTimer(self)
        self._bubble_timer.setSingleShot(True)
        self._bubble_timer.timeout.connect(self.hide_bubble)
        self._bubble = QLabel(None, self.windowFlags())
        self._bubble.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self._bubble.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self._bubble.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self._bubble.setWordWrap(True)
        self._bubble.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        self._bubble.setMaximumWidth(320)
        self._bubble.setStyleSheet(
            "QLabel { color: #f7f9ff; background: rgba(32, 40, 61, 226); "
            "border: 1px solid rgba(181, 201, 255, 176); border-radius: 14px; "
            "font-size: 14px; padding: 10px 12px; }"
        )
        self._placed = False
        self._scale = 0.5
        self._fps_cap = 15
        self._locked = False
        self._bubble_enabled = True
        self.show_placeholder("夜雨\n素材准备中")

    def show_placeholder(self, text: str) -> None:
        self.stop_animation()
        self.resize(176, 112)
        self._label.setGeometry(self.rect())
        self._label.setText(text)
        self._label.setStyleSheet(
            "QLabel { color: white; background: rgba(37, 48, 75, 205); "
            "border: 1px solid rgba(181, 201, 255, 160); border-radius: 18px; "
            "font-size: 15px; padding: 12px; }"
        )

    def play(self, pack: DesktopPetPack, animation: LoadedDesktopPetAnimation) -> None:
        self.stop_animation()
        target = QSize(
            max(64, min(1024, int(pack.canvas_width * self._scale))),
            max(64, min(1024, int(pack.canvas_height * self._scale))),
        )
        self.resize(target)
        self._keep_visible()
        self._label.setGeometry(self.rect())
        self._label.setText("")
        self._label.setStyleSheet("background: transparent;")
        if animation.state.kind == "gif":
            self._play_gif(animation.assets[0], target, animation.state.next_state)
        else:
            self._play_png_sequence(animation, target)

    def stop_animation(self) -> None:
        self._png_timer.stop()
        self._png_frames = ()
        if self._movie is not None:
            self._movie.stop()
            self._movie.deleteLater()
        if self._movie_buffer is not None:
            self._movie_buffer.close()
            self._movie_buffer.deleteLater()
        self._movie = None
        self._movie_buffer = None
        self._label.clear()

    def show_on_desktop(self) -> None:
        if not self._placed:
            screen = QApplication.primaryScreen()
            if screen is not None:
                area = screen.availableGeometry()
                self.move(area.right() - self.width() - 24, area.bottom() - self.height() - 24)
            self._placed = True
        self.show()
        self.raise_()

    def show_bubble(self, text: str, duration_ms: int = 6000) -> None:
        if not self._bubble_enabled:
            return
        normalized = " ".join(str(text or "").split())[:180]
        if not normalized:
            return
        self._bubble.setText(normalized)
        self._bubble.adjustSize()
        self._place_bubble()
        self._bubble.show()
        self._bubble.raise_()
        self._bubble_timer.start(max(1500, min(15000, int(duration_ms))))

    def hide_bubble(self) -> None:
        self._bubble.hide()

    def _place_bubble(self) -> None:
        bubble_x = self.x() + max(0, (self.width() - self._bubble.width()) // 2)
        bubble_y = self.y() - self._bubble.height() - 10
        screen = QApplication.screenAt(self.frameGeometry().center()) or QApplication.primaryScreen()
        if screen is not None:
            area = screen.availableGeometry()
            bubble_x = max(area.left(), min(bubble_x, area.right() - self._bubble.width() + 1))
            if bubble_y < area.top():
                bubble_y = min(area.bottom() - self._bubble.height() + 1, self.y() + self.height() + 10)
        self._bubble.move(bubble_x, bubble_y)

    def set_click_through(self, enabled: bool) -> None:
        was_visible = self.isVisible()
        self.setWindowFlag(Qt.WindowType.WindowTransparentForInput, enabled)
        if was_visible:
            self.show_on_desktop()

    def apply_presentation_settings(
        self,
        *,
        scale: float,
        opacity: float,
        always_on_top: bool,
        locked: bool,
        bubble_enabled: bool,
        fps_cap: int,
    ) -> None:
        self._scale = max(0.1, min(2.0, float(scale)))
        self._fps_cap = min((6, 12, 15, 24), key=lambda candidate: abs(candidate - int(fps_cap)))
        self._locked = bool(locked)
        self._bubble_enabled = bool(bubble_enabled)
        self.setWindowOpacity(max(0.2, min(1.0, float(opacity))))
        was_visible = self.isVisible()
        bubble_visible = self._bubble.isVisible()
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, bool(always_on_top))
        self._bubble.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, bool(always_on_top))
        if was_visible:
            self.show_on_desktop()
        if bubble_visible:
            self._bubble.show()
            self._place_bubble()

    def restore_placement(self, placement: object) -> None:
        row = placement if isinstance(placement, dict) else {}
        screen_name = str(row.get("screen") or "")
        screen = next((item for item in QApplication.screens() if item.name() == screen_name), None)
        screen = screen or QApplication.primaryScreen()
        if screen is None:
            return
        area = screen.availableGeometry()
        x_ratio = max(0.0, min(1.0, float(row.get("xRatio", 1))))
        y_ratio = max(0.0, min(1.0, float(row.get("yRatio", 1))))
        span_x = max(0, area.width() - self.width())
        span_y = max(0, area.height() - self.height())
        self.move(area.left() + round(span_x * x_ratio), area.top() + round(span_y * y_ratio))
        self._placed = True

    def placement(self) -> dict[str, object] | None:
        screen = QApplication.screenAt(self.frameGeometry().center()) or QApplication.primaryScreen()
        if screen is None:
            return None
        area = screen.availableGeometry()
        span_x = max(1, area.width() - self.width())
        span_y = max(1, area.height() - self.height())
        return {
            "screen": screen.name(),
            "xRatio": max(0.0, min(1.0, (self.x() - area.left()) / span_x)),
            "yRatio": max(0.0, min(1.0, (self.y() - area.top()) / span_y)),
        }

    def _keep_visible(self) -> None:
        screen = QApplication.screenAt(self.frameGeometry().center()) or QApplication.primaryScreen()
        if screen is None:
            return
        area = screen.availableGeometry()
        next_x = max(area.left(), min(self.x(), area.right() - self.width() + 1))
        next_y = max(area.top(), min(self.y(), area.bottom() - self.height() + 1))
        self.move(next_x, next_y)

    def recover_to_visible_screen(self) -> None:
        self._keep_visible()
        if self._bubble.isVisible():
            self._place_bubble()

    def _play_gif(self, payload: bytes, target: QSize, next_state: str) -> None:
        data = QByteArray(payload)
        buffer = QBuffer(self)
        buffer.setData(data)
        buffer.open(QIODevice.OpenModeFlag.ReadOnly)
        movie = QMovie(buffer, b"gif", self)
        movie.setScaledSize(target)
        movie.finished.connect(lambda: self.animation_finished.emit(next_state))
        self._movie_buffer = buffer
        self._movie = movie
        self._label.setMovie(movie)
        movie.start()

    def _play_png_sequence(self, animation: LoadedDesktopPetAnimation, target: QSize) -> None:
        frames: list[QPixmap] = []
        for payload in animation.assets:
            pixmap = QPixmap()
            if pixmap.loadFromData(payload, "PNG"):
                frames.append(
                    pixmap.scaled(
                        target,
                        Qt.AspectRatioMode.KeepAspectRatio,
                        Qt.TransformationMode.SmoothTransformation,
                    )
                )
        if not frames:
            self.show_placeholder("夜雨\n素材无法解码")
            return
        self._png_frames = tuple(frames)
        self._png_index = 0
        self._png_loop = animation.state.loop
        self._png_next_state = animation.state.next_state
        self._label.setPixmap(self._png_frames[0])
        self._png_timer.start(max(42, round(1000 / min(animation.state.fps, self._fps_cap))))

    def _advance_png_frame(self) -> None:
        if not self._png_frames:
            return
        next_index = self._png_index + 1
        if next_index >= len(self._png_frames):
            if not self._png_loop:
                self._png_timer.stop()
                self.animation_finished.emit(self._png_next_state)
                return
            next_index = 0
        self._png_index = next_index
        self._label.setPixmap(self._png_frames[self._png_index])

    def resizeEvent(self, event) -> None:
        self._label.setGeometry(self.rect())
        super().resizeEvent(event)

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton and not self._locked:
            self._drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if self._drag_offset is not None and event.buttons() & Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self._drag_offset)
            if self._bubble.isVisible():
                self._place_bubble()
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._drag_offset = None
            self._keep_visible()
            placement = self.placement()
            if placement is not None:
                self.placement_changed.emit(placement)
        elif event.button() == Qt.MouseButton.RightButton:
            self.context_menu_requested.emit(event.globalPosition().toPoint())
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self.double_clicked.emit()
            event.accept()
            return
        super().mouseDoubleClickEvent(event)

    def closeEvent(self, event) -> None:
        self.stop_animation()
        self._bubble_timer.stop()
        self._bubble.close()
        super().closeEvent(event)
