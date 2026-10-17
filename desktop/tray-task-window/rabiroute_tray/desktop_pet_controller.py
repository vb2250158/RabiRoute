from __future__ import annotations

import time
import math
import random
import logging
from collections import deque
from collections.abc import Callable

from PySide6.QtCore import QObject, QPoint, Qt, QTimer, Signal
from PySide6.QtWidgets import QApplication, QLabel, QMenu, QSlider, QVBoxLayout, QWidget, QWidgetAction

from .desktop_pet_client import DesktopPetBinding, DesktopPetClient, DesktopPetIdleBehavior, DesktopPetModeAnimationSet, DesktopPetPack, LoadedDesktopPetAnimation
from .desktop_pet_events import DesktopPetEventStream
from .desktop_pet_companion import DesktopPetCompanion
from .desktop_pet_speech import DesktopPetSpeech
from .desktop_pet_dialogue import DesktopPetDialogue
from .desktop_pet_bubble_settings import DesktopPetBubbleSettings
from .desktop_pet_fullscreen import is_foreground_fullscreen
from .desktop_pet_idle import DesktopPetIdleScheduler
from .desktop_pet_motion import corner_positions, foreground_window, logical_bounds, matches_monitor, travel_kind
from .desktop_pet_window import DesktopPetWindow
from .desktop_pet_agent_motion import DesktopPetAgentMotion
from .qt_async import QtAsyncTask, start_qt_task

_LOGGER = logging.getLogger(__name__)


DESKTOP_PET_STATE_LABELS = {
    "idle": "待机",
    "thinking": "思考",
    "talking": "说话",
    "success": "完成",
    "concerned": "担心",
    "attention": "回应",
    "sleep": "睡觉",
    "drag": "拖动",
    "lift": "提起",
    "throw": "抛出",
    "airborne": "空中待机",
    "move": "走路",
    "run": "奔跑",
    "teleport-out": "传送离开",
    "teleport-in": "传送抵达",
    "idle-reading": "读书",
    "idle-wave": "挥手",
    "idle-pout": "噘嘴",
    "idle-cover-mouth": "捂嘴",
    "companion-watch": "陪你看视频",
    "companion-play": "陪你玩游戏",
    "companion-work": "陪你工作",
}

def desktop_pet_state_label(state_name: str) -> str:
    """Keep Manager state keys stable while giving common actions clear menu text."""
    return DESKTOP_PET_STATE_LABELS.get(state_name, state_name)


