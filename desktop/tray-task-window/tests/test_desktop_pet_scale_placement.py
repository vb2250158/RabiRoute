import os
import unittest
from dataclasses import replace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QPoint
from PySide6.QtWidgets import QApplication
from pet_motion_fixture import walking_animation
from rabiroute_tray.desktop_pet_client import DesktopPetBinding
from rabiroute_tray.desktop_pet_companion import DesktopPetCompanion
from rabiroute_tray.desktop_pet_controller import DesktopPetController
from rabiroute_tray.desktop_pet_events import DesktopPetEventStream
from rabiroute_tray.desktop_pet_speech import DesktopPetSpeech


class PetScalePlacementTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        targets = [(DesktopPetEventStream, "start"), (DesktopPetEventStream, "stop"),
                   (DesktopPetSpeech, "reconnect"), (DesktopPetCompanion, "reconnect"),
                   (DesktopPetController, "_load_binding"), (DesktopPetController, "_load_dialogue"),
                   (DesktopPetController, "_persist"), (DesktopPetController, "_enqueue_animation_preloads")]
        for owner, name in targets:
            item = patch.object(owner, name)
            item.start()
            self.addCleanup(item.stop)
        item = patch("rabiroute_tray.desktop_pet_window.NativeDrag.for_window", return_value=None)
        item.start()
        self.addCleanup(item.stop)
        self.controller = DesktopPetController("http://127.0.0.1:1", "sample", lambda _: None)
        self.addCleanup(self.controller.close)
        self.window = self.controller.window
        pack, animation = walking_animation()
        animation = replace(animation, state=replace(animation.state, name="idle", loop=True))
        pack = replace(pack, states={"idle": animation.state})
        self.controller._pack = pack
        self.controller._animation_cache = {"idle": animation}
        self.window.show_on_desktop()
        self.controller._fullscreen_timer.stop()
        self.controller.set_state("idle")
        screen = QApplication.primaryScreen()
        self.area = screen.availableGeometry()
        self.binding = DesktopPetBinding(enabled=True, pack_id=pack.pack_id, scale=.5,
                                        placement={"screen": screen.name(), "xRatio": .25, "yRatio": 1})
        self.controller._apply_binding(self.binding)

    def test_scale_refresh_keeps_saved_floor_placement_when_shrinking(self):
        original = self.window.pos()
        for scale in [.75, .5, 1, .25, .5]:
            self.controller._apply_binding(replace(self.binding, scale=scale))
            self.assertEqual(self.window.y(), self.area.bottom() + 1 - self.window.height())
            self.assertEqual(self.window.x(), self.area.left() + round((self.area.width() - self.window.width()) * .25))
        self.assertEqual(self.window.pos(), original)
        self.controller._persist.assert_not_called()

    def test_unrelated_refresh_does_not_snap_a_moving_pet_to_saved_placement(self):
        self.window.move(110, 120)
        self.controller._apply_binding(replace(self.binding, opacity=.8))
        self.assertEqual(self.window.pos(), QPoint(110, 120))

    def unpainted_controller(self):
        controller = DesktopPetController("http://127.0.0.1:1", "sample", lambda _: None)
        self.addCleanup(controller.close)
        controller._pack = self.controller._pack
        controller._animation_cache = self.controller._animation_cache.copy()
        controller.window.show_on_desktop()
        controller._fullscreen_timer.stop()
        controller._apply_binding(self.binding)
        return controller

    def test_first_frame_restores_placement_using_the_real_canvas(self):
        controller = self.unpainted_controller()
        controller.set_state("idle")
        window = controller.window
        self.assertEqual(window.x(), self.area.left() + round((self.area.width() - window.width()) * .25))
        self.assertEqual(window.y(), self.area.bottom() + 1 - window.height())

    def test_late_first_frame_does_not_undo_a_completed_drag(self):
        controller = self.unpainted_controller()
        pack = controller._pack
        controller._pack = None
        controller._drag_started()
        controller.window.move(110, 120)
        controller._drag_finished()
        controller._pack = pack
        controller.set_state("idle")
        self.assertEqual(controller.window.pos(), QPoint(110, 120))


if __name__ == "__main__":
    unittest.main()
