from dataclasses import replace
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QPoint
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from rabiroute_tray.desktop_pet_client import DesktopPetBinding
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_motion import ForegroundWindow
from pet_motion_fixture import walking_animation, advance_walk, finish_walk


class PetMotionSafetyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.enqueue_preloads = DesktopPetController._enqueue_animation_preloads
        self.patches = [patch.object(DesktopPetEventStream, "start"),
                        patch.object(DesktopPetEventStream, "stop"),
                        patch.object(DesktopPetController, "_load_binding"),
                        patch.object(DesktopPetController, "_persist"),
                        patch.object(DesktopPetController, "_enqueue_animation_preloads")]
        for item in self.patches:
            item.start()
        self.controller = DesktopPetController("http://127.0.0.1:1", "sample", lambda _: None)
        pack, move = walking_animation()
        idle = replace(move, state=replace(move.state, name="idle"))
        self.pack = replace(pack, states={"idle": idle.state, "move": move.state})
        self.move, self.idle = move, idle
        self.controller._pack = self.pack
        self.binding = DesktopPetBinding(enabled=True, pack_id=pack.pack_id, wander_enabled=True)
        self.controller._binding_snapshot = self.binding
        self.controller._preferred_pack_id = pack.pack_id
        self.controller._animation_cache = {"idle": idle, "move": move}
        self.controller.window.show_on_desktop()
        self.controller.set_state("idle")
        self.controller.window.move(100, 100)
        self.controller._fullscreen_timer.stop()

    def tearDown(self):
        self.controller.close()
        for item in reversed(self.patches):
            item.stop()

    def test_pack_replacement_interrupts_walking_before_catalog_loading(self):
        window = self.controller.window
        window.travel_to(QPoint(400, 100), "move")
        advance_walk(window)
        stopped = window.pos()
        with patch.object(self.controller, "_load_catalog"):
            self.controller._apply_binding(replace(self.binding, pack_id="replacement"))
        self.assertFalse(window.travelling)
        advance_walk(window)
        self.assertEqual(window.pos(), stopped)

    def test_repeated_move_state_keeps_the_original_animation_clock(self):
        window = self.controller.window
        window.travel_to(QPoint(400, 100), "move")
        advance_walk(window, 0.05)
        advance_walk(window, 0.05)
        current_frame = window._png_index
        self.controller.set_state("move")
        self.assertEqual(window._png_index, current_frame)
        with patch.object(window, "_display_png_frame", wraps=window._display_png_frame) as display:
            QTest.qWait(270)
            self.assertLessEqual(display.call_count, 4)
        self.assertTrue(window.travelling)

    def test_late_animation_from_old_pack_cannot_play_in_replacement_pack(self):
        tasks = []
        def submit(operation, callback, **_):
            task = object()
            tasks.append((task, operation, callback))
            return task
        self.controller._animation_cache.clear()
        self.controller.window.stop_animation()
        with patch("rabiroute_tray.desktop_pet_controller.start_qt_task", side_effect=submit):
            self.controller.set_state("idle")
            task, operation, callback = tasks[0]
            self.controller._pack = replace(self.pack, pack_id="replacement")
            with patch.object(self.controller._client, "load_animation", return_value=self.idle) as load:
                operation()
                self.assertIs(load.call_args.args[0], self.pack)
            with patch.object(self.controller.window, "play") as play:
                callback(task, self.idle)
                play.assert_not_called()
            self.assertNotIn("idle", self.controller._animation_cache)

    def test_missing_selected_pack_never_plays_an_unrelated_cached_pack(self):
        tasks = []
        def submit(operation, callback, **_):
            task = object()
            tasks.append((task, callback))
            return task
        self.controller._preferred_pack_id = "missing-pack"
        with patch("rabiroute_tray.desktop_pet_controller.start_qt_task", side_effect=submit):
            self.controller._load_catalog()
            task, callback = tasks[-1]
            callback(task, (self.pack,))
        self.assertIsNone(self.controller._pack)

    def test_short_diagonal_stops_exactly_and_click_cancellation_stays_stopped(self):
        window = self.controller.window
        window.travel_to(QPoint(112, 109), "move")
        finish_walk(window)
        self.assertEqual(window.pos(), QPoint(112, 109))
        window.travel_to(QPoint(100, 100), "move")
        advance_walk(window)
        self.controller._clicked()
        stopped = window.pos()
        for _ in range(10):
            advance_walk(window)
        self.assertFalse(window.travelling)
        self.assertEqual(window.pos(), stopped)

    def test_walking_stops_when_rendered_animation_is_lost(self):
        window = self.controller.window
        window.travel_to(QPoint(400, 100), "move")
        advance_walk(window)
        stopped = window.pos()
        window.stop_animation()
        advance_walk(window)
        self.assertFalse(window.travelling)
        self.assertEqual(window.pos(), stopped)

    def test_manager_scale_change_prepares_cached_walking_at_the_new_size(self):
        self.controller.window.prepare_animation(self.pack, self.move)
        self.assertTrue(self.controller._is_action_ready("move"))
        with patch.object(self.controller, "_enqueue_animation_preloads",
                          side_effect=lambda: self.enqueue_preloads(self.controller)):
            self.controller._apply_binding(replace(self.binding, scale=0.75))
        self.assertTrue(self.controller._is_action_ready("move"))

    def test_arrival_turns_in_place_toward_current_window_center(self):
        window = self.controller.window
        screen = self.app.primaryScreen()
        x, y, width, height = screen.geometry().getRect()
        native = ForegroundWindow(1, (x, y, x + 500, y + 400), screen.name(),
                                  (x, y, x + width, y + height))
        with patch("rabiroute_tray.desktop_pet_controller.foreground_window", return_value=native):
            window.travel_to(QPoint(400, 100), "move")
            self.assertFalse(window._facing_left)
            finish_walk(window)
        position = window.pos()
        self.assertTrue(window._facing_left)
        initial_width = window._label.pixmap().width()
        QTest.qWait(80)
        self.assertLess(window._label.pixmap().width(), initial_width)
        QTest.qWait(160)
        self.assertEqual(window.pos(), position)
        self.assertIsNone(window._turn_scale)
        self.assertEqual(window._label.pixmap().width(), initial_width)
        self.assertEqual(self.controller._requested_state, "idle")

    def test_cancelled_walk_never_looks_up_a_window_or_turns(self):
        window = self.controller.window
        window.travel_to(QPoint(400, 100), "move")
        with patch("rabiroute_tray.desktop_pet_controller.foreground_window") as foreground:
            window.cancel_travel()
            foreground.assert_not_called()
        self.assertFalse(window._facing_left)
        self.assertIsNone(window._turn_scale)

    def test_new_walk_cancels_arrival_turn_and_faces_forward_immediately(self):
        window = self.controller.window
        window.face_toward(QPoint(0, 0))
        QTest.qWait(60)
        self.assertTrue(window._facing_left)
        self.assertTrue(window.travel_to(QPoint(400, 100), "move"))
        self.assertFalse(window._facing_left)
        self.assertIsNone(window._turn_scale)

    def test_left_source_turns_both_ways_and_center_deadband_keeps_facing(self):
        window = self.controller.window
        left_pack = replace(self.pack, pack_id="left-source", source_facing="left")
        window.play(left_pack, self.idle)
        window.face_toward(QPoint(700, 100))
        QTest.qWait(230)
        self.assertFalse(window._facing_left)
        self.assertEqual(window._facing_scale(), -1)
        window.face_toward(QPoint(round(window.x() + window.width() / 2), 100))
        self.assertFalse(window._facing_left)
        window.face_toward(QPoint(0, 100))
        QTest.qWait(230)
        self.assertTrue(window._facing_left)
        self.assertEqual(window._facing_scale(), 1)