class DesktopPetController(QObject):
    visibility_changed = Signal(bool)
    click_through_changed = Signal(bool)

    def __init__(
        self,
        manager_url: str,
        persona_id: str,
        open_persona: Callable[[str], None],
        *,
        persona_name: str | None = None,
        initial_binding: DesktopPetBinding | None = None,
        event_stream: DesktopPetEventStream | None = None,
        speech_event_stream: DesktopPetEventStream | None = None,
        default_slot: int = 0,
    ) -> None:
        super().__init__()
        self.persona_id = persona_id
        self.persona_name = str(persona_name or persona_id)
        self.window = DesktopPetWindow(self.persona_name, default_slot)
        self.window.clicked.connect(self._clicked)
        self.window.double_clicked.connect(self._double_clicked)
        self.window.animation_finished.connect(self._animation_finished)
        self.window.placement_changed.connect(lambda placement: self._persist({"placement": placement}))
        self.window.context_menu_requested.connect(self._show_context_menu)
        self.window.drag_started.connect(self._drag_started)
        self.window.flight_started.connect(self._throw_started)
        self.window.drag_finished.connect(self._drag_finished)
        self.window.travel_phase_changed.connect(self._travel_phase_changed)
        self.window.travel_result.connect(self._travel_finished)
        self._application = QApplication.instance()
        if self._application is not None:
            self._application.screenRemoved.connect(self._screen_removed)
        self._open_persona = open_persona
        self._client = DesktopPetClient(manager_url, persona_id)
        self._dialogue = DesktopPetDialogue()
        self._dialogue_task: QtAsyncTask | None = None
        self._dialogue_reload_pending = False
        self._events = event_stream or DesktopPetEventStream(manager_url)
        self._speech_events = speech_event_stream or DesktopPetEventStream(manager_url, path="/api/speech/events")
        self._owns_speech_events = speech_event_stream is None
        self._speech_job: dict = {}
        self._speech = DesktopPetSpeech(manager_url, persona_id, self._speech_events, self)
        self._speech.changed.connect(self._speech_changed)
        self._owns_events = event_stream is None
        self._events.work_ended.connect(self._work_ended)
        self._companion_session: dict = {}
        self._companion = DesktopPetCompanion(manager_url, persona_id, self)
        self._companion.changed.connect(self._companion_changed)
        self._companion.failed.connect(lambda message: self.window.show_bubble(self._dialogue.line("fallbacks", "companionFailed")))
        self._events.companion_changed.connect(self._companion_changed)
        self._events.companion_reaction.connect(self._companion_reaction)
        self._events.connection_changed.connect(self._event_connection_changed)
        if self._owns_events:
            self._events.settings_changed.connect(self._desktop_settings_changed)
            self._events.start()
        self._agent_motion = DesktopPetAgentMotion(self, manager_url, self._events)
        self._pack: DesktopPetPack | None = None
        self._idle_scheduler = DesktopPetIdleScheduler(self)
        self._idle_scheduler.animation_requested.connect(self._idle_action)
        self._idle_behavior_snapshot: DesktopPetIdleBehavior | None = None
        self._last_click_state = ""
        self._catalog_task: QtAsyncTask | None = None
        self._animation_task: QtAsyncTask | None = None
        self._preload_task: QtAsyncTask | None = None
        self._binding_snapshot: DesktopPetBinding | None = None
        self._animation_cache: dict[str, LoadedDesktopPetAnimation] = {}
        self._preload_queue: deque[str] = deque()
        self._requested_state = "idle"
        self._animation_retry_delay = 1500
        self._animation_retry_timer = QTimer(self)
        self._animation_retry_timer.setSingleShot(True)
        self._animation_retry_timer.timeout.connect(self._resume_context)
        self._state_before_drag = "idle"
        self._state_before_travel = "idle"
        self._transient_state = ""
        self._reaction_timer = QTimer(self)
        self._reaction_timer.setSingleShot(True)
        self._reaction_timer.timeout.connect(self._resume_context)
        self._closed = False
        self._manual_pause_until = 0.0
        self._wander_unavailable_action: tuple[str, str] | None = None
        self._random = random.Random()
        self._wander_timer = QTimer(self)
        self._wander_timer.setSingleShot(True)
        self._wander_timer.timeout.connect(self._attempt_wander)
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
        if initial_binding is None:
            self._load_binding()
        else:
            self._apply_binding(initial_binding)
        if self._owns_speech_events:
            self._speech_events.start()
        self._speech.reconnect()
        self._load_dialogue()
        # Shared streams may already be connected before the roster creates this controller.
        self._companion.reconnect()

    @property
    def visible(self) -> bool:
        return self.window.isVisible()

    def toggle(self) -> None:
        if self.visible:
            self.hide()
        else:
            self.show()

    def show(self) -> None:
        if not self._preferred_pack_id:
            return
        self._hidden_for_fullscreen = False
        self.window.show_on_desktop()
        self._configure_idle_scheduler()
        self._idle_scheduler.note_activity()
        self.visibility_changed.emit(True)
        if self._pack is None:
            self._load_catalog()
        else:
            self._resume_context(self._requested_state)
            self._enqueue_animation_preloads()
        self._persist({"enabled": True})
        self._arm_wander()

    def hide(self) -> None:
        self._reaction_timer.stop()
        self._transient_state = ""
        self._companion.pause()
        self._hidden_for_fullscreen = False
        self._idle_scheduler.set_active(False)
        self.window.cancel_travel()
        self._wander_timer.stop()
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
        self._closed = True
        self._animation_retry_timer.stop()
        self._reaction_timer.stop()
        self._companion.close()
        self._speech.close()
        if self._owns_speech_events:
            self._speech_events.stop()
        self._agent_motion.close()
        self._wander_timer.stop()
        self._fullscreen_timer.stop()
        self._idle_scheduler.stop()
        if self._application is not None:
            self._application.screenRemoved.disconnect(self._screen_removed)
        if self._owns_events:
            self._events.stop()
        else:
            self._events.work_ended.disconnect(self._work_ended)
            self._events.connection_changed.disconnect(self._event_connection_changed)
        self._preload_queue.clear()
        self._animation_cache.clear()
        self.window.close()

    def _screen_removed(self, _screen: object) -> None:
        self.window.cancel_travel()
        self.window.recover_to_visible_screen()

    def update_persona(self, persona_name: str, binding: DesktopPetBinding) -> None:
        self.persona_name = str(persona_name or self.persona_id)
        self.window.set_persona_name(self.persona_name)
        self._apply_binding(binding)

    def set_state(self, state_name: str, *, restart: bool = False) -> None:
        if self._closed:
            return
        self._animation_retry_timer.stop()
        state_name = state_name or "idle"
        if (not restart and self.window.is_playing(self._pack, state_name)
                and self._requested_state == state_name and self.window.animation_running):
            return
        if self.window.travelling and state_name not in {"move", "run", "teleport-out", "teleport-in"}:
            self.window.cancel_travel()
        self._requested_state = state_name or "idle"
        self._idle_scheduler.state_requested(self._requested_state)
        if self._pack is None or not self.visible:
            return
        requested = self._requested_state if self._requested_state in self._pack.states else "idle"
        cached_animation = self._animation_cache.get(requested)
        if cached_animation is not None:
            if self.window.play(self._pack, cached_animation) is not False:
                self._animation_retry_delay = 1500
                self._idle_scheduler.state_started(cached_animation.state.name)
            else:
                self._animation_unavailable()
            return
        if self._animation_task is not None:
            return
        requested_pack = self._pack

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._animation_task is not task:
                return
            self._animation_task = None
            if self._closed or not self.visible:
                return
            if self._pack is not requested_pack:
                self.set_state(self._requested_state)
                return
            pending_state = self._requested_state if self._requested_state in self._pack.states else "idle"
            if pending_state != requested:
                self.set_state(pending_state)
                return
            if isinstance(result, LoadedDesktopPetAnimation) and self._pack is not None:
                pending_state = self._requested_state if self._requested_state in self._pack.states else "idle"
                if pending_state != result.state.name:
                    self.set_state(pending_state)
                    return
                self._cache_animation(result)
                if self.window.play(self._pack, result) is not False:
                    self._animation_retry_delay = 1500
                    self._idle_scheduler.state_started(result.state.name)
                else:
                    self._animation_unavailable()
                self._enqueue_animation_preloads()
            else:
                self._animation_unavailable()

        self._animation_task = start_qt_task(
            lambda: self._client.load_animation(requested_pack, requested, max_concurrency=4),
            completed,
            on_error=lambda error: error,
        )

    def _load_catalog(self) -> None:
        if self._catalog_task is not None:
            return
        self.window.cancel_travel()
        self.window.show_placeholder(f"{self.persona_name}\n正在找动作包")

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._catalog_task is not task:
                return
            self._catalog_task = None
            if not self.visible:
                return
            packs = result if isinstance(result, tuple) else ()
            self._pack = next((pack for pack in packs if pack.pack_id == self._preferred_pack_id), None)
            if self._pack is None:
                self.window.show_placeholder(f"{self.persona_name}\n已选动作包不可用")
                return
            self._animation_cache.clear()
            self._preload_queue.clear()
            self.window.clear_prepared_animations()
            self._idle_behavior_snapshot = None
            self._configure_idle_scheduler()
            self._resume_context(self._requested_state)
            self._agent_motion.drain()

        self._catalog_task = start_qt_task(self._client.packs, completed, on_error=lambda error: error)

    def _animation_unavailable(self) -> None:
        self._reaction_timer.stop()
        self._transient_state = ""
        scene = self._companion_state()
        if scene and self.visible:
            self._requested_state = scene
            self._animation_retry_timer.start(self._animation_retry_delay)
            self._animation_retry_delay = min(30000, self._animation_retry_delay * 2)
            return
        if self.window.active_state:
            self._requested_state = self.window.active_state
            self._idle_scheduler.state_started(self._requested_state)
            self.window.show_bubble(self._dialogue.line("fallbacks", "actionUnavailable"))
        else:
            self.window.show_placeholder(f"{self.persona_name}\n素材暂不可用")

    def _passive_action_blocked(self) -> bool:
        return bool(self.window.travelling or self.window.pointer_engaged or self._context_menu
                    or self._transient_state or self._speech_job.get("status") == "playing")

    def _idle_action(self, state: str) -> None:
        group = self._companion_animation_set()
        mode_random = group is not None and state in group.random_states
        if (not self._companion_session or mode_random) and not self._passive_action_blocked():
            self.set_state(state)
        else:
            self._idle_scheduler.action_deferred(self.window.active_state or "idle")

    def _configured_mode_animation_set(self) -> DesktopPetModeAnimationSet | None:
        if not self._pack or self._companion_session.get("status") != "active":
            return None
        kind = self._companion_session.get("activityKind")
        for key in (self._companion_session.get("presetId"), kind):
            group = self._pack.mode_animation_sets.get(key)
            if group is not None:
                return group
        return None

    def _companion_animation_set(self) -> DesktopPetModeAnimationSet | None:
        group = self._configured_mode_animation_set()
        if group is not None:
            return group
        if not self._pack or self._companion_session.get("status") != "active":
            return None
        kind = self._companion_session.get("activityKind")
        # Legacy packs expose only a looping scene. New authoring uses
        # modeAnimationSets; legacy entries never inherit the ordinary idle pool.
        state = self._pack.companion_states.get(kind, "")
        action = self._pack.states.get(state)
        if action and action.loop:
            return DesktopPetModeAnimationSet(state)
        if kind == "work":
            state = next((candidate for candidate in ("thinking", "idle")
                          if candidate in self._pack.states and self._pack.states[candidate].loop), "")
            if state:
                return DesktopPetModeAnimationSet(state)
        return None

    def _companion_state(self) -> str:
        group = self._companion_animation_set()
        return group.idle_state if group else ""

    def _configure_idle_scheduler(self) -> None:
        group = self._companion_animation_set()
        behavior = group.idle_behavior() if group else self._pack.idle_behavior if self._pack else DesktopPetIdleBehavior()
        if self._idle_behavior_snapshot != behavior:
            self._idle_scheduler.set_active(False)
            self._idle_scheduler.configure(behavior)
            self._idle_behavior_snapshot = behavior
        self._idle_scheduler.set_active(self.visible and (not self._companion_session or bool(group and group.random_states)))

    def _mode_action_showing(self) -> bool:
        group = self._companion_animation_set()
        return bool(group and self.window.active_state in (group.idle_state, *group.random_states, *group.click_states))

    def _request_reaction(self, state: str, *, duration_ms: int = 30000, restart: bool = False) -> None:
        # Keep only the currently shown reaction. Missed passive events are not queued.
        self._transient_state = state
        self._reaction_timer.start(max(1, duration_ms))
        if restart:
            self.set_state(state, restart=True)
        else:
            self.set_state(state)

    def _resume_context(self, fallback: str = "idle") -> None:
        self._reaction_timer.stop()
        self._transient_state = ""
        scene = self._companion_state()
        if scene:
            self.set_state(scene)
        elif self._speech_job.get("status") == "playing" and time.monotonic() >= self._muted_until:
            self.set_state("talking")
        else:
            mode_idles = {group.idle_state for group in self._pack.mode_animation_sets.values()} if self._pack else set()
            if self._pack and (fallback in self._pack.companion_states.values() or fallback in mode_idles):
                fallback = "idle"
            self.set_state(fallback if fallback not in {"talking", "drag", "lift", "throw", "airborne", "move", "run", "teleport-out", "teleport-in"} else "idle")

    def _animation_finished(self, next_state: str) -> None:
        if self.window.travelling or not self.window.is_playing(self._pack, self._requested_state):
            return
        if self.window.pointer_engaged:
            if self.window.airborne and self._requested_state == "throw":
                self.set_state("airborne" if self._pack and "airborne" in self._pack.states else "drag")
            elif not self.window.airborne and self._requested_state == "lift":
                self.set_state("drag")
            return
        self._resume_context(next_state or "idle")

    def _speech_changed(self, payload: object) -> None:
        job = payload if isinstance(payload, dict) else {}
        was_playing = self._speech_job.get("status") == "playing"
        self._speech_job = job
        if not self.visible or time.monotonic() < self._muted_until:
            if not job or job.get("status") != "playing":
                self.window.finish_speech_bubble()
            return
        playing = job.get("status") == "playing"
        if playing:
            self._wander_timer.stop()
            if self.window.travelling and not self._agent_motion.command:
                self.window.cancel_travel()
            if not was_playing:
                self._idle_scheduler.note_activity()
            if not self.window.travelling and not self.window.pointer_engaged and not self._transient_state and not self._mode_action_showing():
                self.set_state(self._companion_state() or "talking")
        elif was_playing:
            if self._requested_state == "talking":
                self._resume_context()
            self._arm_wander()
        if job.get("text"):
            self.window.show_speech_bubble(str(job["text"]), playing=playing)
        elif was_playing:
            self.window.finish_speech_bubble()

    def _clicked(self) -> None:
        if self.visible:
            self.window.cancel_travel()
            self._manual_pause_until = time.monotonic() + 30
            self._idle_scheduler.note_activity()
            group = self._companion_animation_set()
            choices = group.click_states if self._configured_mode_animation_set() else ("attention",)
            if choices:
                fresh = [state for state in choices if state != self._last_click_state]
                state = self._random.choice(fresh or list(choices))
                self._last_click_state = state
            else:
                state = group.idle_state
            self._request_reaction(state, restart=True)

    def _double_clicked(self) -> None:
        self._idle_scheduler.note_activity()
        self._open_current_persona()

    def _open_current_persona(self) -> None:
        self._open_persona(self.persona_id)

    def _drag_started(self) -> None:
        if not self.visible:
            return
        self._idle_scheduler.note_activity()
        self.window.cancel_travel()
        self._state_before_drag = "idle" if self._transient_state else self._requested_state or "idle"
        self._reaction_timer.stop()
        self._transient_state = "drag"
        self.set_state("lift" if self._pack and "lift" in self._pack.states else "drag")

    def _throw_started(self) -> None:
        if not self.visible or self._pack is None:
            return
        state = next((name for name in ("throw", "airborne", "drag") if name in self._pack.states), "idle")
        self._transient_state = state
        self.set_state(state)

    def _drag_finished(self) -> None:
        if not self.visible:
            return
        next_state = self._state_before_drag if self._state_before_drag != "drag" else "idle"
        self._state_before_drag = "idle"
        self._manual_pause_until = time.monotonic() + 30
        previous = self._pack.states.get(next_state) if self._pack else None
        self._resume_context(next_state if previous and previous.loop else "idle")

    def _load_dialogue(self) -> None:
        if self._closed:
            return
        self._dialogue = DesktopPetDialogue()
        if self._dialogue_task is not None:
            self._dialogue_reload_pending = True
            return
        self._dialogue_reload_pending = False

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._dialogue_task is not task:
                return
            self._dialogue_task = None
            if self._dialogue_reload_pending:
                self._load_dialogue()
                return
            if not self._closed and isinstance(result, DesktopPetDialogue):
                self._dialogue = result

        self._dialogue_task = start_qt_task(self._client.dialogue, completed, on_error=lambda error: error)

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

    def _apply_binding(self, binding: DesktopPetBinding, *, force: bool = False) -> None:
        """Refresh the Manager-owned binding without changing pointer interaction."""
        previous = self._binding_snapshot
        if not force and previous == binding and (binding.enabled and binding.pack_id or not self.visible):
            return
        pack_changed = previous is not None and previous.pack_id != binding.pack_id
        self._binding_snapshot = binding
        if pack_changed:
            self.window.cancel_travel()
            # In-flight reads retain their original pack; their late callbacks
            # must not publish into the replacement pack's caches or window.
            self._catalog_task = None
            self._animation_task = None
            self._preload_task = None
            self._pack = None
            self._animation_cache.clear()
            self._preload_queue.clear()
            self.window.clear_prepared_animations()
        self._preferred_pack_id = binding.pack_id
        self._hide_on_fullscreen = binding.hide_on_fullscreen and not self._companion_session
        self._click_through = binding.click_through
        self._scale = binding.scale
        self._opacity = binding.opacity
        self._always_on_top = binding.always_on_top
        self._locked = binding.locked
        self._bubble_enabled = binding.bubble_enabled
        self.window.set_bubble_style(binding.bubble_style)
        self._fps_cap = binding.fps_cap
        self.window.apply_presentation_settings(
            scale=binding.scale,
            opacity=binding.opacity,
            always_on_top=binding.always_on_top,
            locked=binding.locked,
            bubble_enabled=binding.bubble_enabled,
            fps_cap=binding.fps_cap,
        )
        # A larger size may clamp the window away from its saved anchor. Reapply
        # that anchor after every size change, including shrinking back down.
        if binding.placement and (
            previous is None or previous.placement != binding.placement or previous.scale != binding.scale
        ):
            self.window.cancel_travel()
            self.window.restore_placement(binding.placement)
        if binding.locked or (not binding.wander_enabled and not self._agent_motion.command):
            self.window.cancel_travel()
        self._arm_wander()
        self.window.set_click_through(binding.click_through)
        self.click_through_changed.emit(binding.click_through)

        if not binding.enabled or not binding.pack_id:
            self._hidden_for_fullscreen = False
            if self.visible:
                self.window.cancel_travel()
                self._idle_scheduler.set_active(False)
                self.window.stop_animation()
                self.window.hide()
                self.visibility_changed.emit(False)
            return

        if self._hidden_for_fullscreen:
            return

        if not self.visible:
            self.window.show_on_desktop()
            self._configure_idle_scheduler()
            self._idle_scheduler.note_activity()
            self.visibility_changed.emit(True)
            self._load_catalog()
            return

        if pack_changed:
            self._load_catalog()
        elif previous is not None and previous.scale != binding.scale:
            self._enqueue_animation_preloads()

    def _persist(self, patch: dict[str, object]) -> None:
        self._pending_settings_patch.update(patch)
        if self._settings_task is not None:
            return
        outgoing = self._pending_settings_patch
        self._pending_settings_patch = {}

        def completed(task: QtAsyncTask, result: object) -> None:
            if self._settings_task is task:
                self._settings_task = None
                if not self._closed and "bubbleStyle" in outgoing:
                    if isinstance(result, DesktopPetBinding):
                        self._apply_binding(result)
                        self.window.show_bubble(self._dialogue.line("fallbacks", "bubbleStyleSaved"))
                    else:
                        self.window.show_bubble(self._dialogue.line("fallbacks", "bubbleStyleFailed"))
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
        if self._companion_session:
            return
        if not self.visible or time.monotonic() < self._muted_until:
            return
        if self._passive_action_blocked():
            return
        status = str(event.get("status") or "")
        self._request_reaction("success" if status == "completed" else "concerned")
        summary = str(event.get("summary") or "").strip()
        if summary:
            self.window.show_bubble(summary)

    def _companion_changed(self, payload: object) -> None:
        event = payload if isinstance(payload, dict) else {}
        if event.get("roleId") != self.persona_id:
            return
        session = event.get("session") or {}
        if self._companion_session.get("id") == session.get("id") and int(session.get("revision") or 0) < int(self._companion_session.get("revision") or 0):
            return
        previous = self._companion_session
        if previous.get("id") == session.get("id") and int(session.get("version") or 0) < int(previous.get("version") or 0):
            return
        self._companion_session = session if session.get("status") in ("active", "paused") else {}
        self._companion.accept(session)
        if self._binding_snapshot is not None:
            self._apply_binding(self._binding_snapshot, force=True)
        if previous and not self._companion_session:
            self._idle_scheduler.note_activity()
        self._configure_idle_scheduler()
        if self._companion_session:
            self._wander_timer.stop()
        context_changed = any(previous.get(key) != session.get(key) for key in ("id", "status", "presetId", "activityKind"))
        if context_changed and not self.window.travelling and not self.window.pointer_engaged and not self._context_menu:
            self._resume_context()
        if not self._companion_session:
            self._arm_wander()
        kind = session.get("activityKind")
        if self.visible and time.monotonic() >= self._muted_until:
            if kind != previous.get("activityKind") and kind in ("watch", "play", "work"):
                self.window.show_bubble(self._dialogue.line("openers", kind))
            error = (session.get("review") or {}).get("error")
            if error and error != (previous.get("review") or {}).get("error"):
                self.window.show_bubble(self._dialogue.line("fallbacks", "companionInterrupted"))

    def _companion_reaction(self, payload: object) -> None:
        event = payload if isinstance(payload, dict) else {}
        session = self._companion_session
        if (event.get("roleId") != self.persona_id or not session
                or event.get("sessionId") != session.get("id")
                or event.get("revision") != session.get("revision")
                or float(event.get("expiresAt") or 0) < time.time() * 1000
                or not self.visible or time.monotonic() < self._muted_until):
            return
        if self._passive_action_blocked():
            return
        remaining_ms = min(30000, round(float(event["expiresAt"]) - time.time() * 1000))
        if not self._companion_state():
            self._request_reaction(str(event.get("state") or "attention"), duration_ms=remaining_ms)
        if event.get("text"):
            self.window.show_bubble(str(event["text"])[:1000])

    def _event_connection_changed(self, connected: bool) -> None:
        if connected:
            self._companion.reconnect()
            self._load_binding()
            self._load_dialogue()
            if self.visible and self._requested_state == "concerned":
                self.set_state("idle")
            return
        self._companion_session = {}
        self._companion.disconnect()
        if self._binding_snapshot is not None:
            self._apply_binding(self._binding_snapshot, force=True)
        self._configure_idle_scheduler()
        if self.visible and time.monotonic() >= self._muted_until:
            if not self._passive_action_blocked():
                self._request_reaction("concerned")
            self.window.show_bubble(self._dialogue.line("fallbacks", "managerInterrupted"))

    def _desktop_settings_changed(self, payload: object) -> None:
        event = payload if isinstance(payload, dict) else {}
        event_persona_id = str(event.get("personaId") or "")
        if event_persona_id and event_persona_id != self.persona_id:
            return
        self._load_binding()
        self._load_dialogue()

    def _reconcile_fullscreen_visibility(self) -> None:
        self._fullscreen_timer.start(1500)
        if self.window.pointer_engaged:
            return
        fullscreen = self._hide_on_fullscreen and is_foreground_fullscreen(int(self.window.winId()))
        if fullscreen and self.visible:
            self._hidden_for_fullscreen = True
            self._idle_scheduler.set_active(False)
            self.window.cancel_travel()
            self.window.hide_bubble()
            self.window.hide()
            self.window.stop_animation()
            return
        if not fullscreen and self._hidden_for_fullscreen:
            self._hidden_for_fullscreen = False
            binding = self._binding_snapshot
            if not binding or not binding.enabled or not binding.pack_id:
                return
            self.window.show_on_desktop()
            self._configure_idle_scheduler()
            if self._pack is None:
                self._load_catalog()
            else:
                self._resume_context(self._requested_state)

    def _arm_wander(self) -> None:
        binding = self._binding_snapshot
        if self._closed or self._companion_session or self._speech_job.get("status") == "playing" or not binding or not binding.enabled or not binding.wander_enabled:
            self._wander_timer.stop()
            return
        seconds = self._random.uniform(binding.wander_wait_min_seconds, binding.wander_wait_max_seconds)
        self._wander_timer.start(round(seconds * 1000))

    def _attempt_wander(self) -> None:
        self._arm_wander()
        binding = self._binding_snapshot
        if (not binding or not binding.wander_enabled or binding.locked or not self.visible
                or self.window.pointer_engaged or self.window.travelling or self._context_menu is not None
                or time.monotonic() < max(self._manual_pause_until, self._muted_until)
                or self._requested_state != "idle" or self._pack is None):
            return
        origin_screen = QApplication.screenAt(self.window.frameGeometry().center()) or QApplication.primaryScreen()
        if origin_screen is None:
            return
        screen = origin_screen
        if binding.wander_to_active_window:
            native = foreground_window()
            if native is None or not binding.wander_corners:
                return
            screen = next((candidate for candidate in QApplication.screens()
                           if candidate.name() == native.screen_name or matches_monitor(
                               native.monitor_bounds, candidate.geometry().getRect(), candidate.devicePixelRatio())), None)
            if screen is None:
                return
            geometry, area = screen.geometry(), screen.availableGeometry()
            bounds = logical_bounds(native, (geometry.x(), geometry.y(), geometry.width(), geometry.height()))
            targets = corner_positions(bounds, (area.x(), area.y(), area.width(), area.height()),
                                       (self.window.width(), self.window.height()), binding.wander_corners)
            candidates = [point for point in targets.values() if math.dist((self.window.x(), self.window.y()), point) >= 24]
            if not candidates:
                return
            destination = self._random.choice(candidates)
        else:
            area = screen.availableGeometry()
            destination = (self._random.randint(area.left(), area.left() + max(0, area.width() - self.window.width())),
                           self._random.randint(area.top(), area.top() + max(0, area.height() - self.window.height())))
        kind = travel_kind((self.window.x(), self.window.y()), destination, origin_screen.availableGeometry().width())
        # A walking action must be ready before the character starts travelling.
        if kind in {"move", "run"} and not self._is_action_ready(kind):
            diagnostic = (self._pack.pack_id, kind)
            if self._wander_unavailable_action != diagnostic:
                _LOGGER.warning("Desktop pet wander is waiting for action %s (pack=%s)", kind, self._pack.pack_id)
                self._wander_unavailable_action = diagnostic
            return
        self._wander_unavailable_action = None
        self._state_before_travel = self._requested_state
        self.window.travel_to(QPoint(*destination), kind)

    def _travel_phase_changed(self, state: str) -> None:
        if self._transient_state and self._state_before_travel == self._transient_state:
            self._state_before_travel = "idle"
        self._reaction_timer.stop()
        self._transient_state = ""
        self.set_state(state if self._pack and state in self._pack.states else "idle")

    def _travel_finished(self, completed: bool) -> None:
        self._resume_context(self._state_before_travel)
        if completed:
            self._face_current_window()
        self._arm_wander()

    def _face_current_window(self) -> None:
        native = foreground_window()
        if native is None:
            return
        screen = next((s for s in QApplication.screens() if s.name() == native.screen_name or matches_monitor(
            native.monitor_bounds, s.geometry().getRect(), s.devicePixelRatio())), None)
        if screen is None:
            return
        left, top, right, bottom = logical_bounds(native, screen.geometry().getRect())
        self.window.face_toward(QPoint(round((left + right) / 2), round((top + bottom) / 2)))

    def _show_context_menu(self, position: object) -> None:
        self.window.cancel_travel()
        self._manual_pause_until = time.monotonic() + 30
        self._idle_scheduler.note_activity()
        point = position if isinstance(position, QPoint) else self.window.mapToGlobal(self.window.rect().center())
        menu = QMenu(self.window)
        companion = menu.addAction("陪伴模式", self._companion.toggle)
        companion.setCheckable(True)
        companion.setChecked(bool(self._companion_session))
        companion.setEnabled(not self._companion.control_busy)
        modes = menu.addMenu("陪伴方式")
        if not self._companion.presets:
            modes.addAction("正在加载陪伴方式…").setEnabled(False)
        for preset in self._companion.presets:
            action = modes.addAction(str(preset.get("label") or preset["id"]))
            action.setCheckable(True)
            action.setChecked(bool(self._companion_session)
                              and self._companion_session.get("presetId") == preset["id"])
            action.setEnabled(not self._companion.control_busy)
            action.triggered.connect(
                lambda _checked=False, preset_id=preset["id"]: self._companion.select_mode(preset_id))
        if self._companion_session:
            session = self._companion_session
            review = session.get("review") or {}
            if session.get("status") == "paused":
                label = "等待画面恢复" if session.get("pauseReason") == "capture_lost" else "陪伴已暂停"
            elif review.get("status") == "failed":
                label = "正在恢复陪伴连接"
            else:
                label = {"watch": "正在陪你看视频", "play": "正在陪你玩游戏", "work": "正在陪你工作",
                         "other": "安静陪着"}.get(session.get("activityKind"), "正在识别当前画面")
            menu.addAction(label).setEnabled(False)
        menu.addAction(f"打开 {self.persona_name} 人格面板", self._open_current_persona)
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
        bubble = menu.addAction("显示气泡")
        bubble.setCheckable(True)
        bubble.setChecked(self._bubble_enabled)
        bubble.toggled.connect(self._set_bubble_enabled)
        menu.addAction("气泡样式…", self._edit_bubble_style)
        self._add_scale_control(menu)
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
        if self._locked:
            self.window.cancel_travel()
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

    def _edit_bubble_style(self) -> None:
        self._wander_timer.stop()
        self._manual_pause_until = time.monotonic() + 60
        dialog = DesktopPetBubbleSettings(self._binding_snapshot.bubble_style if self._binding_snapshot else {}, self.window)
        if dialog.exec() == dialog.DialogCode.Accepted:
            self._persist({"bubbleStyle": dialog.style})
        dialog.deleteLater()
        self._arm_wander()

    def _add_scale_control(self, menu: QMenu) -> QMenu:
        percent = round(self._scale * 100)
        scale_menu = menu.addMenu(f"大小：{percent}%")
        panel = QWidget(scale_menu)
        layout = QVBoxLayout(panel)
        label = QLabel(f"当前大小：{percent}%", panel)
        slider = QSlider(Qt.Orientation.Horizontal, panel)
        slider.setRange(10, 200)
        slider.setSingleStep(1)
        slider.setPageStep(10)
        slider.setValue(percent)
        slider.setMinimumWidth(220)
        slider.setAccessibleName("桌宠大小（10%–200%）")
        layout.addWidget(label)
        layout.addWidget(slider)
        layout.addWidget(QLabel("10%                         200%", panel))
        action = QWidgetAction(scale_menu)
        action.setDefaultWidget(panel)
        scale_menu.addAction(action)
        timer = QTimer(self)
        timer.setSingleShot(True)
        pending_scale = self._scale
        edited = False

        def apply() -> None:
            timer.deleteLater()
            if not self._closed:
                self._set_scale(pending_scale)

        timer.timeout.connect(apply)

        def changed(value: int) -> None:
            nonlocal pending_scale, edited
            edited = True
            pending_scale = value / 100
            label.setText(f"当前大小：{value}%")
            scale_menu.setTitle(f"大小：{value}%")
            self.window.set_scale_preview(pending_scale)

        def commit() -> None:
            # Let the entire popup disappear before decoding at the final size.
            if edited:
                timer.start(0)
            else:
                timer.deleteLater()

        slider.valueChanged.connect(changed)
        menu.aboutToHide.connect(commit)
        return scale_menu

    def _set_scale(self, scale: float) -> None:
        scale = max(0.1, min(2.0, float(scale)))
        if abs(self._scale - scale) < 0.0001:
            self.window.set_scale_preview(None)
            return
        self._scale = scale
        self._apply_presentation()
        self._enqueue_animation_preloads()
        patch = {"scale": scale}
        placement = self.window.placement()
        if placement is not None:
            patch["placement"] = placement
        self._persist(patch)

    def _play_manual_action(self, state_name: str) -> None:
        self.window.cancel_travel()
        self._manual_pause_until = time.monotonic() + 30
        if not self._is_action_ready(state_name):
            return
        self._idle_scheduler.note_activity()
        if self._pack and state_name == self._pack.idle_behavior.sleep_state:
            self._reaction_timer.stop()
            self._transient_state = ""
            self.set_state(state_name)
        else:
            self._request_reaction(state_name)

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
            for state_name in ("attention", "lift", "drag", "throw", "airborne", "move", "run")
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
        group = self._companion_animation_set()
        mode_states = [group.idle_state, *group.click_states, *group.random_states] if group else []
        for state_name in mode_states + interaction_states + one_shot_states + looping_states:
            if not self._is_action_ready(state_name) and state_name not in queued:
                self._preload_queue.append(state_name)
                queued.add(state_name)
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
        self._reaction_timer.stop()
        self._transient_state = ""
        self._companion.pause()
        self._muted_until = time.monotonic() + 60 * 60
        self.window.hide_bubble()
        self.set_state("sleep")
