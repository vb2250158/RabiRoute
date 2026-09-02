from __future__ import annotations

import os
import io
import threading
import time
import unittest
from unittest.mock import MagicMock, call, patch
from urllib.error import HTTPError

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QBuffer, QIODevice, QPoint, Qt
from PySide6.QtGui import QPixmap
from PySide6.QtTest import QSignalSpy, QTest
from PySide6.QtWidgets import QApplication

from rabiroute_tray.desktop_pet_client import (
    DesktopPetClient,
    DesktopPetIdleBehavior,
    DesktopPetBinding,
    DesktopPetPersona,
    DesktopPetPack,
    DesktopPetRosterClient,
    DesktopPetState,
    LoadedDesktopPetAnimation,
    parse_desktop_pet_catalog,
)
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_events import iter_sse_events
from rabiroute_tray.desktop_pet_fullscreen import covers_monitor
from rabiroute_tray.desktop_pet_idle import DesktopPetIdleScheduler
from rabiroute_tray.desktop_pet_window import DesktopPetWindow
from rabiroute_tray.desktop_pet_manager import DesktopPetManager


def _skip_desktop_pet_binding_load(_controller: DesktopPetController) -> None:
    return None


class _BinaryResponse:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def read(self) -> bytes:
        return self.payload


class DesktopPetCatalogTest(unittest.TestCase):
    def test_manager_sse_parser_keeps_generic_work_ended_payload(self) -> None:
        stream = io.BytesIO(
            b"event: ready\ndata: {}\n\n"
            b"event: work_ended\ndata: {\"id\":\"codex:1\",\"personaId\":\"YeYu\",\"status\":\"completed\"}\n\n"
        )

        events = list(iter_sse_events(stream))

        self.assertEqual(events[1][0], "work_ended")
        self.assertEqual(events[1][1]["personaId"], "YeYu")

    def test_event_stream_treats_close_during_blocking_read_as_clean_stop(self) -> None:
        entered_read = threading.Event()
        closed = threading.Event()
        uncaught: list[BaseException] = []

        class ClosingResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args) -> None:
                return None

            def readline(self) -> bytes:
                entered_read.set()
                closed.wait(timeout=2.0)
                raise AttributeError("closed response has no readline")

            def close(self) -> None:
                closed.set()

        original_hook = threading.excepthook
        threading.excepthook = lambda args: uncaught.append(args.exc_value)
        try:
            stream = DesktopPetEventStream("http://127.0.0.1:1")
            with patch("rabiroute_tray.desktop_pet_events.urlopen", return_value=ClosingResponse()):
                stream.start()
                self.assertTrue(entered_read.wait(timeout=1.0))
                thread = stream._thread
                stream.stop()
                self.assertIsNotNone(thread)
                thread.join(timeout=1.0)
                self.assertFalse(thread.is_alive())
        finally:
            threading.excepthook = original_hook

        self.assertEqual(uncaught, [])

    def test_binding_parser_keeps_persona_scoped_presentation_settings(self) -> None:
        client = DesktopPetClient("http://127.0.0.1:8790", "YeYu")
        client._get = lambda _path: (  # type: ignore[method-assign]
            b'{"data":{"personaId":"YeYu","binding":{"enabled":true,"packId":"night",'
            b'"scale":0.75,"opacity":0.8,"placement":{"screen":"DISPLAY-2","xRatio":0.2,"yRatio":0.9},'
            b'"alwaysOnTop":false,"clickThrough":true,"locked":true,"hideOnFullscreen":true,'
            b'"bubbleEnabled":false,"fpsCap":24}}}'
        )

        binding = client.binding()

        self.assertTrue(binding.enabled)
        self.assertEqual(binding.pack_id, "night")
        self.assertEqual(binding.placement["screen"], "DISPLAY-2")
        self.assertEqual(binding.fps_cap, 24)

    def test_runtime_catalog_requests_only_the_local_runtime_scope(self) -> None:
        client = DesktopPetClient("http://127.0.0.1:8790", "YeYu")
        requested_paths: list[str] = []

        def fake_get(path: str) -> bytes:
            requested_paths.append(path)
            return b'{"data":{"personaId":"YeYu","packs":[]}}'

        client._get = fake_get  # type: ignore[method-assign]

        client.packs()

        self.assertEqual(requested_paths, ["/api/desktop-pet/roles/YeYu/packs?scope=runtime"])

    def test_fullscreen_detection_requires_covering_the_monitor(self) -> None:
        self.assertTrue(covers_monitor((0, 0, 1920, 1080), (0, 0, 1920, 1080)))
        self.assertFalse(covers_monitor((0, 0, 1000, 800), (0, 0, 1920, 1080)))

    def test_catalog_keeps_persona_binding_and_animation_metadata(self) -> None:
        packs = parse_desktop_pet_catalog(
            {
                "data": {
                    "personaId": "YeYu",
                    "packs": [
                        {
                            "id": "yeyu-library-default",
                            "name": "夜雨 · 图书馆日常",
                            "personaId": "YeYu",
                            "canvas": {"width": 512, "height": 512},
                            "scale": 0.5,
                            "states": {
                                "idle": {
                                    "type": "gif",
                                    "assets": ["/api/desktop-pet/roles/YeYu/packs/default/assets/idle.gif"],
                                    "fps": 12,
                                    "loop": True,
                                },
                                "thinking": {
                                    "type": "png-sequence",
                                    "assets": [
                                        "/api/desktop-pet/roles/YeYu/packs/default/assets/thinking_1.png",
                                        "/api/desktop-pet/roles/YeYu/packs/default/assets/thinking_2.png",
                                    ],
                                    "fps": 15,
                                    "loop": False,
                                    "next": "idle",
                                },
                                "sleep": {
                                    "type": "png-sequence",
                                    "assets": ["/api/sleep_1.png"],
                                    "fps": 12,
                                    "loop": True,
                                },
                            },
                            "idleBehavior": {
                                "randomMinSeconds": 75,
                                "randomMaxSeconds": 180,
                                "randomStates": ["thinking", "missing"],
                                "sleepAfterSeconds": 900,
                                "sleepState": "sleep",
                            },
                        }
                    ],
                }
            },
            "YeYu",
        )

        self.assertEqual(len(packs), 1)
        self.assertEqual(packs[0].persona_id, "YeYu")
        self.assertEqual(packs[0].states["thinking"].fps, 15)
        self.assertEqual(packs[0].states["thinking"].next_state, "idle")
        self.assertEqual(packs[0].idle_behavior.random_states, ("thinking",))
        self.assertEqual(packs[0].idle_behavior.sleep_state, "sleep")


