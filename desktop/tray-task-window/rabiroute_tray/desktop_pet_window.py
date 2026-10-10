from __future__ import annotations

import math
import time

from PySide6.QtCore import QByteArray, QBuffer, QIODevice, QPoint, QSize, Qt, QTimer, Signal, qInfo
from PySide6.QtGui import QColor, QImageReader, QMouseEvent, QMovie, QPainter, QPen, QPixmap, QTransform
from PySide6.QtWidgets import QApplication, QGraphicsOpacityEffect, QLabel, QWidget

from .desktop_pet_client import DesktopPetPack, LoadedDesktopPetAnimation
from .desktop_pet_gait import SoleFrame, WalkingGait, walking_gait

class _TravelHalo(QWidget):
    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self.progress = 0.0
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self.hide()

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        strength = math.sin(math.pi * self.progress)
        color = QColor(130, 185, 255, round(220 * strength))
        painter.setPen(QPen(color, 3))
        radius = self.width() * (0.2 + 0.23 * strength)
        center_x, center_y = self.width() / 2, self.height() * 0.84
        painter.drawEllipse(QPoint(round(center_x), round(center_y)), round(radius), round(radius * 0.23))
        for index in range(6):
            angle = index * math.tau / 6 + self.progress * math.pi
            x, y = center_x + math.cos(angle) * radius, center_y + math.sin(angle) * radius * 0.4
            painter.drawLine(round(x - 4), round(y), round(x + 4), round(y))
            painter.drawLine(round(x), round(y - 4), round(x), round(y + 4))


