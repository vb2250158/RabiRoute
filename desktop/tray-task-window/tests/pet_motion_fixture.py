from PySide6.QtCore import QByteArray, QBuffer, QIODevice
from PySide6.QtGui import QColor, QPainter, QPixmap
from unittest.mock import patch

from rabiroute_tray.desktop_pet_client import DesktopPetPack, DesktopPetState, LoadedDesktopPetAnimation


def walking_animation(state_name="move", shifts=(0, -4, -8, -4)):
    assets = []
    for shift in shifts:
        pixmap = QPixmap(512, 512)
        pixmap.fill(QColor(0, 0, 0, 0))
        painter = QPainter(pixmap)
        painter.fillRect(190 + shift, 450, 20, 20, QColor("blue"))
        painter.fillRect(302 + shift, 450, 20, 20, QColor("blue"))
        painter.fillRect(20, 30, 20, 20, QColor("red"))
        painter.end()
        data = QByteArray()
        buffer = QBuffer(data)
        buffer.open(QIODevice.OpenModeFlag.WriteOnly)
        pixmap.save(buffer, "PNG")
        assets.append(bytes(data))
    state = DesktopPetState(state_name, "png-sequence", tuple(f"/{i}.png" for i in range(len(shifts))), 12, True)
    pack = DesktopPetPack("sample", "Sample", "sample", 512, 512, 0.5, {state_name: state})
    return pack, LoadedDesktopPetAnimation(state, tuple(assets))


def play_walk(window):
    window.play(*walking_animation())


def play_run(window):
    window.play(*walking_animation("run", (0, -8, -16, -8)))


def advance_walk(window, seconds=0.05):
    with patch("rabiroute_tray.desktop_pet_window.time.monotonic", return_value=window._walk_last_tick + seconds):
        window._advance_travel()


def finish_walk(window):
    for _ in range(10000):
        if not window.travelling:
            return
        advance_walk(window)
    raise AssertionError("Walk did not reach its destination")