class _PredictableRandom:
    def uniform(self, start: float, _end: float) -> float:
        return start

    def choice(self, values: list[str]) -> str:
        return values[0]


class DesktopPetIdleSchedulerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_random_idle_actions_do_not_repeat_back_to_back(self) -> None:
        scheduler = DesktopPetIdleScheduler(random_source=_PredictableRandom())
        requested = QSignalSpy(scheduler.animation_requested)
        scheduler.configure(DesktopPetIdleBehavior(10, 20, ("idle-reading", "idle-wave"), 900, "sleep"))
        scheduler.set_active(True)
        scheduler.state_started("idle")

        scheduler._request_random_animation()
        scheduler.state_started("idle")
        scheduler._request_random_animation()

        self.assertEqual(
            [requested.at(index)[0] for index in range(requested.count())],
            ["idle-reading", "idle-wave"],
        )
        scheduler.stop()

    def test_long_inactivity_requests_looping_sleep_state(self) -> None:
        now = [100.0]
        scheduler = DesktopPetIdleScheduler(random_source=_PredictableRandom(), clock=lambda: now[0])
        requested = QSignalSpy(scheduler.animation_requested)
        scheduler.configure(DesktopPetIdleBehavior(10, 20, ("idle-reading",), 60, "sleep"))
        scheduler.set_active(True)
        scheduler.state_started("idle")
        now[0] = 161.0

        scheduler._arm_sleep_timer()

        self.assertEqual(requested.count(), 1)
        self.assertEqual(requested.at(0)[0], "sleep")
        scheduler.stop()


