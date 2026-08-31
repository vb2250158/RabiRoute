from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable

from PySide6.QtCore import QObject, QPoint, QTimer, Signal
from PySide6.QtWidgets import QApplication, QMenu

from .desktop_pet_client import DesktopPetBinding, DesktopPetClient, DesktopPetPack, LoadedDesktopPetAnimation
from .desktop_pet_events import DesktopPetEventStream
from .desktop_pet_fullscreen import is_foreground_fullscreen
from .desktop_pet_idle import DesktopPetIdleScheduler
from .desktop_pet_window import DesktopPetWindow
from .qt_async import QtAsyncTask, start_qt_task


DESKTOP_PET_STATE_LABELS = {
    "idle": "待机",
    "thinking": "思考",
    "talking": "说话",
    "success": "完成",
    "concerned": "担心",
    "attention": "回应",
    "sleep": "睡觉",
    "drag": "拖动",
    "idle-reading": "读书",
    "idle-wave": "挥手",
    "idle-pout": "噘嘴",
    "idle-cover-mouth": "捂嘴",
}

def desktop_pet_state_label(state_name: str) -> str:
    """Keep Manager state keys stable while giving common YeYu actions clear menu text."""
    return DESKTOP_PET_STATE_LABELS.get(state_name, state_name)


class DesktopPetController(QObject):
    visibility_changed = Signal(bool)
    click_through_changed = Signal(bool)

    def __init__(self, manager_url: str, persona_id: str, open_persona: Callable[[], None]) -> None:
        super().__init__()
        self.persona_id = persona_id
        self.window = DesktopPetWindow()
        self.window.clicked.connect(self._clicked)
        self.window.double_clicked.connect(self._double_clicked)
        self.window.animation_finished.connect(self._animation_finished)
        self.window.placement_changed.connect(lambda placement: self._persist({"placement": placement}))
        self.window.context_menu_requested.connect(self._show_context_menu)
        self.window.drag_started.connect(self._drag_started)
        self.window.drag_finished.connect(self._drag_finished)
        application = QApplication.instance()
        if application is not None:
            application.screenRemoved.connect(lambda _screen: self.window.recover_to_visible_screen())
        self._open_persona = open_persona
        self._client = DesktopPetClient(manager_url, persona_id)
        self._events = DesktopPetEventStream(manager_url)
        self._events.work_ended.connect(self._work_ended)
        self._events.settings_changed.connect(self._desktop_settings_changed)
        self._events.connection_changed.connect(self._event_connection_changed)
        self._events.start()
        self._pack: DesktopPetPack | None = None
        self._idle_scheduler = DesktopPetIdleScheduler(self)
        self._idle_scheduler.animation_requested.connect(self.set_state)
        self._catalog_task: QtAsyncTask | None = None
        self._animation_task: QtAsyncTask | None = None
        self._preload_task: QtAsyncTask | None = None
        self._binding_snapshot: DesktopPetBinding | None = None
        self._animation_cache: dict[str, LoadedDesktopPetAnimation] = {}
        self._preload_queue: deque[str] = deque()
        self._requested_state = "idle"
        self._state_before_drag = "idle"
        self._click_through = False
        self._preferred_pack_id = ""
        self._binding_task: QtAsyncTask | None = None
        self._settings_task: QtAsyncTask | None = None
        self._pending_settings_patch: dict[str, object] = {}
        self._hide_on_fullscreen = True
        self._scale = 0.5
        self._opacity = 1.0
        self._always_on_top = True
        self._locked = False
        self._bubble_enabled = True
        self._fps_cap = 15
        self._context_menu: QMenu | None = None
        self._muted_until = 0.0
        self._hidden_for_fullscreen = False
        self._fullscreen_timer = QTimer(self)
        self._fullscreen_timer.setSingleShot(True)
        self._fullscreen_timer.timeout.connect(self._reconcile_fullscreen_visibility)
        self._fullscreen_timer.start(1500)
        self._load_binding()

    @property
    def visible(self) -> bool:
        return self.window.isVisible()

    def toggle(self) -> None:
        if self.visible:
            self.hide()
        else:
            self.show()

    def show(self) -> None:
        self._hidden_for_fullscreen = False
        self.window.show_on_desktop()
        self._idle_scheduler.set_active(True)
        self._idle_scheduler.note_activity()
        self.visibility_changed.emit(True)
        if self._pack is None:
            self._load_catalog()
        else:
            self.set_state(self._requested_state)
            self._enqueue_animation_preloads()
        self._persist({"enabled": True})

    def hide(self) -> None:
        self._hidden_for_fullscreen = False
        self._idle_scheduler.set_active(False)
        self.window.hide()
        self.window.stop_animation()
        self.visibility_changed.emit(False)
        self._persist({"enabled": False})

    def set_click_through(self, enabled: bool) -> None:
        self._click_through = bool(enabled)
        self.window.set_click_through(self._click_through)
        self.click_through_changed.emit(self._click_through)
        self._persist({"clickThrough": self._click_through})

    def close(self) -> None:
        self._fullscreen_timer.stop()
        self._idle_scheduler.stop()
        self._events.stop()
        self._preload_queue.clear()
        self._animation_cache.clear()
        self.window.close()

    def set_state(self, state_name: str) -> None:
        self._requested_state = state_name or "idle"
        self._idle_scheduler.state_requested(self._requested_state)
        if self._pack is None or not self.visible:
            return
        requested = self._requested_state if self._requested_state in self._pack.states else "idle"
        cached_animation = self._animation_cache.get(requested)
        if cached_animation is not None:
            self.window.prepare_animation(self._pack, cached_animation)
            self.window.play(self._pack, cached_animation)
            self._idle_scheduler.state_started(cached_animation.state.name)
            return
        if self._animation_task is not None:
            return

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._animation_task is not task:
                return
            self._animation_task = None
            if not self.visible:
                return
            if isinstance(result, LoadedDesktopPetAnimation) and self._pack is not None:
                pending_state = self._requested_state if self._requested_state in self._pack.states else "idle"
                if pending_state != result.state.name:
                    self.set_state(pending_state)
                    return
                self._cache_animation(result)
                self.window.play(self._pack, result)
                self._idle_scheduler.state_started(result.state.name)
                self._enqueue_animation_preloads()
            else:
                self.window.show_placeholder("夜雨\n素材暂不可用")

        self._animation_task = start_qt_task(
            lambda: self._client.load_animation(self._pack, requested, max_concurrency=4),
            completed,
            on_error=lambda error: error,
        )

    def _load_catalog(self) -> None:
        if self._catalog_task is not None:
            return
        self.window.show_placeholder("夜雨\n正在找动作包")

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._catalog_task is not task:
                return
            self._catalog_task = None
            if not self.visible:
                return
            packs = result if isinstance(result, tuple) else ()
            self._pack = next((pack for pack in packs if pack.pack_id == self._preferred_pack_id), None)
            self._pack = self._pack or next((pack for pack in packs if pack.pack_id == "yeyu-library-default"), None)
            if self._pack is None and packs:
                self._pack = packs[0]
            if self._pack is None:
                self.window.show_placeholder("夜雨\n素材准备中")
                return
            self._animation_cache.clear()
            self._preload_queue.clear()
            self.window.clear_prepared_animations()
            self._idle_scheduler.configure(self._pack.idle_behavior)
            self.set_state(self._requested_state)

        self._catalog_task = start_qt_task(self._client.packs, completed, on_error=lambda error: error)

    def _animation_finished(self, next_state: str) -> None:
        self.set_state(next_state or "idle")

    def _clicked(self) -> None:
        if self.visible:
            self._idle_scheduler.note_activity()
            self.set_state("attention")

    def _double_clicked(self) -> None:
        self._idle_scheduler.note_activity()
        self._open_persona()

    def _drag_started(self) -> None:
        if not self.visible:
            return
        self._idle_scheduler.note_activity()
        self._state_before_drag = self._requested_state or "idle"
        self.set_state("drag")

    def _drag_finished(self) -> None:
        if not self.visible:
            return
        next_state = self._state_before_drag if self._state_before_drag != "drag" else "idle"
        self._state_before_drag = "idle"
        self.set_state(next_state)

    def _load_binding(self) -> None:
        if self._binding_task is not None:
            return

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._binding_task is not task:
                return
            self._binding_task = None
            if not isinstance(result, DesktopPetBinding):
                return
            self._apply_binding(result)

        self._binding_task = start_qt_task(self._client.binding, completed, on_error=lambda error: error)

    def _apply_binding(self, binding: DesktopPetBinding) -> None:
        """Refresh the Manager-owned binding without changing pointer interaction."""
        previous = self._binding_snapshot
        if previous == binding:
            return
        pack_changed = previous is not None and previous.pack_id != binding.pack_id
        self._binding_snapshot = binding
        self._preferred_pack_id = binding.pack_id
        self._hide_on_fullscreen = binding.hide_on_fullscreen
        self._click_through = binding.click_through
        self._scale = binding.scale
        self._opacity = binding.opacity
        self._always_on_top = binding.always_on_top
        self._locked = binding.locked
        self._bubble_enabled = binding.bubble_enabled
        self._fps_cap = binding.fps_cap
        self.window.apply_presentation_settings(
            scale=binding.scale,
            opacity=binding.opacity,
            always_on_top=binding.always_on_top,
            locked=binding.locked,
            bubble_enabled=binding.bubble_enabled,
            fps_cap=binding.fps_cap,
        )
        if binding.placement:
            self.window.restore_placement(binding.placement)
        self.window.set_click_through(binding.click_through)
        self.click_through_changed.emit(binding.click_through)

        if not binding.enabled:
            if self.visible:
                self._idle_scheduler.set_active(False)
                self.window.stop_animation()
                self.window.hide()
                self.visibility_changed.emit(False)
            return

        if not self.visible:
            self.window.show_on_desktop()
            self._idle_scheduler.set_active(True)
            self._idle_scheduler.note_activity()
            self.visibility_changed.emit(True)
            self._load_catalog()
            return

        if pack_changed:
            self._pack = None
            self._animation_cache.clear()
            self._preload_queue.clear()
            self.window.clear_prepared_animations()
            self._load_catalog()

    def _persist(self, patch: dict[str, object]) -> None:
        self._pending_settings_patch.update(patch)
        if self._settings_task is not None:
            return
        outgoing = self._pending_settings_patch
        self._pending_settings_patch = {}

        def completed(task: QtAsyncTask, _result: object) -> None:
            if self._settings_task is task:
                self._settings_task = None
                if self._pending_settings_patch:
                    self._persist({})

        self._settings_task = start_qt_task(
            lambda: self._client.update_binding(outgoing),
            completed,
            on_error=lambda error: error,
        )

    def _work_ended(self, payload: object) -> None:
        event = payload if isinstance(payload, dict) else {}
        if str(event.get("personaId") or "") != self.persona_id:
            return
        if not self.visible or time.monotonic() < self._muted_until:
            return
        self._idle_scheduler.note_activity()
        status = str(event.get("status") or "")
        self.set_state("success" if status == "completed" else "concerned")
        summary = str(event.get("summary") or "").strip()
        if summary:
            self.window.show_bubble(summary)

    def _event_connection_changed(self, connected: bool) -> None:
        if connected:
            self._load_binding()
            if self.visible and self._requested_state == "concerned":
                self.set_state("idle")
            return
        if self.visible and time.monotonic() >= self._muted_until:
            self.set_state("concerned")
            self.window.show_bubble("Rabi Manager 连接暂时中断")

    def _desktop_settings_changed(self, payload: object) -> None:
        event = payload if isinstance(payload, dict) else {}
        event_persona_id = str(event.get("personaId") or "")
        if event_persona_id and event_persona_id != self.persona_id:
            return
        self._load_binding()

    def _reconcile_fullscreen_visibility(self) -> None:
        self._fullscreen_timer.start(1500)
        fullscreen = self._hide_on_fullscreen and is_foreground_fullscreen()
        if fullscreen and self.visible:
            self._hidden_for_fullscreen = True
            self._idle_scheduler.set_active(False)
            self.window.hide_bubble()
            self.window.hide()
            self.window.stop_animation()
            return
        if not fullscreen and self._hidden_for_fullscreen:
            self._hidden_for_fullscreen = False
            self.window.show_on_desktop()
            self._idle_scheduler.set_active(True)
            self.set_state(self._requested_state)

    def _show_context_menu(self, position: object) -> None:
        self._idle_scheduler.note_activity()
        point = position if isinstance(position, QPoint) else self.window.mapToGlobal(self.window.rect().center())
        menu = QMenu(self.window)
        menu.addAction(f"打开 {self.persona_id} 人格面板", self._open_persona)
        menu.addAction("安静一小时", self._mute_for_one_hour)
        menu.addSeparator()
        click_through = menu.addAction("鼠标点透")
        click_through.setCheckable(True)
        click_through.setChecked(self._click_through)
        click_through.toggled.connect(self.set_click_through)
        locked = menu.addAction("锁定位置")
        locked.setCheckable(True)
        locked.setChecked(self._locked)
        locked.toggled.connect(self._set_locked)
        always_on_top = menu.addAction("总在最前")
        always_on_top.setCheckable(True)
        always_on_top.setChecked(self._always_on_top)
        always_on_top.toggled.connect(self._set_always_on_top)
        bubble = menu.addAction("显示结果气泡")
        bubble.setCheckable(True)
        bubble.setChecked(self._bubble_enabled)
        bubble.toggled.connect(self._set_bubble_enabled)
        scale_menu = menu.addMenu("大小")
        for label, scale in (("50%", 0.5), ("75%", 0.75), ("100%", 1.0), ("125%", 1.25)):
            action = scale_menu.addAction(label)
            action.setCheckable(True)
            action.setChecked(abs(self._scale - scale) < 0.01)
            action.triggered.connect(lambda _checked=False, value=scale: self._set_scale(value))
        action_menu = menu.addMenu("播放动作")
        menu._desktop_pet_action_menu = action_menu
        if self._pack is None:
            action_menu.addAction("动作正在加载…").setEnabled(False)
        else:
            ready_count = sum(self._is_action_ready(state_name) for state_name in self._pack.states)
            if ready_count < len(self._pack.states):
                action_menu.addAction(f"正在预载动作（{ready_count}/{len(self._pack.states)}）").setEnabled(False)
                action_menu.addSeparator()
            for state_name in self._pack.states:
                ready = self._is_action_ready(state_name)
                label = desktop_pet_state_label(state_name)
                action = action_menu.addAction(label if ready else f"{label}（准备中）")
                action.setCheckable(True)
                action.setChecked(state_name == self._requested_state)
                action.setEnabled(ready)
                action.triggered.connect(
                    lambda _checked=False, value=state_name: self._play_manual_action(value)
                )
        if self._pack is not None:
            menu.addSeparator()
            menu.addAction(f"当前动作包：{self._pack.name}").setEnabled(False)
        menu.addSeparator()
        menu.addAction("隐藏桌宠", self.hide)
        self._context_menu = menu
        menu.aboutToHide.connect(lambda: setattr(self, "_context_menu", None))
        menu.popup(point)

    def _apply_presentation(self) -> None:
        self.window.apply_presentation_settings(
            scale=self._scale,
            opacity=self._opacity,
            always_on_top=self._always_on_top,
            locked=self._locked,
            bubble_enabled=self._bubble_enabled,
            fps_cap=self._fps_cap,
        )

    def _set_locked(self, enabled: bool) -> None:
        self._locked = bool(enabled)
        self._apply_presentation()
        self._persist({"locked": self._locked})

    def _set_always_on_top(self, enabled: bool) -> None:
        self._always_on_top = bool(enabled)
        self._apply_presentation()
        self._persist({"alwaysOnTop": self._always_on_top})

    def _set_bubble_enabled(self, enabled: bool) -> None:
        self._bubble_enabled = bool(enabled)
        self._apply_presentation()
        if not self._bubble_enabled:
            self.window.hide_bubble()
        self._persist({"bubbleEnabled": self._bubble_enabled})

    def _set_scale(self, scale: float) -> None:
        self._scale = scale
        self._apply_presentation()
        self._enqueue_animation_preloads()
        self._persist({"scale": scale})

    def _play_manual_action(self, state_name: str) -> None:
        if not self._is_action_ready(state_name):
            return
        self._idle_scheduler.note_activity()
        self.set_state(state_name)

    def _is_action_ready(self, state_name: str) -> bool:
        if self._pack is None:
            return False
        animation = self._animation_cache.get(state_name)
        return animation is not None and self.window.is_animation_prepared(self._pack, animation)

    def _cache_animation(self, animation: LoadedDesktopPetAnimation) -> None:
        if self._pack is None or animation.state.name not in self._pack.states:
            return
        if self.window.prepare_animation(self._pack, animation):
            self._animation_cache[animation.state.name] = animation

    def _enqueue_animation_preloads(self) -> None:
        if self._pack is None or not self.visible:
            return
        queued = set(self._preload_queue)
        interaction_states = [
            state_name
            for state_name in ("attention", "drag")
            if state_name in self._pack.states
        ]
        one_shot_states = [
            state_name
            for state_name, state in self._pack.states.items()
            if state_name != "idle" and state_name not in interaction_states and not state.loop
        ]
        looping_states = [
            state_name
            for state_name, state in self._pack.states.items()
            if state_name != "idle" and state_name not in interaction_states and state.loop
        ]
        for state_name in interaction_states + one_shot_states + looping_states:
            if not self._is_action_ready(state_name) and state_name not in queued:
                self._preload_queue.append(state_name)
        self._start_next_animation_preload()

    def _start_next_animation_preload(self) -> None:
        if self._preload_task is not None or self._pack is None or not self.visible:
            return
        while self._preload_queue:
            state_name = self._preload_queue.popleft()
            if self._is_action_ready(state_name):
                continue
            cached_animation = self._animation_cache.get(state_name)
            if cached_animation is not None:
                self.window.prepare_animation(self._pack, cached_animation)
                QTimer.singleShot(0, self._start_next_animation_preload)
                return
            pack = self._pack

            def completed(task: QtAsyncTask, result: object, *, requested_state=state_name, requested_pack=pack) -> None:
                if self._preload_task is not task:
                    return
                self._preload_task = None
                if self._pack is requested_pack and isinstance(result, LoadedDesktopPetAnimation):
                    if result.state.name == requested_state:
                        self._cache_animation(result)
                self._start_next_animation_preload()

            self._preload_task = start_qt_task(
                lambda: self._client.load_animation(pack, state_name, max_concurrency=4),
                completed,
                on_error=lambda error: error,
            )
            return

    def _mute_for_one_hour(self) -> None:
        self._muted_until = time.monotonic() + 60 * 60
        self.window.hide_bubble()
        self.set_state("sleep")
