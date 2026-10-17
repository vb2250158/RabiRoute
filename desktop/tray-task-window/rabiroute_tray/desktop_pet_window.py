from __future__ import annotations

import math
import time

from PySide6.QtCore import QByteArray, QBuffer, QIODevice, QEvent, QPoint, QRect, QSize, Qt, QTimer, QVariantAnimation, Signal, qInfo
from PySide6.QtGui import QColor, QCursor, QImage, QImageReader, QMouseEvent, QPainter, QPen, QPixmap, QRegion, QTransform
from PySide6.QtWidgets import QApplication, QGraphicsOpacityEffect, QLabel, QWidget

from .desktop_pet_client import DesktopPetPack, LoadedDesktopPetAnimation
from .desktop_pet_gait import SoleFrame, WalkingGait, running_gait, walking_gait
from .desktop_pet_drag import DragFollow, NativeDrag, preserve_dpi_size
from .desktop_pet_physics import DisplayArea, PetFlight, ReleaseTrail
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
        self._release_trail = ReleaseTrail()
        self._flight: PetFlight | None = None
        self._drag_native: NativeDrag | None = None
        self._drag_follow: DragFollow | None = None
        self._drag_last_tick = 0.0
        self._drag_cursor = (0.0, 0.0)
        self._drag_release_cursor: tuple[float, float] | None = None
        self._drag_release_until = 0.0
        self._drag_drop_screen = None
        self._drag_timer = QTimer(self)
        self._drag_timer.setSingleShot(True)
        self._drag_timer.setTimerType(Qt.TimerType.PreciseTimer)
        self._drag_timer.timeout.connect(self._advance_drag)
        self._double_click_release = False
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
        self._bubble = DesktopPetBubble(self.windowFlags())
        self._placed = False
        self._active_pack: DesktopPetPack | None = None
        self._active_animation: LoadedDesktopPetAnimation | None = None
        self._scale = 0.5
        self._pixel_size_timer = QTimer(self)
        self._pixel_size_timer.setSingleShot(True)
        self._pixel_size_timer.timeout.connect(self._sync_pixel_size)
        self._scale_preview: float | None = None
        self._scale_preview_origin: QPoint | None = None
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
        if kind not in {"move", "run", "teleport"}:
            return False
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
        self.travel_phase_changed.emit("teleport-out" if kind == "teleport" else kind)
        if kind == "teleport":
            self._travel_timer.start(33)
            self._travel_halo.setGeometry(self.rect())
            self._travel_halo.show()
            self._travel_halo.raise_()
        else:
            if not self._png_frames or self._gait is None or self.active_state != kind:
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
              f"cycleDistance={self._gait.cycle_distance if kind in {'move', 'run'} and self._gait else 0:.2f} "
              f"speed={self._walk_speed if kind in {'move', 'run'} else 0:.2f} canvas={self.width()}x{self.height()}")
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
        if self._travel_kind in {"move", "run"}:
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
                 and previous_state not in {"move", "run", "drag", "teleport-out", "teleport-in"}
                 and animation.state.name not in {"move", "run", "drag", "teleport-out", "teleport-in"})
        self.stop_animation()
        self._sprite_bounds = QRect()
        if self._active_pack is None or self._active_pack.pack_id != pack.pack_id:
            self._cancel_turn()
            self._facing_left = pack.source_facing == "left"
        self._active_pack = pack
        self._active_animation = animation
        target = self._target_size(pack)
        self._resize_pet(self._preview_size() or target)
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
        if animation.state.name in {"move", "run"}:
            self._prepared_gaits[cache_key] = self._prepare_locomotion_gait(pack, animation, frames)
        return True

    def _prepare_locomotion_gait(self, pack: DesktopPetPack, animation: LoadedDesktopPetAnimation,
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
            calibrate = running_gait if animation.state.name == "run" else walking_gait
            self._prepared_gaits[reference_key] = calibrate(
                tuple(self._measure_soles(frame) for frame in reference_frames), pack.source_facing)
        gait = self._prepared_gaits[reference_key]
        if gait is None:
            return None
        return gait.scaled(frames[0].width() / reference_frames[0].width(),
                           frames[0].height() / reference_frames[0].height())

    def is_animation_prepared(self, pack: DesktopPetPack, animation: LoadedDesktopPetAnimation) -> bool:
        key = self._prepared_key(pack, animation, self._target_size(pack))
        return key in self._prepared_png_frames and (animation.state.name not in {"move", "run"} or self._prepared_gaits.get(key) is not None)

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
        ratio = max(.1, pixmap.devicePixelRatio())
        width, height = pixmap.width() / ratio, pixmap.height() / ratio
        horizontal = width / self._sprite_canvas.width()
        vertical = height / self._sprite_canvas.height()
        bounds = QRect(round(self._sprite_bounds.x() * horizontal), round(self._sprite_bounds.y() * vertical),
                       max(1, round(self._sprite_bounds.width() * horizontal)),
                       max(1, round(self._sprite_bounds.height() * vertical)))
        if self._facing_scale() < 0:
            bounds.moveLeft(round(width) - bounds.right() - 1)
        origin = self._label.mapToGlobal(QPoint(round((self._label.width() - width) / 2),
                                               round((self._label.height() - height) / 2)))
        return bounds.translated(origin)

    def set_click_through(self, enabled: bool) -> None:
        if enabled:
            self._finish_drag(cancelled=True)
        was_visible = self.isVisible()
        bubble_visible = self._bubble.isVisible()
        self.setWindowFlag(Qt.WindowType.WindowTransparentForInput, enabled)
        self._bubble.setWindowFlag(Qt.WindowType.WindowTransparentForInput, enabled)
        if was_visible:
            self.show_on_desktop()
        if bubble_visible:
            self._bubble.show()

    def _preview_size(self) -> QSize | None:
        if self._scale_preview is None or self._active_pack is None:
            return None
        return QSize(max(1, min(1024, int(self._active_pack.canvas_width * self._scale_preview))),
                     max(1, min(1024, int(self._active_pack.canvas_height * self._scale_preview))))

    def set_scale_preview(self, scale: float | None) -> None:
        """Resize decoded frames only; keep playback, prepared actions and saved scale intact."""
        if scale is not None and self._scale_preview_origin is None:
            self._scale_preview_origin = self.pos()
            self._finish_transition()
        self._scale_preview = max(0.1, min(2.0, float(scale))) if scale is not None else None
        if self._active_pack is not None:
            self._resize_pet(self._preview_size() or self._target_size(self._active_pack))
            if self._scale_preview_origin is not None:
                self.move(self._scale_preview_origin)
            self._keep_visible()
            self._display_png_frame()
        if scale is None:
            self._scale_preview_origin = None

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
        if abs(self._scale - previous_scale) > 0.001:
            self._scale_preview = None
            self._scale_preview_origin = None
        self._fps_cap = min((6, 12, 15, 24), key=lambda candidate: abs(candidate - int(fps_cap)))
        if locked or abs(self._scale - previous_scale) > 0.001:
            self._finish_drag(cancelled=True)
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
        if self.pointer_engaged:
            return
        row = placement if isinstance(placement, dict) else {}
        screen_name = str(row.get("screen") or "")
        screens = QApplication.screens()
        screen = next((item for item in screens if self._screen_key(item) == screen_name), None)
        # Existing settings contain the plain name. Keep accepting those while
        # new placements disambiguate identical monitor models.
        screen = screen or next((item for item in screens if item.name() == screen_name), None)
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
            "screen": self._screen_key(screen),
            "xRatio": max(0.0, min(1.0, (self.x() - area.left()) / span_x)),
            "yRatio": max(0.0, min(1.0, (self.y() - area.top()) / span_y)),
        }

    def _keep_visible(self, screen=None) -> None:
        if self.pointer_engaged:
            return
        screen = screen or QApplication.screenAt(self.frameGeometry().center())
        if screen is None:
            center = self.frameGeometry().center()
            screen = min(QApplication.screens(), key=lambda item: (
                max(item.geometry().left() - center.x(), 0, center.x() - item.geometry().right()) ** 2
                + max(item.geometry().top() - center.y(), 0, center.y() - item.geometry().bottom()) ** 2), default=None)
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
        if animation.state.name in {"move", "run"}:
            if cache_key not in self._prepared_gaits:
                self._prepared_gaits[cache_key] = self._prepare_locomotion_gait(self._active_pack, animation, frames)
            physical_gait = self._prepared_gaits[cache_key]
            ratio = max(.1, self.devicePixelRatioF())
            self._gait = physical_gait.scaled(1 / ratio, 1 / ratio) if physical_gait else None
        self._png_index = 0
        self._png_loop = animation.state.loop
        self._png_next_state = animation.state.next_state
        self._display_png_frame()
        if self._travel_kind not in {"move", "run"}:
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
            if not self._png_loop and self._travel_kind not in {"move", "run"}:
                self._png_timer.stop()
                self.animation_finished.emit(self._png_next_state)
                return
            next_index = 0
        self._png_index = next_index
        if self._png_frame_delays and self._active_animation and self._travel_kind not in {"move", "run"}:
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
        preview_size = self._preview_size()
        if preview_size is not None:
            frame = frame.scaled(preview_size, Qt.AspectRatioMode.KeepAspectRatio,
                                 Qt.TransformationMode.FastTransformation)
        horizontal_scale = self._facing_scale()
        rendered = frame.transformed(QTransform().scale(horizontal_scale, 1))
        rendered.setDevicePixelRatio(max(.1, self.devicePixelRatioF()))
        self._label.setPixmap(rendered)
        floor_offset = self._gait.floor_offsets[self._png_index] if self._travel_kind in {"move", "run"} and self._gait else 0
        self._label.move(0, round(floor_offset))
        if self._bubble.isVisible():
            self._place_bubble()

    def resizeEvent(self, event) -> None:
        self._label.setGeometry(self.rect())
        self._previous_frame.setGeometry(self.rect())
        self._travel_halo.setGeometry(self.rect())
        super().resizeEvent(event)

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._double_click_release = False
            if self._locked:
                event.accept()
                return
            self._finish_drag(cancelled=True)
            self.cancel_travel()
            self._drag_offset = event.position().toPoint()
            self._dragging = False
            self._drag_release_cursor = None
            self._drag_native = NativeDrag.for_window(int(self.winId()))
            sample = self._drag_native.sample() if self._drag_native else None
            if sample is None:
                self._drag_native = None
                point = event.globalPosition()
                sample = ((point.x(), point.y()), (self.x(), self.y(), self.width(), self.height()))
            self._drag_cursor = sample[0]
            self._drag_follow = DragFollow.begin(*sample)
            self._drag_last_tick = time.monotonic()
            self._release_trail = ReleaseTrail()
            self._release_trail.add(self._drag_last_tick, sample[0])
            self.grabMouse()
            self._drag_timer.start(16)
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if self._drag_offset is not None and event.buttons() & Qt.MouseButton.LeftButton:
            if self._drag_native:
                sample = self._drag_native.sample()
                cursor = sample[0] if sample else None
                threshold = QApplication.startDragDistance() * self.devicePixelRatioF()
            else:
                point = event.globalPosition()
                self._drag_cursor = (point.x(), point.y())
                cursor = self._drag_cursor
                threshold = QApplication.startDragDistance()
            if cursor is not None and self._drag_follow and self._drag_follow.distance(cursor) >= threshold:
                self._begin_drag()
            # The frame clock reads the latest cursor; event delivery is not a
            # movement clock and its global position changes basis across DPI.
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            if self._locked and not self.pointer_engaged and not self._double_click_release:
                self.clicked.emit()
            self._finish_drag()
            self._double_click_release = False
            event.accept()
            return
        elif event.button() == Qt.MouseButton.RightButton:
            self.context_menu_requested.emit(event.globalPosition().toPoint())
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._finish_drag(cancelled=True)
            self._double_click_release = True
            self.double_clicked.emit()
            event.accept()
            return
        super().mouseDoubleClickEvent(event)

    def closeEvent(self, event) -> None:
        self._pixel_size_timer.stop()
        self._finish_drag(cancelled=True)
        self.cancel_travel()
        self.stop_animation()
        self._bubble_timer.stop()
        self._bubble.close()
        super().closeEvent(event)

    def hideEvent(self, event) -> None:
        self._pixel_size_timer.stop()
        self._finish_drag(cancelled=True)
        self._double_click_release = False
        self._finish_transition()
        self._cancel_turn()
        self.hide_bubble()
        super().hideEvent(event)

    @staticmethod
    def _screen_key(screen) -> str:
        name = screen.name()
        if sum(item.name() == name for item in QApplication.screens()) < 2:
            return name[:200]
        geometry = screen.geometry()
        return f"{name[:160]} [{geometry.x()},{geometry.y()}]"


    def _begin_drag(self) -> None:
        if not self._dragging:
            self._dragging = True
            self.hide_bubble()
            self.drag_started.emit()


    def _advance_drag(self) -> None:
        if self._flight is not None:
            self._advance_flight()
            return
        if not self.pointer_engaged or self._drag_follow is None:
            return
        if self._drag_native:
            if self._drag_release_cursor is None and not self._drag_native.button_down():
                self._finish_drag()
                return
            sample = self._drag_native.sample()
            if sample is None:
                self._finish_drag(cancelled=True)
                return
            cursor, bounds = sample
            cursor = self._drag_release_cursor or cursor
            threshold = QApplication.startDragDistance() * self.devicePixelRatioF()
        else:
            if self._drag_release_cursor is None and not QApplication.mouseButtons() & Qt.MouseButton.LeftButton:
                self._finish_drag()
                return
            cursor, bounds = self._drag_release_cursor or self._drag_cursor, (self.x(), self.y(), self.width(), self.height())
            threshold = QApplication.startDragDistance()
        now = time.monotonic()
        elapsed = now - self._drag_last_tick
        self._drag_last_tick = now
        if self._drag_release_cursor is None:
            self._release_trail.add(now, cursor)
        if not self._dragging:
            if self._drag_follow.distance(cursor) < threshold:
                self._drag_timer.start(16)
                return
            self._begin_drag()
            if not self.pointer_engaged or self._drag_follow is None:
                return
        x, y = self._drag_follow.advance(cursor, bounds[2:], elapsed)
        if self._drag_native:
            if not self._drag_native.move(x, y):
                self._finish_drag(cancelled=True)
                return
        else:
            self.move(x, y)
        if self._drag_release_cursor is not None:
            error = math.hypot(self._drag_follow.x - (cursor[0] - self._drag_follow.anchor_x * bounds[2]),
                               self._drag_follow.y - (cursor[1] - self._drag_follow.anchor_y * bounds[3]))
            if error < 1 or now >= self._drag_release_until:
                self._finish_drag(settle=False)
                return
        self._drag_timer.start(16)


    def _finish_drag(self, *, cancelled: bool = False, settle: bool = True) -> None:
        if not self.pointer_engaged:
            return
        if self._flight is not None and not cancelled and settle:
            return
        was_flying = self._flight is not None
        if was_flying:
            qInfo("rabiroute.desktop-pet.motion " + ("desktop_pet_throw_cancelled" if cancelled else "desktop_pet_throw_landed"))
        was_dragging = self._dragging
        if not cancelled and was_dragging and settle:
            if self._drag_release_cursor is None:
                sample = self._drag_native.sample() if self._drag_native else None
                self._drag_release_cursor = sample[0] if sample else self._drag_cursor
                now = time.monotonic()
                self._release_trail.add(now, self._drag_release_cursor)
                bounds = sample[1] if sample else (self.x(), self.y(), self.width(), self.height())
                velocity = self._release_trail.velocity(now, max(.1, bounds[2] / 256))
                if velocity is not None:
                    self._flight = PetFlight(bounds[0], bounds[1], *velocity)
                    qInfo("rabiroute.desktop-pet.motion desktop_pet_throw_started")
                    self._drag_last_tick = now
                    if QWidget.mouseGrabber() is self:
                        self.releaseMouse()
                    self._drag_timer.start(16)
                    return
                self._drag_release_until = time.monotonic() + 0.18
                self._drag_drop_screen = QApplication.screenAt(QCursor.pos()) or self.screen()
                if QWidget.mouseGrabber() is self:
                    self.releaseMouse()
                self._drag_timer.start(16)
            return
        self._drag_timer.stop()
        self._flight = None
        self._release_trail.samples.clear()
        self._drag_offset = None
        self._dragging = False
        self._drag_native = None
        self._drag_follow = None
        drop_screen = self._drag_drop_screen
        self._drag_release_cursor = None
        self._drag_drop_screen = None
        if QWidget.mouseGrabber() is self:
            self.releaseMouse()
        if cancelled:
            if was_dragging:
                self.drag_finished.emit()
            return
        # Commit only at release, on the cursor's screen, rather than clamping
        # the straddling window back to the monitor containing its old center.
        if was_dragging:
            if not was_flying:
                self._keep_visible(drop_screen or QApplication.screenAt(QCursor.pos()) or self.screen())
            placement = self.placement()
            if placement is not None:
                self.placement_changed.emit(placement)
            self.drag_finished.emit()
        elif not self._double_click_release:
            self.clicked.emit()


    def _advance_flight(self) -> None:
        flight = self._flight
        if flight is None:
            return
        now = time.monotonic()
        if self._locked or not self.isVisible():
            self._finish_drag(cancelled=True)
            return
        if self._drag_native:
            sample = self._drag_native.sample()
            if sample is None:
                self._finish_drag(cancelled=True)
                return
            size = sample[1][2:]
            displays = self._drag_native.display_areas()
        else:
            size = (self.width(), self.height())
            def edges(rect):
                return rect.x(), rect.y(), rect.x() + rect.width(), rect.y() + rect.height()
            displays = [DisplayArea(edges(screen.geometry()), edges(screen.availableGeometry()))
                        for screen in QApplication.screens()]
        x, y = flight.advance(now - self._drag_last_tick, size, displays)
        self._drag_last_tick = now
        if self._drag_native:
            if not self._drag_native.move(x, y):
                self._finish_drag(cancelled=True)
                return
        else:
            self.move(x, y)
        if flight.at_rest:
            self._finish_drag(settle=False)
            return
        self._drag_timer.start(16)



    def _resize_pet(self, physical_size: QSize) -> None:
        """Keep decoded image pixels invariant while Qt UI stays DPI aware."""
        ratio = max(.1, self.devicePixelRatioF())
        native = self._drag_native or NativeDrag.for_window(int(self.winId()))
        sample = native.sample() if native else None
        self.resize(QSize(max(1, round(physical_size.width() / ratio)),
                          max(1, round(physical_size.height() / ratio))))
        if native:
            # Integer logical dimensions cannot represent e.g. 256/1.5 exactly.
            # Finish with an exact native size, retaining the physical origin.
            native.resize(physical_size.width(), physical_size.height())
            if sample:
                native.move(round(sample[1][0]), round(sample[1][1]))

    def _sync_pixel_size(self) -> None:
        if self._active_pack is None or not self.isVisible() or getattr(self, "_pixel_sync_active", False):
            return
        self._pixel_sync_active = True
        try:
            self._resize_pet(self._preview_size() or self._target_size(self._active_pack))
        finally:
            self._pixel_sync_active = False
        if self._active_animation and self._active_animation.state.name in {"move", "run"}:
            key = self._prepared_key(self._active_pack, self._active_animation, self._target_size(self._active_pack))
            gait = self._prepared_gaits.get(key)
            ratio = max(.1, self.devicePixelRatioF())
            self._gait = gait.scaled(1 / ratio, 1 / ratio) if gait else None
            if self._gait and self.travelling:
                cycle_ms = (sum(max(round(1000 / self._fps_cap), delay) for delay in self._png_frame_delays)
                            if self._png_frame_delays else len(self._png_frames) * self._frame_interval(self._active_animation.state.fps))
                self._walk_speed = self._gait.cycle_distance * 1000 / cycle_ms
        self._display_png_frame()

    def event(self, event) -> bool:
        result = super().event(event)
        if hasattr(self, "_pixel_size_timer"):
            if event.type() == QEvent.Type.DevicePixelRatioChange:
                # Apply before the first repaint at the new DPI, rather than
                # leaving a one-frame shrink/stretch until a queued timer runs.
                self._sync_pixel_size()
            elif event.type() == QEvent.Type.ScreenChangeInternal:
                self._pixel_size_timer.start(0)
        return result

    def nativeEvent(self, event_type, message):
        pack = getattr(self, "_active_pack", None)
        if pack is not None:
            size = self._preview_size() or self._target_size(pack)
            preserve_dpi_size(int(message), (size.width(), size.height()))
        return super().nativeEvent(event_type, message)
