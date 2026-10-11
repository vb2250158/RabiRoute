import os
import unittest
from dataclasses import replace
from unittest.mock import MagicMock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtWidgets import QApplication
from rabiroute_tray.desktop_pet_fullscreen import _foreground_fullscreen, covers_monitor
from rabiroute_tray.desktop_pet_client import DesktopPetBinding
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_speech import DesktopPetSpeech
from pet_motion_fixture import walking_animation


class FullscreenDetectionTest(unittest.TestCase):
    def api(self, *, maximized=False, style=0, window=(0, 0, 1920, 1080),
            pet_monitor=11, window_class="Window"):
        api = MagicMock()
        api.GetForegroundWindow.return_value = 0x100000001
        api.IsWindowVisible.return_value = True
        api.IsIconic.return_value = False
        api.IsZoomed.return_value = maximized
        api.GetWindowLongPtrW.return_value = style
        def class_name(_hwnd, buffer, _length):
            buffer.value = window_class
            return len(window_class)
        api.GetClassNameW.side_effect = class_name
        def rect(_hwnd, pointer):
            pointer._obj.left, pointer._obj.top, pointer._obj.right, pointer._obj.bottom = window
            return True
        api.GetWindowRect.side_effect = rect
        api.MonitorFromWindow.side_effect = lambda hwnd, _: pet_monitor if hwnd == 9 else 11
        def info(_monitor, pointer):
            pointer._obj.rcMonitor.left, pointer._obj.rcMonitor.top = 0, 0
            pointer._obj.rcMonitor.right, pointer._obj.rcMonitor.bottom = 1920, 1080
            return True
        api.GetMonitorInfoW.side_effect = info
        return api

    def test_maximized_window_covering_monitor_is_not_fullscreen(self):
        self.assertFalse(_foreground_fullscreen(self.api(maximized=True, window=(-8, -8, 1928, 1088)), 9))

    def test_framed_window_with_monitor_dimensions_is_not_fullscreen(self):
        self.assertFalse(_foreground_fullscreen(self.api(style=0x00C00000), 9))

    def test_true_borderless_fullscreen_is_detected_on_pet_monitor(self):
        self.assertTrue(_foreground_fullscreen(self.api(), 9))

    def test_fullscreen_on_another_monitor_does_not_hide_pet(self):
        self.assertFalse(_foreground_fullscreen(self.api(pet_monitor=22), 9))

    def test_desktop_surface_and_oversized_window_are_not_fullscreen(self):
        self.assertFalse(_foreground_fullscreen(self.api(window_class="WorkerW"), 9))
        self.assertFalse(_foreground_fullscreen(self.api(window=(-100, 0, 2020, 1080)), 9))
        self.assertTrue(covers_monitor((-1, 1, 1921, 1079), (0, 0, 1920, 1080)))

    def test_unavailable_or_minimized_window_does_not_hide_pet(self):
        api = self.api()
        api.IsIconic.return_value = True
        self.assertFalse(_foreground_fullscreen(api, 9))
        api.IsIconic.return_value = False
        api.GetWindowRect.return_value = False
        api.GetWindowRect.side_effect = None
        self.assertFalse(_foreground_fullscreen(api, 9))


class FocusVisibilityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.patches = [patch.object(DesktopPetEventStream, "start"),
                        patch.object(DesktopPetEventStream, "stop"),
                        patch.object(DesktopPetSpeech, "reconnect"),
                        patch.object(DesktopPetController, "_load_binding"),
                        patch.object(DesktopPetController, "_persist"),
                        patch.object(DesktopPetController, "_load_catalog"),
                        patch.object(DesktopPetController, "_enqueue_animation_preloads")]
        for item in self.patches: item.start()
        self.controller = DesktopPetController("http://127.0.0.1:1", "sample", lambda _: None)
        pack, move = walking_animation()
        idle = replace(move, state=replace(move.state, name="idle"))
        talking = replace(move, state=replace(move.state, name="talking"))
        self.pack = replace(pack, states={"idle": idle.state, "talking": talking.state, "move": move.state})
        self.binding = DesktopPetBinding(enabled=True, pack_id=self.pack.pack_id)
        self.controller._pack = self.pack
        self.controller._binding_snapshot = self.binding
        self.controller._preferred_pack_id = self.pack.pack_id
        self.controller._animation_cache = {"idle": idle, "talking": talking, "move": move}
        self.controller.window.show_on_desktop()
        self.controller.set_state("idle")
        self.controller._fullscreen_timer.stop()

    def tearDown(self):
        self.controller.close()
        for item in reversed(self.patches): item.stop()

    def focus(self, fullscreen):
        with patch("rabiroute_tray.desktop_pet_controller.is_foreground_fullscreen", return_value=fullscreen) as detector:
            self.controller._reconcile_fullscreen_visibility()
            detector.assert_called_once_with(int(self.controller.window.winId()))

    def test_normal_focus_changes_keep_pet_visible_and_playback_position(self):
        self.controller.window._advance_png_frame()
        for _ in range(4): self.focus(False)
        self.assertTrue(self.controller.visible)
        self.assertEqual(self.controller.window._png_index, 1)

    def test_leaving_fullscreen_restores_live_context_instead_of_finished_speech(self):
        self.controller._speech_changed({"status": "playing"})
        self.focus(True)
        self.assertFalse(self.controller.visible)
        self.controller._speech_changed({"status": "completed"})
        self.focus(False)
        self.assertTrue(self.controller.visible)
        self.assertEqual(self.controller.window.active_state, "idle")
        self.assertTrue(self.controller.window.animation_running)

    def test_disabled_pet_does_not_reappear_when_focus_leaves_fullscreen(self):
        self.focus(True)
        self.controller._apply_binding(replace(self.binding, enabled=False))
        self.focus(False)
        self.assertFalse(self.controller.visible)

    def test_binding_refresh_does_not_flash_pet_while_fullscreen(self):
        self.focus(True)
        self.controller._apply_binding(self.binding, force=True)
        self.assertFalse(self.controller.visible)
        self.focus(False)
        self.assertTrue(self.controller.visible)

    def test_changed_pack_loads_when_fullscreen_ends(self):
        self.focus(True)
        self.controller._apply_binding(replace(self.binding, pack_id="other"))
        self.assertIsNone(self.controller._pack)
        with patch.object(self.controller, "_load_catalog") as load:
            self.focus(False)
            load.assert_called_once()
        self.assertTrue(self.controller.visible)


if __name__ == "__main__":
    unittest.main()
