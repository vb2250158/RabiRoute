from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

TRAY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, TRAY_ROOT)

from PySide6.QtCore import QEvent, QObject, QPoint, QPointF, QRect, QSize, Qt, Signal  # noqa: E402
from PySide6.QtGui import QColor, QImage, QKeyEvent, QMouseEvent  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from rabiroute_tray.manager_client import DesktopSettings  # noqa: E402
from rabiroute_tray.system_selection import SelectionDeliveryTarget  # noqa: E402
from rabiroute_tray.system_screenshot import (  # noqa: E402
    ScreenshotCaptureOverlay,
    ScreenshotComposer,
    PinnedScreenshotStore,
    ScreenshotHistory,
    ScreenshotRegionStore,
    ScreenshotSettings,
    SystemScreenshotController,
    parse_hotkey,
    save_screenshot_image,
    screenshot_history,
)


class SystemScreenshotTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_hotkey_parser_accepts_common_windows_shortcuts(self) -> None:
        modifiers, key = parse_hotkey("Ctrl + Shift + S") or (0, 0)
        self.assertEqual(modifiers & 0x0002, 0x0002)
        self.assertEqual(modifiers & 0x0004, 0x0004)
        self.assertEqual(key, ord("S"))

    def test_hotkey_parser_accepts_function_key(self) -> None:
        modifiers, key = parse_hotkey("Alt+F8") or (0, 0)
        self.assertEqual(modifiers & 0x0001, 0x0001)
        self.assertEqual(key, 0x77)

    def test_hotkey_parser_accepts_unmodified_function_key(self) -> None:
        modifiers, key = parse_hotkey("F1") or (0, 0)
        self.assertEqual(modifiers & 0x4000, 0x4000)
        self.assertEqual(key, 0x70)

    def test_hotkey_parser_rejects_invalid_unmodified_or_incomplete_shortcuts(self) -> None:
        self.assertIsNone(parse_hotkey(""))
        self.assertIsNone(parse_hotkey("S"))
        self.assertIsNone(parse_hotkey("Ctrl+Shift"))
        self.assertIsNone(parse_hotkey("Ctrl+Shift+S+T"))

    def test_history_moves_from_current_screen_to_previous_screen(self) -> None:
        current = Path("C:/tmp/current-screen.png")
        previous = Path("C:/tmp/previous-screen.png")
        history = ScreenshotHistory((current, previous))

        self.assertEqual(history.current, current)
        self.assertEqual(history.move(1).current, previous)
        self.assertEqual(history.move(1).move(1).current, previous)
        self.assertEqual(history.move(-1).current, current)

    def test_saved_screenshots_are_ordered_with_current_screen_first(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = QImage(8, 6, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.red)
            previous = save_screenshot_image(root, image)
            time.sleep(0.002)
            current = save_screenshot_image(root, image)

            history = screenshot_history(current)

            self.assertEqual(history.current, current)
            self.assertEqual(history.move(1).current, previous)

    def test_overlay_copies_the_selected_area(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            emitted: list[QImage] = []
            overlay.copy_requested.connect(emitted.append)

            overlay._copy()

            self.assertEqual(len(emitted), 1)
            self.assertEqual(emitted[0].size().width(), 30)
            self.assertEqual(emitted[0].size().height(), 20)
            overlay.close()

    def test_pending_capture_overlay_is_transparent(self) -> None:
        overlay = ScreenshotCaptureOverlay(ScreenshotHistory(()), QRect(0, 0, 100, 60))

        self.assertTrue(overlay.testAttribute(Qt.WidgetAttribute.WA_TranslucentBackground))
        overlay.close()

    def test_selection_dims_only_the_area_outside_the_selection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.white)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(40, 40, 30, 20)
            rendered = QImage(100, 60, QImage.Format.Format_ARGB32)
            rendered.fill(Qt.GlobalColor.black)

            overlay.render(rendered)

            self.assertEqual(rendered.pixelColor(55, 55), QColor(Qt.GlobalColor.white))
            self.assertLess(rendered.pixelColor(90, 55).red(), 200)
            overlay.close()

    def test_dragging_only_creates_a_selection_until_it_is_confirmed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            copied: list[QImage] = []
            overlay.copy_requested.connect(copied.append)

            overlay._complete_selection()
            self.assertEqual(copied, [])

            QApplication.sendEvent(overlay, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_Return, Qt.KeyboardModifier.NoModifier))
            self.assertEqual(len(copied), 1)

    def test_f2_confirms_and_sends_the_selected_area(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            copied: list[QImage] = []
            sent: list[QImage] = []
            overlay.copy_requested.connect(copied.append)
            overlay.send_requested.connect(sent.append)

            QApplication.sendEvent(overlay, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_F2, Qt.KeyboardModifier.NoModifier))

            self.assertEqual(len(copied), 1)
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent[0].size(), QSize(30, 20))

    def test_selection_action_waits_for_the_capture_file_then_crops(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory(()), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            emitted: list[QImage] = []
            overlay.copy_requested.connect(emitted.append)

            overlay._copy()
            self.assertEqual(emitted, [])
            self.assertEqual(overlay._pending_action, "copy")

            overlay.set_capture_image(image)
            capture = save_screenshot_image(root, image, "capture")
            overlay.complete_capture(screenshot_history(capture), capture)

            self.assertEqual(len(emitted), 1)
            self.assertEqual(emitted[0].size(), QSize(30, 20))
            self.assertEqual(list((root / ".rabiroute-message-images").glob("capture-*.png")), [])
            self.assertEqual(len(list((root / ".rabiroute-message-images").glob("screenshot-*.png"))), 1)
            overlay.close()

    def test_capture_overlay_is_created_before_async_capture_starts(self) -> None:
        controller = SystemScreenshotController(
            None,  # type: ignore[arg-type]
            Path(tempfile.gettempdir()),
            lambda: [],
            lambda _title, _message, _is_error: None,
        )
        controller._settings = ScreenshotSettings(enabled=True)
        with patch("rabiroute_tray.system_screenshot.start_qt_task", return_value=None) as start_task:
            controller._capture_requested()

        self.assertIsNotNone(controller._capture_overlay)
        self.assertEqual(start_task.call_count, 1)
        self.assertEqual(start_task.call_args.args[0].__name__, "capture_desktop_image_async")
        controller.stop()

    def test_existing_selection_can_be_dragged_without_changing_its_size(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(0, 0, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)

            QApplication.sendEvent(
                overlay,
                QMouseEvent(
                    QEvent.Type.MouseButtonPress,
                    QPointF(15, 12),
                    QPointF(15, 12),
                    Qt.MouseButton.LeftButton,
                    Qt.MouseButton.LeftButton,
                    Qt.KeyboardModifier.NoModifier,
                ),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(
                    QEvent.Type.MouseMove,
                    QPointF(45, 32),
                    QPointF(45, 32),
                    Qt.MouseButton.NoButton,
                    Qt.MouseButton.LeftButton,
                    Qt.KeyboardModifier.NoModifier,
                ),
            )
            QApplication.sendEvent(
                overlay,
                QMouseEvent(
                    QEvent.Type.MouseButtonRelease,
                    QPointF(45, 32),
                    QPointF(45, 32),
                    Qt.MouseButton.LeftButton,
                    Qt.MouseButton.NoButton,
                    Qt.KeyboardModifier.NoModifier,
                ),
            )

            self.assertEqual(overlay._selection, QRect(40, 28, 30, 20))
            overlay.close()

    def test_canceled_capture_is_not_kept_in_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            transient = save_screenshot_image(root, image, "capture")
            overlay = ScreenshotCaptureOverlay(
                ScreenshotHistory((transient,)),
                QRect(0, 0, 100, 60),
                transient_paths=(transient,),
            )

            overlay.close()

            self.assertFalse(transient.exists())
            self.assertEqual(list((root / ".rabiroute-message-images").glob("screenshot-*.png")), [])

    def test_confirmed_capture_promotes_the_current_image_into_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            transient = save_screenshot_image(root, image, "capture")
            region_store = ScreenshotRegionStore(root)
            overlay = ScreenshotCaptureOverlay(
                ScreenshotHistory((transient,)),
                QRect(0, 0, 100, 60),
                region_store,
                (transient,),
            )
            overlay._selection = QRect(10, 8, 30, 20)
            copied: list[QImage] = []
            overlay.copy_requested.connect(copied.append)

            overlay._copy()

            saved = list((root / ".rabiroute-message-images").glob("screenshot-*.png"))
            self.assertEqual(len(copied), 1)
            self.assertFalse(transient.exists())
            self.assertEqual(len(saved), 1)
            self.assertEqual(region_store.get(saved[0]), QRect(10, 8, 30, 20))

    def test_overlay_shortcuts_select_full_screen_and_switch_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = root / "current.png"
            previous = root / "previous.png"
            for path, color in ((current, Qt.GlobalColor.red), (previous, Qt.GlobalColor.green)):
                image = QImage(100, 60, QImage.Format.Format_ARGB32)
                image.fill(color)
                self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((current, previous)), QRect(0, 0, 100, 60))

            QApplication.sendEvent(overlay, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_A, Qt.KeyboardModifier.ControlModifier))
            self.assertEqual(overlay._selection, QRect(0, 0, 100, 60))
            QApplication.sendEvent(overlay, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_Comma, Qt.KeyboardModifier.ShiftModifier, "<"))
            self.assertEqual(overlay._history.index, 1)
            QApplication.sendEvent(overlay, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_Period, Qt.KeyboardModifier.ShiftModifier, ">"))
            self.assertEqual(overlay._history.index, 0)
            overlay.close()

    def test_region_history_restores_the_previous_area_for_a_saved_screen(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            store = ScreenshotRegionStore(root)
            source_rect = QRect(10, 8, 30, 20)
            store.remember(path, source_rect)

            overlay = ScreenshotCaptureOverlay(
                ScreenshotHistory((path,)),
                QRect(0, 0, 100, 60),
                store,
            )

            self.assertEqual(overlay._selection, source_rect)
            overlay.close()

    def test_pin_uses_the_selected_screen_position(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(120, 80, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            emitted: list[tuple[QImage, QRect]] = []
            overlay.pin_requested.connect(lambda selection, origin: emitted.append((selection, origin)))

            overlay._pin()

            self.assertEqual(len(emitted), 1)
            self.assertEqual(emitted[0][0].size(), QSize(30, 20))
            self.assertEqual(emitted[0][1].topLeft(), overlay.mapToGlobal(QPoint(10, 8)))
            self.assertEqual(emitted[0][1].size(), QSize(30, 20))

    def test_pin_confirmation_can_skip_auto_copy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(
                ScreenshotHistory((path,)),
                QRect(0, 0, 100, 60),
                auto_copy_on_confirm=False,
            )
            overlay._selection = QRect(10, 8, 30, 20)
            copied: list[QImage] = []
            pinned: list[tuple[QImage, QRect]] = []
            overlay.copy_requested.connect(copied.append)
            overlay.pin_requested.connect(lambda selection, origin: pinned.append((selection, origin)))

            overlay.pin_selection()

            self.assertEqual(copied, [])
            self.assertEqual(len(pinned), 1)

    def test_pin_shortcut_pins_the_open_capture_selection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            image = QImage(100, 60, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.blue)
            self.assertTrue(image.save(str(path), "PNG"))
            overlay = ScreenshotCaptureOverlay(ScreenshotHistory((path,)), QRect(120, 80, 100, 60))
            overlay._selection = QRect(10, 8, 30, 20)
            controller = SystemScreenshotController(
                None,  # type: ignore[arg-type]
                Path(directory),
                lambda: [],
                lambda _title, _message, _is_error: None,
            )
            controller._settings = ScreenshotSettings(enabled=True)
            controller._capture_overlay = overlay
            emitted: list[tuple[QImage, QRect]] = []
            copied: list[QImage] = []
            overlay.pin_requested.connect(lambda selection, origin: emitted.append((selection, origin)))
            overlay.copy_requested.connect(copied.append)
            clipboard = QImage(24, 18, QImage.Format.Format_ARGB32)
            clipboard.fill(Qt.GlobalColor.red)
            QApplication.clipboard().setImage(clipboard)

            controller._pin_requested()

            self.assertEqual(len(emitted), 1)
            self.assertEqual(len(copied), 1)
            self.assertEqual(copied[0].size(), QSize(30, 20))
            self.assertEqual(emitted[0][0].size(), QSize(30, 20))
            self.assertEqual(emitted[0][1].topLeft(), overlay.mapToGlobal(QPoint(10, 8)))
            self.assertEqual(emitted[0][1].size(), QSize(30, 20))
            overlay.deleteLater()
            QApplication.processEvents()

    def test_pinned_store_persists_geometry_opacity_and_image(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = QImage(24, 18, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.yellow)
            store = PinnedScreenshotStore(root)
            record = store.create(image, QPoint(120, 80), QSize(24, 18), 0.8)

            loaded = store.load()
            self.assertEqual(len(loaded), 1)
            self.assertEqual(loaded[0].pin_id, record.pin_id)
            self.assertEqual(loaded[0].image_path.name, f"{record.pin_id}.png")
            self.assertEqual((loaded[0].x, loaded[0].y, loaded[0].width, loaded[0].height), (120, 80, 24, 18))
            self.assertAlmostEqual(loaded[0].opacity, 0.8)

            store.update(record.pin_id, QPoint(140, 90), QSize(30, 20), 0.6)
            updated = store.load()[0]
            self.assertEqual((updated.x, updated.y, updated.width, updated.height), (140, 90, 30, 20))
            self.assertAlmostEqual(updated.opacity, 0.6)

            store.delete(record.pin_id)
            self.assertEqual(store.load(), ())
            self.assertFalse(record.image_path.exists())

    def test_controller_restores_pinned_image_without_deleting_it_on_stop(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = QImage(24, 18, QImage.Format.Format_ARGB32)
            image.fill(Qt.GlobalColor.yellow)
            origin = QRect(120, 80, 24, 18)
            controller = SystemScreenshotController(
                None,  # type: ignore[arg-type]
                root,
                lambda: [],
                lambda _title, _message, _is_error: None,
            )

            controller._pin_image(image, origin)
            self.assertEqual(len(controller._pins), 1)
            controller.stop()
            self.assertEqual(len(PinnedScreenshotStore(root).load()), 1)

            restored = SystemScreenshotController(
                None,  # type: ignore[arg-type]
                root,
                lambda: [],
                lambda _title, _message, _is_error: None,
            )
            restored._restore_pinned_images()
            self.assertEqual(len(restored._pins), 1)
            pin = next(iter(restored._pins))
            self.assertEqual(pin.pos(), origin.topLeft())
            self.assertEqual(pin.size(), origin.size())

            pin._set_opacity(0.6)
            saved = PinnedScreenshotStore(root).load()[0]
            self.assertAlmostEqual(saved.opacity, 0.6)
            pin.close()
            QApplication.processEvents()
            self.assertEqual(PinnedScreenshotStore(root).load(), ())
            restored.stop()

    def test_settings_refresh_retries_after_a_transient_manager_error(self) -> None:
        class RetryManager:
            def __init__(self) -> None:
                self.calls = 0

            def desktop_settings(self) -> DesktopSettings:
                self.calls += 1
                if self.calls == 1:
                    raise OSError("Manager is starting")
                return DesktopSettings(True, "F1", "F3", False)

        class FakeHotkey(QObject):
            activated = Signal()

            def __init__(self) -> None:
                super().__init__()
                self.configurations: list[tuple[bool, str]] = []
                self.stopped = False

            def configure(self, enabled: bool, shortcut: str) -> None:
                self.configurations.append((enabled, shortcut))

            def stop(self) -> None:
                self.stopped = True

        with tempfile.TemporaryDirectory() as directory, patch("rabiroute_tray.system_screenshot.sync_startup_shortcut"):
            manager = RetryManager()
            screenshot_hotkey = FakeHotkey()
            clipboard_hotkey = FakeHotkey()
            controller = SystemScreenshotController(
                manager,  # type: ignore[arg-type]
                Path(directory),
                lambda: [],
                lambda _title, _message, _is_error: None,
                hotkey=screenshot_hotkey,  # type: ignore[arg-type]
                clipboard_hotkey=clipboard_hotkey,  # type: ignore[arg-type]
            )
            controller._settings_retry_delay_ms = 1
            controller.start()
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and not screenshot_hotkey.configurations:
                QApplication.processEvents()
                time.sleep(0.01)

            self.assertGreaterEqual(manager.calls, 2)
            self.assertEqual(screenshot_hotkey.configurations, [(True, "F1")])
            self.assertEqual(clipboard_hotkey.configurations, [(True, "F3")])
            controller.stop()
            self.assertTrue(screenshot_hotkey.stopped)
            self.assertTrue(clipboard_hotkey.stopped)

    def test_clipboard_image_creates_a_pinned_window(self) -> None:
        image = QImage(24, 18, QImage.Format.Format_ARGB32)
        image.fill(Qt.GlobalColor.yellow)
        QApplication.clipboard().setImage(image)
        notifications: list[tuple[str, str, bool]] = []
        controller = SystemScreenshotController(
            None,  # type: ignore[arg-type]
            Path(tempfile.gettempdir()),
            lambda: [],
            lambda title, message, is_error: notifications.append((title, message, is_error)),
        )
        controller._settings = ScreenshotSettings(enabled=True)

        controller._pin_clipboard_image()

        self.assertEqual(len(controller._pins), 1)
        self.assertEqual(notifications, [])
        controller.stop()
    def test_composer_emits_entered_text_and_selected_persona(self) -> None:
        composer = ScreenshotComposer(
            Path("C:/tmp/rabiroute-screenshot.png"),
            [
                SelectionDeliveryTarget("route-a", "人格 A"),
                SelectionDeliveryTarget("route-b", "人格 B"),
            ],
        )
        emitted: list[tuple[str, str]] = []
        composer.send_requested.connect(lambda gateway_id, text: emitted.append((gateway_id, text)))
        composer._target.setCurrentIndex(1)
        composer._text.setPlainText("  请查看截图中的按钮布局。  ")

        composer._send()

        self.assertEqual(emitted, [("route-b", "请查看截图中的按钮布局。")])
        composer.close()


if __name__ == "__main__":
    unittest.main()
