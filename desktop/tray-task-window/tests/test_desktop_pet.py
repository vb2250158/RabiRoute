from __future__ import annotations

import os
import io
import unittest
from unittest.mock import call, patch
from urllib.error import HTTPError

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QPoint, Qt
from PySide6.QtTest import QSignalSpy, QTest
from PySide6.QtWidgets import QApplication

from rabiroute_tray.desktop_pet_client import (
    DesktopPetClient,
    DesktopPetIdleBehavior,
    DesktopPetPack,
    DesktopPetState,
    parse_desktop_pet_catalog,
)
from rabiroute_tray.desktop_pet_events import iter_sse_events
from rabiroute_tray.desktop_pet_fullscreen import covers_monitor
from rabiroute_tray.desktop_pet_idle import DesktopPetIdleScheduler
from rabiroute_tray.desktop_pet_window import DesktopPetWindow


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


class DesktopPetWindowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_window_is_translucent_frameless_and_non_activating(self) -> None:
        window = DesktopPetWindow()
        try:
            self.assertTrue(window.testAttribute(Qt.WidgetAttribute.WA_TranslucentBackground))
            self.assertTrue(window.windowFlags() & Qt.WindowType.FramelessWindowHint)
            self.assertTrue(window.windowFlags() & Qt.WindowType.WindowDoesNotAcceptFocus)
            self.assertEqual(window.windowTitle(), "夜雨桌宠")
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


if __name__ == "__main__":
    unittest.main()