class DesktopPetWindow(QWidget):
    clicked = Signal()
    double_clicked = Signal()
    animation_finished = Signal(str)
    placement_changed = Signal(object)
    context_menu_requested = Signal(object)
    drag_started = Signal()
    drag_finished = Signal()
    travel_phase_changed = Signal(str)
    travel_finished = Signal()
    travel_result = Signal(bool)

    def __init__(self, persona_name: str = "人格", default_slot: int = 0) -> None:
        flags = (
            Qt.WindowType.Tool
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.WindowDoesNotAcceptFocus
        )
        super().__init__(None, flags)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self._persona_name = str(persona_name or "人格")
        self._default_slot = max(0, int(default_slot))
        self.setWindowTitle(f"{self._persona_name}桌宠")
        self._label = QLabel(self)
        self._label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._label.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self._travel_opacity = QGraphicsOpacityEffect(self._label)
        self._travel_opacity.setOpacity(1)
        self._label.setGraphicsEffect(self._travel_opacity)
        self._travel_halo = _TravelHalo(self)
        self._travel_timer = QTimer(self)
        self._travel_timer.setSingleShot(True)
        self._travel_timer.setTimerType(Qt.TimerType.PreciseTimer)
        self._travel_timer.timeout.connect(self._advance_travel)
        self._travel_origin = QPoint()
        self._travel_target = QPoint()
        self._travel_started = 0.0
        self._travel_duration = 0.0
        self._travel_kind = ""
        self._travel_arrived = False
        self._travel_distance = 0.0
        self._walked_distance = 0.0
        self._facing_left = False
        self._walk_last_tick = 0.0
        self._walk_frame_elapsed = 0.0
        self._walk_speed = 0.0
        self._gait: WalkingGait | None = None
        self._prepared_gaits: dict[tuple[str, str, int, int], WalkingGait | None] = {}
        self._prepared_gif_delays: dict[tuple[str, str, int, int], tuple[int, ...]] = {}
        self._png_frame_delays: tuple[int, ...] = ()
        self._drag_offset: QPoint | None = None
        self._dragging = False
        self._movie: QMovie | None = None
        self._movie_buffer: QBuffer | None = None
        self._png_frames: tuple[QPixmap, ...] = ()
        self._prepared_png_frames: dict[tuple[str, str, int, int], tuple[QPixmap, ...]] = {}
        self._png_index = 0
        self._png_loop = True
        self._png_next_state = ""
        self._png_timer = QTimer(self)
        self._png_timer.timeout.connect(self._advance_png_frame)
        self._bubble_timer = QTimer(self)
        self._bubble_timer.setSingleShot(True)
        self._bubble_timer.timeout.connect(self.hide_bubble)
        self._single_click_timer = QTimer(self)
        self._single_click_timer.setSingleShot(True)
        self._single_click_timer.timeout.connect(self.clicked.emit)
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
        self._active_pack: DesktopPetPack | None = None
        self._active_animation: LoadedDesktopPetAnimation | None = None
        self._scale = 0.5
        self._fps_cap = 15
        self._locked = False
        self._bubble_enabled = True
        self.show_placeholder(f"{self._persona_name}\n素材准备中")

    def set_persona_name(self, persona_name: str) -> None:
        self._persona_name = str(persona_name or "人格")
        self.setWindowTitle(f"{self._persona_name}桌宠")

    @property
    def travelling(self) -> bool:
        return bool(self._travel_kind)

    @property
    def pointer_engaged(self) -> bool:
        return self._drag_offset is not None

    def travel_to(self, target: QPoint, kind: str) -> bool:
        if self._locked or self.pointer_engaged or not self.isVisible() or self.travelling:
            return False
        distance = math.hypot(target.x() - self.x(), target.y() - self.y())
        if distance < 8:
            return False
        self.hide_bubble()
        self._travel_origin = self.pos()
        self._travel_target = QPoint(target)
        self._travel_kind = kind
        self._travel_started = time.monotonic()
        self._travel_duration = 0.9 if kind == "teleport" else 0.0
        self._travel_distance = distance
        self._walked_distance = 0.0
        self._travel_arrived = False
        self.travel_phase_changed.emit("teleport-out" if kind == "teleport" else "move")
        if kind == "teleport":
            self._travel_timer.start(33)
            self._travel_halo.setGeometry(self.rect())
            self._travel_halo.show()
            self._travel_halo.raise_()
        else:
            if not self._png_frames or self._gait is None:
                self.cancel_travel()
                return False
            desired_left = target.x() < self.x() if abs(target.x() - self.x()) >= 8 else self._facing_left
            self._facing_left = desired_left
            cycle_ms = (sum(max(round(1000 / self._fps_cap), delay) for delay in self._png_frame_delays)
                        if self._png_frame_delays else len(self._png_frames) * self._png_timer.interval())
            self._walk_speed = self._gait.cycle_distance * 1000 / cycle_ms
            self._travel_duration = distance / self._walk_speed
            self._walk_last_tick = time.monotonic()
            self._walk_frame_elapsed = 0.0
            # One clock drives animation and continuous root motion. No frame-sized jumps.
            self._png_timer.stop()
            self._display_png_frame()
            self._travel_timer.start(16)
        qInfo(f"rabiroute.desktop-pet.motion desktop_pet_travel_started kind={kind} "
              f"distance={distance:.1f} duration={self._travel_duration:.2f} "
              f"cycleDistance={self._gait.cycle_distance if kind == 'move' and self._gait else 0:.2f}")
        return True

    def cancel_travel(self, *, completed: bool = False) -> None:
        active = self.travelling
        self._travel_kind = ""
        self._travel_timer.stop()
        self._travel_opacity.setOpacity(1)
        self._label.setGeometry(self.rect())
        self._travel_halo.hide()
        if self._png_frames and self._active_animation:
            self._png_timer.start(self._frame_interval(self._active_animation.state.fps))
        if active:
            qInfo("rabiroute.desktop-pet.motion " + ("desktop_pet_travel_completed" if completed else "desktop_pet_travel_cancelled"))
            self.travel_result.emit(completed)
            self.travel_finished.emit()

    def _advance_travel(self) -> None:
        if self._travel_kind == "move":
            now = time.monotonic()
            # A delayed UI callback slows both clocks; it cannot teleport the body ahead.
            elapsed = max(0.0, min(0.05, now - self._walk_last_tick))
            self._walk_last_tick = now
            self._walk_frame_elapsed += elapsed
            while self._active_animation and self._walk_frame_elapsed + 0.000001 >= self._frame_interval(self._active_animation.state.fps) / 1000:
                self._walk_frame_elapsed = max(0.0, self._walk_frame_elapsed - self._frame_interval(self._active_animation.state.fps) / 1000)
                self._advance_png_frame()
            self._walked_distance = min(self._travel_distance, self._walked_distance + self._walk_speed * elapsed)
            progress = self._walked_distance / self._travel_distance
            delta = self._travel_target - self._travel_origin
            self.move(self._travel_origin + QPoint(round(delta.x() * progress), round(delta.y() * progress)))
            if self._walked_distance >= self._travel_distance:
                self._keep_visible()
                self.cancel_travel(completed=True)
            else:
                self._travel_timer.start(16)
            return
        if self._travel_kind != "teleport":
            return
        progress = min(1.0, (time.monotonic() - self._travel_started) / self._travel_duration)
        if self._travel_kind == "teleport":
            self._travel_opacity.setOpacity(abs(2 * progress - 1))
            if progress >= 0.5 and not self._travel_arrived:
                self._travel_arrived = True
                self.move(self._travel_target)
                self.travel_phase_changed.emit("teleport-in")
            self._travel_halo.progress = progress
            self._travel_halo.update()
        if progress >= 1:
            self.move(self._travel_target)
            self._keep_visible()
            self.cancel_travel(completed=True)
        elif self.travelling:
            self._travel_timer.start(33)

    def show_placeholder(self, text: str) -> None:
        self.stop_animation()
        self._active_pack = None
        self._active_animation = None
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
        if self._active_pack is None or self._active_pack.pack_id != pack.pack_id:
            self._facing_left = pack.source_facing == "left"
        self._active_pack = pack
        self._active_animation = animation
        target = self._target_size(pack)
        self.resize(target)
        self._keep_visible()
        self._label.setGeometry(self.rect())
        self._label.setText("")
        self._label.setStyleSheet("background: transparent;")
        if animation.state.kind == "gif" and animation.state.name != "move":
            self._play_gif(animation.assets[0], target, animation.state.next_state)
        else:
            self._play_png_sequence(animation, target)

    def prepare_animation(self, pack: DesktopPetPack, animation: LoadedDesktopPetAnimation) -> bool:
        """Pre-render a Manager-authorized PNG action before the user can select it."""
        if animation.state.kind != "png-sequence" and animation.state.name != "move":
            return True
        target = self._target_size(pack)
        cache_key = self._prepared_key(pack, animation, target)
        if cache_key in self._prepared_png_frames:
            return True
        frames = self._decode_png_frames(animation, target, cache_key)
        if not frames:
            return False
        self._prepared_png_frames[cache_key] = frames
        if animation.state.name == "move":
            self._prepared_gaits[cache_key] = walking_gait(tuple(self._measure_soles(frame) for frame in frames), pack.source_facing)
        return True

    def is_animation_prepared(self, pack: DesktopPetPack, animation: LoadedDesktopPetAnimation) -> bool:
        if animation.state.kind != "png-sequence" and animation.state.name != "move":
            return True
        key = self._prepared_key(pack, animation, self._target_size(pack))
        return key in self._prepared_png_frames and (animation.state.name != "move" or self._prepared_gaits.get(key) is not None)

    def clear_prepared_animations(self) -> None:
        self._prepared_png_frames.clear()
        self._prepared_gaits.clear()
        self._prepared_gif_delays.clear()

    def stop_animation(self) -> None:
        self._png_timer.stop()
        self._png_frames = ()
        self._gait = None
        self._png_frame_delays = ()
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
                spacing = self.width() + 16
                x = area.right() - self.width() - 24 - (self._default_slot * spacing)
                self.move(max(area.left(), x), area.bottom() - self.height() - 24)
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
        previous_scale = self._scale
        previous_fps_cap = self._fps_cap
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
        if (
            self._active_pack is not None
            and self._active_animation is not None
            and (abs(self._scale - previous_scale) > 0.001 or self._fps_cap != previous_fps_cap)
        ):
            self.cancel_travel()
            if abs(self._scale - previous_scale) > 0.001:
                self.clear_prepared_animations()
            self.play(self._active_pack, self._active_animation)

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
        movie.frameChanged.connect(self._display_movie_frame)
        movie.start()

    def _display_movie_frame(self, _index: int) -> None:
        if self._movie is not None:
            self._label.setPixmap(self._movie.currentPixmap().transformed(
                QTransform().scale(self._facing_scale(), 1)))

    def _play_png_sequence(self, animation: LoadedDesktopPetAnimation, target: QSize) -> None:
        cache_key = self._prepared_key(self._active_pack, animation, target)
        frames = self._prepared_png_frames.get(cache_key)
        if frames is None:
            frames = self._decode_png_frames(animation, target, cache_key)
            if frames:
                self._prepared_png_frames[cache_key] = frames
        if not frames:
            self.show_placeholder(f"{self._persona_name}\n素材无法解码")
            return
        self._png_frames = frames
        self._png_frame_delays = self._prepared_gif_delays.get(cache_key, ())
        if animation.state.name == "move":
            if cache_key not in self._prepared_gaits:
                self._prepared_gaits[cache_key] = walking_gait(tuple(self._measure_soles(frame) for frame in frames), self._active_pack.source_facing)
            self._gait = self._prepared_gaits[cache_key]
        self._png_index = 0
        self._png_loop = animation.state.loop
        self._png_next_state = animation.state.next_state
        self._display_png_frame()
        self._png_timer.start(self._frame_interval(animation.state.fps))

    def _frame_interval(self, fps: int) -> int:
        if self._png_frame_delays:
            return max(round(1000 / self._fps_cap), self._png_frame_delays[self._png_index])
        return max(42, round(1000 / min(fps, self._fps_cap)))

    def _target_size(self, pack: DesktopPetPack) -> QSize:
        return QSize(
            max(64, min(1024, int(pack.canvas_width * self._scale))),
            max(64, min(1024, int(pack.canvas_height * self._scale))),
        )

    def _prepared_key(
        self,
        pack: DesktopPetPack | None,
        animation: LoadedDesktopPetAnimation,
        target: QSize,
    ) -> tuple[str, str, int, int]:
        return (pack.pack_id if pack is not None else "", animation.state.name, target.width(), target.height())

    def _decode_png_frames(self, animation: LoadedDesktopPetAnimation, target: QSize,
                           cache_key: tuple[str, str, int, int]) -> tuple[QPixmap, ...]:
        if animation.state.kind == "gif":
            buffer = QBuffer()
            buffer.setData(QByteArray(animation.assets[0]))
            buffer.open(QIODevice.OpenModeFlag.ReadOnly)
            reader = QImageReader(buffer, b"gif")
            frames, delays = [], []
            for _ in range(600):
                image = reader.read()
                if image.isNull():
                    break
                frames.append(QPixmap.fromImage(image).scaled(target, Qt.AspectRatioMode.KeepAspectRatio,
                                                              Qt.TransformationMode.SmoothTransformation))
                delays.append(max(10, reader.nextImageDelay()))
            buffer.close()
            self._prepared_gif_delays[cache_key] = tuple(delays)
            return tuple(frames)
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
        return tuple(frames)

    def _advance_png_frame(self) -> None:
        if not self._png_frames:
            return
        next_index = self._png_index + 1
        if next_index >= len(self._png_frames):
            if not self._png_loop and self._travel_kind != "move":
                self._png_timer.stop()
                self.animation_finished.emit(self._png_next_state)
                return
            next_index = 0
        self._png_index = next_index
        if self._png_frame_delays and self._active_animation and self._travel_kind != "move":
            self._png_timer.start(self._frame_interval(self._active_animation.state.fps))
        self._display_png_frame()

    @staticmethod
    def _measure_soles(pixmap: QPixmap) -> SoleFrame:
        image = pixmap.toImage()
        source_width, source_height = image.width(), image.height()
        if max(source_width, source_height) > 256:
            image = image.scaled(256, 256, Qt.AspectRatioMode.KeepAspectRatio,
                                 Qt.TransformationMode.SmoothTransformation)
        # Only the lowest quarter of each half is eligible: no hands/tail/body.
        band_top = round(image.height() * 0.75)
        sole_points = []
        for left, right in ((0, image.width() // 2), (image.width() // 2, image.width())):
            point = None
            for y in range(image.height() - 1, band_top - 1, -1):
                xs = [x for x in range(left, right) if image.pixelColor(x, y).alpha() >= 128]
                if xs:
                    point = (sum(xs) / len(xs) * source_width / image.width(),
                             y * source_height / image.height())
                    break
            sole_points.append(point)
        return SoleFrame(*sole_points)

    def _facing_scale(self) -> float:
        source_left = self._active_pack is not None and self._active_pack.source_facing == "left"
        return -1.0 if self._facing_left != source_left else 1.0

    def _display_png_frame(self) -> None:
        if not self._png_frames:
            return
        frame = self._png_frames[self._png_index]
        horizontal_scale = self._facing_scale()
        self._label.setPixmap(frame.transformed(QTransform().scale(horizontal_scale, 1)))
        floor_offset = self._gait.floor_offsets[self._png_index] if self._travel_kind == "move" and self._gait else 0
        self._label.move(0, round(floor_offset))

    def resizeEvent(self, event) -> None:
        self._label.setGeometry(self.rect())
        self._travel_halo.setGeometry(self.rect())
        super().resizeEvent(event)

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton and not self._locked:
            self.cancel_travel()
            self._drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            self._dragging = False
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if self._drag_offset is not None and event.buttons() & Qt.MouseButton.LeftButton:
            if not self._dragging:
                self._dragging = True
                self.drag_started.emit()
            self.move(event.globalPosition().toPoint() - self._drag_offset)
            if self._bubble.isVisible():
                self._place_bubble()
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            was_dragging = self._dragging
            self._drag_offset = None
            self._dragging = False
            self._keep_visible()
            placement = self.placement()
            if placement is not None:
                self.placement_changed.emit(placement)
            if was_dragging:
                self.drag_finished.emit()
            else:
                self._single_click_timer.start(QApplication.doubleClickInterval())
        elif event.button() == Qt.MouseButton.RightButton:
            self.context_menu_requested.emit(event.globalPosition().toPoint())
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._single_click_timer.stop()
            self.double_clicked.emit()
            event.accept()
            return
        super().mouseDoubleClickEvent(event)

    def closeEvent(self, event) -> None:
        self.cancel_travel()
        self.stop_animation()
        self._single_click_timer.stop()
        self._bubble_timer.stop()
        self._bubble.close()
        super().closeEvent(event)