class DesktopPetClientTest(unittest.TestCase):
    def test_roster_uses_persona_names_and_only_keeps_enabled_bound_pets(self) -> None:
        client = DesktopPetRosterClient("http://127.0.0.1:8790")
        responses = {
            "/api/desktop/settings": {
                "data": {
                    "pets": {
                        "YeYu": {"enabled": True, "packId": ""},
                        "XinghaiBuilder": {"enabled": True, "packId": "xinghai"},
                        "Writer": {"enabled": False, "packId": "writer"},
                        "RemovedPersona": {"enabled": True, "packId": "removed"},
                    }
                }
            },
            "/api/personas": {
                "personas": [
                    {"personaId": "YeYu", "name": "夜雨"},
                    {"personaId": "XinghaiBuilder", "name": "星海建造师"},
                    {"personaId": "Writer", "name": "写作者"},
                ]
            },
        }
        client._get_json = lambda path: responses[path]  # type: ignore[method-assign]

        roster = client.roster()

        self.assertEqual(
            roster,
            (DesktopPetPersona("XinghaiBuilder", "星海建造师", DesktopPetBinding(enabled=True, pack_id="xinghai")),),
        )

    def test_catalog_rejects_cross_persona_response(self) -> None:
        with self.assertRaisesRegex(ValueError, "different persona"):
            parse_desktop_pet_catalog({"data": {"personaId": "Other", "packs": []}}, "YeYu")

    def test_asset_download_retries_a_transient_manager_exhaustion(self) -> None:
        client = DesktopPetClient("http://127.0.0.1:8790", "YeYu")
        exhausted = HTTPError("http://127.0.0.1/idle.png", 503, "busy", {}, None)
        with (
            patch("rabiroute_tray.desktop_pet_client.urlopen", side_effect=[exhausted, _BinaryResponse(b"png")]) as request,
            patch("rabiroute_tray.desktop_pet_client.time.sleep") as sleep,
        ):
            payload = client._get("/idle.png")

        self.assertEqual(payload, b"png")
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once()

    def test_animation_asset_downloads_are_spaced_for_nas_storage(self) -> None:
        client = DesktopPetClient("http://127.0.0.1:8790", "YeYu", asset_interval_seconds=0.1)
        state = DesktopPetState("idle", "png-sequence", ("/1.png", "/2.png", "/3.png"), 12, True)
        pack = DesktopPetPack("night", "Night", "YeYu", 512, 512, 0.5, {"idle": state})

        with (
            patch.object(client, "_get", side_effect=[b"1", b"2", b"3"]),
            patch("rabiroute_tray.desktop_pet_client.time.sleep") as sleep,
        ):
            loaded = client.load_animation(pack, "idle")

        self.assertEqual(loaded.assets, (b"1", b"2", b"3"))
        self.assertEqual(sleep.call_args_list, [call(0.1), call(0.1)])

    def test_binding_updates_use_the_desktop_pet_plugin_route(self) -> None:
        client = DesktopPetClient("http://127.0.0.1:8790", "YeYu")
        response = _BinaryResponse(
            b'{"data":{"personaId":"YeYu","binding":{"enabled":true,"packId":"night",'
            b'"clickThrough":false}}}'
        )

        with patch("rabiroute_tray.desktop_pet_client.urlopen", return_value=response) as request:
            binding = client.update_binding({"clickThrough": False})

        outgoing = request.call_args.args[0]
        self.assertEqual(outgoing.full_url, "http://127.0.0.1:8790/api/desktop-pet/roles/YeYu")
        self.assertEqual(outgoing.get_method(), "PATCH")
        self.assertEqual(outgoing.data, b'{"personaId": "YeYu", "clickThrough": false}')
        self.assertTrue(binding.enabled)
        self.assertFalse(binding.click_through)


class DesktopPetWindowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_window_is_translucent_frameless_and_non_activating(self) -> None:
        window = DesktopPetWindow("星海建造师")
        try:
            self.assertTrue(window.testAttribute(Qt.WidgetAttribute.WA_TranslucentBackground))
            self.assertTrue(window.windowFlags() & Qt.WindowType.FramelessWindowHint)
            self.assertTrue(window.windowFlags() & Qt.WindowType.WindowDoesNotAcceptFocus)
            self.assertEqual(window.windowTitle(), "星海建造师桌宠")
        finally:
            window.close()

    def test_click_through_can_be_enabled_and_recovered(self) -> None:
        window = DesktopPetWindow()
        try:
            window.set_click_through(True)
            self.assertTrue(window.windowFlags() & Qt.WindowType.WindowTransparentForInput)
            window.set_click_through(False)
            self.assertFalse(window.windowFlags() & Qt.WindowType.WindowTransparentForInput)
        finally:
            window.close()

    def test_scale_change_resizes_the_cached_animation_without_a_network_reload(self) -> None:
        window = DesktopPetWindow()
        state = DesktopPetState("idle", "png-sequence", ("/idle.png",), 12, True)
        pack = DesktopPetPack("night", "Night", "YeYu", 512, 512, 0.5, {"idle": state})
        payload = QBuffer()
        payload.open(QIODevice.OpenModeFlag.WriteOnly)
        frame = QPixmap(8, 8)
        frame.fill(Qt.GlobalColor.cyan)
        self.assertTrue(frame.save(payload, "PNG"))
        animation = LoadedDesktopPetAnimation(state, (bytes(payload.data()),))
        try:
            window.play(pack, animation)
            self.assertEqual((window.width(), window.height()), (256, 256))
            window.apply_presentation_settings(
                scale=1.0,
                opacity=1.0,
                always_on_top=True,
                locked=False,
                bubble_enabled=True,
                fps_cap=15,
            )

            self.assertEqual((window.width(), window.height()), (512, 512))
        finally:
            payload.close()
            window.close()

    def test_right_click_menu_plays_only_actions_declared_by_the_current_pack(self) -> None:
        states = {
            "idle": DesktopPetState("idle", "png-sequence", ("/idle.png",), 12, True),
            "idle-wave": DesktopPetState("idle-wave", "png-sequence", ("/wave.png",), 12, False, "idle"),
        }
        pack = DesktopPetPack("night", "Night", "YeYu", 512, 512, 0.5, states)
        with (
            patch.object(DesktopPetEventStream, "start"),
            patch.object(DesktopPetEventStream, "stop"),
            patch.object(DesktopPetController, "_load_binding", new=_skip_desktop_pet_binding_load),
            patch("rabiroute_tray.desktop_pet_controller.QMenu.popup"),
        ):
            controller = DesktopPetController("http://127.0.0.1:8790", "YeYu", lambda _persona_id: None)
            controller._pack = pack
            controller._idle_scheduler = MagicMock()
            try:
                with patch.object(controller, "_is_action_ready", return_value=True):
                    controller._show_context_menu(QPoint(30, 40))
                root_menu = controller._context_menu
                self.assertIsNotNone(root_menu)
                play_menu = root_menu._desktop_pet_action_menu
                self.assertEqual([action.text() for action in play_menu.actions()], ["待机", "挥手"])

                with patch.object(controller, "_play_manual_action") as play:
                    next(action for action in play_menu.actions() if action.text() == "挥手").trigger()
                play.assert_called_once_with("idle-wave")

                controller._idle_scheduler.note_activity.reset_mock()
                with (
                    patch.object(controller, "_is_action_ready", side_effect=lambda state_name: state_name == "idle-wave"),
                    patch.object(controller, "set_state") as set_state,
                ):
                    controller._play_manual_action("idle-wave")
                    controller._play_manual_action("not-in-the-pack")
                controller._idle_scheduler.note_activity.assert_called_once()
                set_state.assert_called_once_with("idle-wave")
            finally:
                controller.close()

    def test_unprepared_right_click_actions_are_disabled(self) -> None:
        states = {
            "idle": DesktopPetState("idle", "png-sequence", ("/idle.png",), 12, True),
            "idle-wave": DesktopPetState("idle-wave", "png-sequence", ("/wave.png",), 12, False, "idle"),
        }
        pack = DesktopPetPack("night", "Night", "YeYu", 512, 512, 0.5, states)
        with (
            patch.object(DesktopPetEventStream, "start"),
            patch.object(DesktopPetEventStream, "stop"),
            patch.object(DesktopPetController, "_load_binding", new=_skip_desktop_pet_binding_load),
            patch("rabiroute_tray.desktop_pet_controller.QMenu.popup"),
        ):
            controller = DesktopPetController("http://127.0.0.1:8790", "YeYu", lambda _persona_id: None)
            controller._pack = pack
            try:
                controller._show_context_menu(QPoint(30, 40))
                play_menu = controller._context_menu._desktop_pet_action_menu
                self.assertEqual(play_menu.actions()[0].text(), "正在预载动作（0/2）")
                self.assertFalse(play_menu.actions()[-1].isEnabled())
            finally:
                controller.close()

    def test_manager_binding_refresh_reloads_a_newly_bound_pack(self) -> None:
        with (
            patch.object(DesktopPetEventStream, "start"),
            patch.object(DesktopPetEventStream, "stop"),
            patch.object(DesktopPetController, "_load_binding", new=_skip_desktop_pet_binding_load),
        ):
            controller = DesktopPetController("http://127.0.0.1:8790", "YeYu", lambda _persona_id: None)
            try:
                controller.window.show()
                controller._binding_snapshot = DesktopPetBinding(enabled=True, pack_id="old-pack")
                controller._preferred_pack_id = "old-pack"
                controller._pack = DesktopPetPack("old-pack", "Old", "YeYu", 512, 512, 0.5, {})
                controller._animation_cache["idle"] = MagicMock()
                with patch.object(controller, "_load_catalog") as reload_catalog:
                    controller._apply_binding(DesktopPetBinding(enabled=True, pack_id="new-pack"))

                self.assertEqual(controller._preferred_pack_id, "new-pack")
                self.assertIsNone(controller._pack)
                self.assertEqual(controller._animation_cache, {})
                reload_catalog.assert_called_once()
            finally:
                controller.close()

    def test_enabled_binding_without_a_pack_never_shows_a_placeholder_window(self) -> None:
        with (
            patch.object(DesktopPetEventStream, "start"),
            patch.object(DesktopPetEventStream, "stop"),
            patch.object(DesktopPetController, "_load_binding", new=_skip_desktop_pet_binding_load),
        ):
            controller = DesktopPetController(
                "http://127.0.0.1:8790",
                "YeYu",
                lambda _persona_id: None,
                persona_name="夜雨",
            )
            try:
                controller.window.show()
                controller._apply_binding(DesktopPetBinding(enabled=True, pack_id=""))
                self.assertFalse(controller.visible)
            finally:
                controller.close()

    def test_prepared_action_starts_within_the_interaction_budget(self) -> None:
        window = DesktopPetWindow()
        state = DesktopPetState("idle-wave", "png-sequence", ("/wave.png",) * 24, 12, False, "idle")
        pack = DesktopPetPack("night", "Night", "YeYu", 512, 512, 0.5, {"idle": state, "idle-wave": state})
        payload = QBuffer()
        payload.open(QIODevice.OpenModeFlag.WriteOnly)
        frame = QPixmap(8, 8)
        frame.fill(Qt.GlobalColor.cyan)
        self.assertTrue(frame.save(payload, "PNG"))
        animation = LoadedDesktopPetAnimation(state, (bytes(payload.data()),) * 24)
        try:
            self.assertTrue(window.prepare_animation(pack, animation))
            started_at = time.perf_counter()
            window.play(pack, animation)
            self.assertLess(time.perf_counter() - started_at, 0.1)
        finally:
            payload.close()
            window.close()

    def test_click_interrupts_sleep_with_a_prepared_attention_action(self) -> None:
        idle = DesktopPetState("idle", "png-sequence", ("/idle.png",), 12, True)
        sleep = DesktopPetState("sleep", "png-sequence", ("/sleep.png",), 12, True)
        attention = DesktopPetState("attention", "png-sequence", ("/attention.png",), 12, False, "idle")
        pack = DesktopPetPack(
            "night",
            "Night",
            "YeYu",
            512,
            512,
            0.5,
            {"idle": idle, "sleep": sleep, "attention": attention},
        )
        animation = LoadedDesktopPetAnimation(attention, (b"prepared",))
        with (
            patch.object(DesktopPetEventStream, "start"),
            patch.object(DesktopPetEventStream, "stop"),
            patch.object(DesktopPetController, "_load_binding", new=_skip_desktop_pet_binding_load),
        ):
            controller = DesktopPetController("http://127.0.0.1:8790", "YeYu", lambda _persona_id: None)
            controller._pack = pack
            controller._requested_state = "sleep"
            controller._animation_cache["attention"] = animation
            controller._idle_scheduler = MagicMock()
            controller.window.show()
            try:
                with (
                    patch.object(controller.window, "prepare_animation", return_value=True),
                    patch.object(controller.window, "play") as play,
                ):
                    controller._clicked()

                controller._idle_scheduler.note_activity.assert_called_once()
                controller._idle_scheduler.state_requested.assert_called_once_with("attention")
                controller._idle_scheduler.state_started.assert_called_once_with("attention")
                play.assert_called_once_with(pack, animation)
                self.assertEqual(controller._requested_state, "attention")
                self.assertIsNone(controller._animation_task)
            finally:
                controller.close()

    def test_attention_is_preloaded_before_other_pack_actions(self) -> None:
        states = {
            "idle": DesktopPetState("idle", "png-sequence", ("/idle.png",), 12, True),
            "success": DesktopPetState("success", "png-sequence", ("/success.png",), 12, False, "idle"),
            "attention": DesktopPetState(
                "attention", "png-sequence", ("/attention.png",), 12, False, "idle"
            ),
            "thinking": DesktopPetState("thinking", "png-sequence", ("/thinking.png",), 12, True),
            "drag": DesktopPetState("drag", "png-sequence", ("/drag.png",), 12, True),
        }
        pack = DesktopPetPack("night", "Night", "YeYu", 512, 512, 0.5, states)
        with (
            patch.object(DesktopPetEventStream, "start"),
            patch.object(DesktopPetEventStream, "stop"),
            patch.object(DesktopPetController, "_load_binding", new=_skip_desktop_pet_binding_load),
        ):
            controller = DesktopPetController("http://127.0.0.1:8790", "YeYu", lambda _persona_id: None)
            controller._pack = pack
            controller.window.show()
            try:
                with patch.object(controller, "_start_next_animation_preload"):
                    controller._enqueue_animation_preloads()

                self.assertEqual(
                    list(controller._preload_queue),
                    ["attention", "drag", "success", "thinking"],
                )
            finally:
                controller.close()

    def test_drag_state_signals_only_wrap_an_actual_move(self) -> None:
        window = DesktopPetWindow()
        started = QSignalSpy(window.drag_started)
        finished = QSignalSpy(window.drag_finished)
        try:
            window.resize(200, 200)
            window.show()
            QTest.mousePress(window, Qt.MouseButton.LeftButton, pos=QPoint(50, 50))
            QTest.mouseMove(window, QPoint(90, 90), delay=1)
            QTest.mouseRelease(window, Qt.MouseButton.LeftButton, pos=QPoint(90, 90))
            self.assertEqual(started.count(), 1)
            self.assertEqual(finished.count(), 1)
        finally:
            window.close()

    def test_single_click_emits_click_without_dragging(self) -> None:
        window = DesktopPetWindow()
        clicked = QSignalSpy(window.clicked)
        started = QSignalSpy(window.drag_started)
        try:
            window.resize(200, 200)
            window.show()
            QTest.mouseClick(window, Qt.MouseButton.LeftButton, pos=QPoint(50, 50))
            QTest.qWait(QApplication.doubleClickInterval() + 50)
            self.assertEqual(clicked.count(), 1)
            self.assertEqual(started.count(), 0)
        finally:
            window.close()

    def test_double_click_does_not_also_emit_single_click(self) -> None:
        window = DesktopPetWindow()
        clicked = QSignalSpy(window.clicked)
        double_clicked = QSignalSpy(window.double_clicked)
        try:
            window.resize(200, 200)
            window.show()
            QTest.mouseDClick(window, Qt.MouseButton.LeftButton, pos=QPoint(50, 50))
            QTest.qWait(QApplication.doubleClickInterval() + 50)
            self.assertEqual(clicked.count(), 0)
            self.assertEqual(double_clicked.count(), 1)
        finally:
            window.close()


class DesktopPetManagerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_reconcile_creates_one_named_controller_per_enabled_persona_and_removes_disabled_ones(self) -> None:
        binding = DesktopPetBinding(enabled=True, pack_id="default")
        fake_menu = MagicMock()
        with (
            patch("rabiroute_tray.desktop_pet_manager.DesktopPetEventStream") as event_stream,
            patch("rabiroute_tray.desktop_pet_manager.DesktopPetController") as controller_type,
            patch.object(DesktopPetManager, "refresh"),
        ):
            controllers = [MagicMock(), MagicMock()]
            controller_type.side_effect = controllers
            manager = DesktopPetManager("http://127.0.0.1:8790", fake_menu, lambda _persona_id: None)
            manager._apply_roster((
                DesktopPetPersona("YeYu", "夜雨", binding),
                DesktopPetPersona("XinghaiBuilder", "星海建造师", binding),
            ))

            self.assertEqual(controller_type.call_count, 2)
            self.assertEqual(controller_type.call_args_list[0].kwargs["persona_name"], "夜雨")
            self.assertEqual(controller_type.call_args_list[1].kwargs["persona_name"], "星海建造师")
            self.assertEqual(set(manager.controllers), {"YeYu", "XinghaiBuilder"})

            manager._apply_roster((DesktopPetPersona("XinghaiBuilder", "星海建造师", binding),))

            controllers[0].close.assert_called_once()
            self.assertEqual(set(manager.controllers), {"XinghaiBuilder"})
            manager.close()
            event_stream.return_value.stop.assert_called_once()

    def test_close_ignores_a_late_roster_refresh(self) -> None:
        fake_menu = MagicMock()
        binding = DesktopPetBinding(enabled=True, pack_id="default")
        with (
            patch("rabiroute_tray.desktop_pet_manager.DesktopPetEventStream"),
            patch("rabiroute_tray.desktop_pet_manager.DesktopPetController") as controller_type,
            patch("rabiroute_tray.desktop_pet_manager.start_qt_task") as start_task,
        ):
            task = MagicMock()
            start_task.return_value = task
            manager = DesktopPetManager("http://127.0.0.1:8790", fake_menu, lambda _persona_id: None)
            completed = start_task.call_args.args[1]

            manager.close()
            completed(task, (DesktopPetPersona("YeYu", "夜雨", binding),))

            controller_type.assert_not_called()
            self.assertEqual(manager.controllers, {})


if __name__ == "__main__":
    unittest.main()
