from __future__ import annotations

import math
import time

from PySide6.QtCore import QByteArray, QBuffer, QIODevice, QPoint, QRect, QSize, Qt, QTimer, QVariantAnimation, Signal, qInfo
from PySide6.QtGui import QColor, QImage, QImageReader, QMouseEvent, QPainter, QPen, QPixmap, QRegion, QTransform
from PySide6.QtWidgets import QApplication, QGraphicsOpacityEffect, QLabel, QWidget

from .desktop_pet_client import DesktopPetPack, LoadedDesktopPetAnimation
from .desktop_pet_gait import SoleFrame, WalkingGait, walking_gait
from .desktop_pet_bubble import DesktopPetBubble, place_dialogue_bubble

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
        self._previous_frame = QLabel(self)
        self._previous_frame.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._previous_frame.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self._previous_opacity = QGraphicsOpacityEffect(self._previous_frame)
        self._previous_frame.setGraphicsEffect(self._previous_opacity)
        self._previous_frame.hide()
        self._transition = QVariantAnimation(self)
        self._transition.setDuration(120)
        self._transition.valueChanged.connect(self._blend_frames)
        self._transition.finished.connect(self._finish_transition)
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
        self._turn_scale: float | None = None
        self._turn_animation = QVariantAnimation(self)
        self._turn_animation.setDuration(180)
        self._turn_animation.valueChanged.connect(self._display_turn)
        self._turn_animation.finished.connect(self._cancel_turn)
        self._walk_last_tick = 0.0
        self._walk_frame_elapsed = 0.0
        self._walk_speed = 0.0
        self._gait: WalkingGait | None = None
        self._prepared_gaits: dict[tuple[str, str, int, int], WalkingGait | None] = {}
        self._prepared_gif_delays: dict[tuple[str, str, int, int], tuple[int, ...]] = {}
        self._png_frame_delays: tuple[int, ...] = ()
        self._drag_offset: QPoint | None = None
        self._dragging = False
        self._png_frames: tuple[QPixmap, ...] = ()
        self._prepared_png_frames: dict[tuple[str, str, int, int], tuple[QPixmap, ...]] = {}
        self._png_index = 0
        self._png_loop = True
        self._png_next_state = ""
        self._png_timer = QTimer(self)
        self._png_timer.setTimerType(Qt.TimerType.PreciseTimer)
        self._png_timer.timeout.connect(self._advance_png_frame)
        self._bubble_timer = QTimer(self)
        self._bubble_timer.setSingleShot(True)
        self._bubble_timer.timeout.connect(self.hide_bubble)
        self._single_click_timer = QTimer(self)
        self._single_click_timer.setSingleShot(True)
        self._single_click_timer.timeout.connect(self.clicked.emit)
        self._bubble = DesktopPetBubble(self.windowFlags())
        self._placed = False
        self._active_pack: DesktopPetPack | None = None
        self._active_animation: LoadedDesktopPetAnimation | None = None
        self._scale = 0.5
        self._fps_cap = 15
        self._locked = False
        self._bubble_enabled = True
        self._speech_active = False
        self._sprite_bounds = QRect()
        self._sprite_canvas = QSize()
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

    @property
    def active_state(self) -> str:
        return self._active_animation.state.name if self._active_animation else ""

    @property
    def animation_running(self) -> bool:
        return self._png_timer.isActive() or self.travelling

    def is_playing(self, pack: DesktopPetPack | None, state_name: str) -> bool:
        return (self._active_pack is pack and self._active_animation is not None
                and self._active_animation.state.name == state_name)

    def travel_to(self, target: QPoint, kind: str) -> bool:
        if self._locked or self.pointer_engaged or not self.isVisible() or self.travelling:
            return False
        distance = math.hypot(target.x() - self.x(), target.y() - self.y())
        if distance < 8:
            return False
        self._finish_transition()
        self._cancel_turn()
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
                        if self._png_frame_delays else len(self._png_frames) * self._frame_interval(self._active_animation.state.fps))
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
              f"cycleDistance={self._gait.cycle_distance if kind == 'move' and self._gait else 0:.2f} "
              f"speed={self._walk_speed if kind == 'move' else 0:.2f} canvas={self.width()}x{self.height()}")
        return True

    def cancel_travel(self, *, completed: bool = False) -> None:
        self._cancel_turn()
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

    def face_toward(self, target: QPoint) -> None:
        """Turn in place toward a logical desktop point after arrival."""
        if self.travelling or self._locked or self.pointer_engaged or not self.isVisible():
            return
        delta = target.x() - (self.x() + self.width() / 2)
        if abs(delta) < 8 or (delta < 0) == self._facing_left:
            return
        previous_scale = self._facing_scale()
        self._finish_transition()
        self._turn_animation.stop()
        self._turn_scale = None
        self._facing_left = delta < 0
        final_scale = self._facing_scale()
        self._turn_scale = previous_scale
        self._turn_animation.setStartValue(previous_scale)
        self._turn_animation.setEndValue(final_scale)
        self._turn_animation.start()
        qInfo(f"rabiroute.desktop-pet.motion desktop_pet_arrival_turn facing={'left' if self._facing_left else 'right'}")

    def _display_turn(self, value: object) -> None:
        self._turn_scale = float(value)
        self._display_png_frame()

    def _cancel_turn(self) -> None:
        self._turn_animation.stop()
        self._turn_scale = None
        self._display_png_frame()

    def _advance_travel(self) -> None:
        if self._travel_kind == "move":
            if not self._png_frames or self._gait is None or self._active_animation is None:
                self.cancel_travel()
                return
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
        self._cancel_turn()
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

    def play(self, pack: DesktopPetPack, animation: LoadedDesktopPetAnimation) -> bool:
        # Decode the complete incoming action before touching the current playback.
        if not self.prepare_animation(pack, animation):
            return False
        previous = self._label.pixmap()
        previous_state = self.active_state
        blend = (previous is not None and not previous.isNull() and self._active_pack is pack
                 and not self.travelling and not self.pointer_engaged and self._turn_scale is None
                 and previous_state not in {"move", "drag", "teleport-out", "teleport-in"}
                 and animation.state.name not in {"move", "drag", "teleport-out", "teleport-in"})
        self.stop_animation()
        self._sprite_bounds = QRect()
        if self._active_pack is None or self._active_pack.pack_id != pack.pack_id:
            self._cancel_turn()
            self._facing_left = pack.source_facing == "left"
        self._active_pack = pack
        self._active_animation = animation
        target = self._target_size(pack)
        self.resize(target)
        self._keep_visible()
        self._label.setGeometry(self.rect())
        self._label.setText("")
        self._label.setStyleSheet("background: transparent;")
        self._play_png_sequence(animation, target)
        if blend:
            self._previous_frame.setGeometry(self.rect())
            self._previous_frame.setPixmap(previous)
            self._previous_opacity.setOpacity(1)
            self._travel_opacity.setOpacity(0)
            self._previous_frame.show()
            self._previous_frame.raise_()
            self._transition.setStartValue(0.0)
            self._transition.setEndValue(1.0)
            self._transition.start()
        return True

    def _blend_frames(self, value: object) -> None:
        progress = float(value)
        self._previous_opacity.setOpacity(1 - progress)
        self._travel_opacity.setOpacity(progress)

    def _finish_transition(self) -> None:
        self._transition.stop()
        self._previous_frame.hide()
        self._previous_frame.clear()
        self._travel_opacity.setOpacity(1)

    def prepare_animation(self, pack: DesktopPetPack, animation: LoadedDesktopPetAnimation) -> bool:
        """Pre-render an authorized action; GIF and PNG share one playback clock."""
        target = self._target_size(pack)
        cache_key = self._prepared_key(pack, animation, target)
        if cache_key in self._prepared_png_frames:
            return True
        frames = self._decode_png_frames(animation, target, cache_key)
        if not frames:
            return False
        self._prepared_png_frames[cache_key] = frames
        if animation.state.name == "move":
            self._prepared_gaits[cache_key] = self._prepare_walking_gait(pack, animation, frames)
        return True

    def _prepare_walking_gait(self, pack: DesktopPetPack, animation: LoadedDesktopPetAnimation,
                              frames: tuple[QPixmap, ...]) -> WalkingGait | None:
        reference_size = QSize(pack.canvas_width, pack.canvas_height).scaled(
            256, 256, Qt.AspectRatioMode.KeepAspectRatio)
        reference_key = self._prepared_key(pack, animation, reference_size)
        reference_frames = self._prepared_png_frames.get(reference_key)
        if reference_frames is None:
            reference_frames = self._decode_png_frames(animation, reference_size, reference_key)
            if not reference_frames:
                return None
            self._prepared_png_frames[reference_key] = reference_frames
        if reference_key not in self._prepared_gaits:
            self._prepared_gaits[reference_key] = walking_gait(
                tuple(self._measure_soles(frame) for frame in reference_frames), pack.source_facing)
        gait = self._prepared_gaits[reference_key]
        if gait is None:
            return None
        return gait.scaled(frames[0].width() / reference_frames[0].width(),
                           frames[0].height() / reference_frames[0].height())

    def is_animation_prepared(self, pack: DesktopPetPack, animation: LoadedDesktopPetAnimation) -> bool:
        key = self._prepared_key(pack, animation, self._target_size(pack))
        return key in self._prepared_png_frames and (animation.state.name != "move" or self._prepared_gaits.get(key) is not None)

    def clear_prepared_animations(self) -> None:
        self._prepared_png_frames.clear()
        self._prepared_gaits.clear()
        self._prepared_gif_delays.clear()

    def stop_animation(self) -> None:
        self._finish_transition()
        self._png_timer.stop()
        self._png_frames = ()
        self._gait = None
        self._png_frame_delays = ()
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

    def show_bubble(self, text: str, duration_ms: int | None = None) -> None:
        if not self._bubble_enabled or self._speech_active:
            return
        normalized = str(text or "").strip()[:4000]
        if not normalized:
            return
        self._bubble.set_content(normalized)
        self._place_bubble()
        self._bubble.show()
        self._bubble.raise_()
        self._bubble_timer.start(self._bubble.display_ms if duration_ms is None else max(1500, min(30000, int(duration_ms))))

    def show_speech_bubble(self, text: str, *, playing: bool) -> None:
        self._speech_active = playing
        if not self._bubble_enabled or not self.isVisible() or not text:
            return
        self._bubble.set_content(text)
        self._place_bubble()
        self._bubble.show()
        self._bubble.raise_()
        self._bubble_timer.stop()
        if not playing:
            self._bubble_timer.start(self._bubble.display_ms)

    def set_bubble_style(self, style: object) -> None:
        self._bubble.apply_style(style)
        if self._bubble.isVisible():
            self._place_bubble()

    def hide_bubble(self) -> None:
        self._bubble_timer.stop()
        self._bubble.hide()

    def finish_speech_bubble(self) -> None:
        self._speech_active = False
        self.hide_bubble()

    def _place_bubble(self) -> None:
        screen = QApplication.screenAt(self.frameGeometry().center()) or QApplication.primaryScreen()
        if screen is None:
            return
        position, tip_x, upward = place_dialogue_bubble(self._visible_sprite_rect(), self._bubble.size(), screen.availableGeometry())
        self._bubble.set_tail_anchor(tip_x, upward)
        self._bubble.move(position)


    def _visible_sprite_rect(self) -> QRect:
        pixmap = self._label.pixmap()
        if pixmap is None or pixmap.isNull() or self._sprite_bounds.isNull() or self._sprite_canvas.isEmpty():
            return self.frameGeometry()
        factor = pixmap.width() / self._sprite_canvas.width()
        bounds = QRect(round(self._sprite_bounds.x() * factor), self._sprite_bounds.y(),
                       max(1, round(self._sprite_bounds.width() * factor)), self._sprite_bounds.height())
        if self._facing_scale() < 0:
            bounds.moveLeft(pixmap.width() - bounds.right() - 1)
        origin = self._label.mapToGlobal(QPoint((self._label.width() - pixmap.width()) // 2,
                                               (self._label.height() - pixmap.height()) // 2))
        return bounds.translated(origin)

    def set_click_through(self, enabled: bool) -> None:
        was_visible = self.isVisible()
        bubble_visible = self._bubble.isVisible()
        self.setWindowFlag(Qt.WindowType.WindowTransparentForInput, enabled)
        self._bubble.setWindowFlag(Qt.WindowType.WindowTransparentForInput, enabled)
        if was_visible:
            self.show_on_desktop()
        if bubble_visible:
            self._bubble.show()

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
        self._sprite_bounds = QRect()
        for frame in frames:
            self._sprite_bounds = self._sprite_bounds.united(QRegion(frame.mask()).boundingRect())
        self._sprite_canvas = frames[0].size()
        self._png_frame_delays = self._prepared_gif_delays.get(cache_key, ())
        if animation.state.name == "move":
            if cache_key not in self._prepared_gaits:
                self._prepared_gaits[cache_key] = self._prepare_walking_gait(self._active_pack, animation, frames)
            self._gait = self._prepared_gaits[cache_key]
        self._png_index = 0
        self._png_loop = animation.state.loop
        self._png_next_state = animation.state.next_state
        self._display_png_frame()
        if self._travel_kind != "move":
            self._png_timer.start(self._frame_interval(animation.state.fps))

    def _frame_interval(self, fps: int) -> int:
        if self._png_frame_delays:
            return max(round(1000 / self._fps_cap), self._png_frame_delays[self._png_index])
        return max(42, round(1000 / min(fps, self._fps_cap)))

    def _target_size(self, pack: DesktopPetPack) -> QSize:
        return QSize(
            max(1, min(1024, int(pack.canvas_width * self._scale))),
            max(1, min(1024, int(pack.canvas_height * self._scale))),
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
            if not animation.assets:
                return ()
            buffer = QBuffer()
            buffer.setData(QByteArray(animation.assets[0]))
            buffer.open(QIODevice.OpenModeFlag.ReadOnly)
            reader = QImageReader(buffer, b"gif")
            expected_frames = reader.imageCount()
            if expected_frames > 600:
                buffer.close()
                return ()
            frames, delays = [], []
            for _ in range(600):
                image = reader.read()
                if image.isNull():
                    break
                frames.append(QPixmap.fromImage(image).scaled(target, Qt.AspectRatioMode.KeepAspectRatio,
                                                              Qt.TransformationMode.SmoothTransformation))
                delays.append(max(10, reader.nextImageDelay()))
            buffer.close()
            if expected_frames > 0 and len(frames) != expected_frames:
                return ()
            self._prepared_gif_delays[cache_key] = tuple(delays)
            return tuple(frames)
        frames: list[QPixmap] = []
        for payload in animation.assets:
            pixmap = QPixmap()
            if not pixmap.loadFromData(payload, "PNG"):
                return ()
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
        image = pixmap.toImage().convertToFormat(QImage.Format.Format_RGBA8888)
        width = image.width()
        alpha = bytes(image.constBits())[3::4]
        occupied = [index for index, value in enumerate(alpha) if value >= 128]
        if not occupied:
            return SoleFrame(None, None)
        top, bottom = occupied[0] // width, occupied[-1] // width
        height = bottom - top + 1
        band_top = bottom - math.ceil(height * 0.12) + 1
        feet = [(index % width, index // width) for index in occupied if index // width >= band_top]
        # Split the occupied foot band, not the transparent canvas midpoint.
        # Average several sole rows so a single antialiased toe cannot set speed.
        split = (min(x for x, _ in feet) + max(x for x, _ in feet) + 1) / 2
        points = []
        for is_left in (True, False):
            foot = [(x, y) for x, y in feet if (x < split) == is_left]
            if not foot:
                points.append(None)
                continue
            floor = max(y for _, y in foot)
            sole = [x for x, y in foot if y >= floor - max(1, round(height * 0.01))]
            points.append((sum(sole) / len(sole), float(floor)))
        return SoleFrame(*points, occupied_height=float(height))

    def _facing_scale(self) -> float:
        if self._turn_scale is not None:
            # Keep a narrow silhouette at the midpoint instead of disappearing.
            return math.copysign(max(0.08, abs(self._turn_scale)), self._turn_scale)
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
        if self._bubble.isVisible():
            self._place_bubble()

    def resizeEvent(self, event) -> None:
        self._label.setGeometry(self.rect())
        self._previous_frame.setGeometry(self.rect())
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

    def hideEvent(self, event) -> None:
        self._finish_transition()
        self._cancel_turn()
        self.hide_bubble()
        super().hideEvent(event)
