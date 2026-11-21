from __future__ import annotations

from dataclasses import dataclass, replace
import math

from PIL import Image
from PySide6.QtCore import QByteArray, QBuffer, QIODevice, QRect, QSize, Qt
from PySide6.QtGui import QImage, QImageReader

from .desktop_pet_client import DesktopPetPack, LoadedDesktopPetAnimation
from .desktop_pet_gait import SoleFrame, WalkingGait, running_gait, walking_gait


@dataclass(frozen=True)
class DesktopPetFrames:
    target: QSize
    images: tuple[QImage, ...]
    delays: tuple[int, ...]
    bounds: QRect
    gait: WalkingGait | None = None


def decode_desktop_pet_frames(animation: LoadedDesktopPetAnimation, target: QSize) -> DesktopPetFrames:
    """Decode and resize off the GUI thread. Only the window turns these into pixmaps."""
    images: list[QImage] = []
    delays: list[int] = []
    bounds = QRect()

    def append(image: QImage) -> bool:
        nonlocal bounds
        if image.isNull():
            return False
        if image.size() != target:
            image = image.scaled(target, Qt.AspectRatioMode.KeepAspectRatio,
                                 Qt.TransformationMode.SmoothTransformation)
        image = image.convertToFormat(QImage.Format.Format_ARGB32_Premultiplied)
        images.append(image)
        alpha = image.convertToFormat(QImage.Format.Format_Alpha8)
        mask = Image.frombytes("L", (alpha.width(), alpha.height()), bytes(alpha.constBits()),
                               "raw", "L", alpha.bytesPerLine(), 1)
        extent = mask.getbbox()
        if extent:
            left, top, right, bottom = extent
            bounds = bounds.united(QRect(left, top, right - left, bottom - top))
        return True

    if animation.state.kind in {"gif", "webp"} and animation.assets:
        data = QBuffer()
        data.setData(QByteArray(animation.assets[0]))
        data.open(QIODevice.OpenModeFlag.ReadOnly)
        reader = QImageReader(data, animation.state.kind.encode("ascii"))
        count = reader.imageCount()
        if 0 < count <= 600:
            for _ in range(count):
                if not append(reader.read()):
                    images.clear()
                    break
                delays.append(max(10, reader.nextImageDelay()))
        data.close()
    elif animation.state.kind == "png-sequence":
        for payload in animation.assets:
            if not append(QImage.fromData(payload, "PNG")):
                images.clear()
                break

    return DesktopPetFrames(target, tuple(images), tuple(delays), bounds)



def measure_sprite_soles(image: QImage) -> SoleFrame:
    image = image.convertToFormat(QImage.Format.Format_RGBA8888)
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



def prepare_desktop_pet_frames(pack: DesktopPetPack, animation: LoadedDesktopPetAnimation, target: QSize) -> DesktopPetFrames:
    frames = decode_desktop_pet_frames(animation, target)
    if animation.state.name not in {"move", "run"} or not frames.images:
        return frames
    reference_size = QSize(pack.canvas_width, pack.canvas_height).scaled(256, 256, Qt.AspectRatioMode.KeepAspectRatio)
    reference = frames if reference_size == target else decode_desktop_pet_frames(animation, reference_size)
    if not reference.images:
        return frames
    calibrate = running_gait if animation.state.name == "run" else walking_gait
    gait = calibrate(tuple(measure_sprite_soles(image) for image in reference.images), pack.source_facing)
    if gait is None:
        return frames
    return replace(frames, gait=gait.scaled(frames.images[0].width() / reference.images[0].width(),
                                            frames.images[0].height() / reference.images[0].height()))
