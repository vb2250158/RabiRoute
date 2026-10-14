"""Stride calibration derived from rendered soles and authored source facing."""
from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import median


@dataclass(frozen=True)
class SoleFrame:
    left: tuple[float, float] | None
    right: tuple[float, float] | None
    occupied_height: float = 0.0

    @property
    def floor(self) -> float:
        return max(point[1] for point in (self.left, self.right) if point is not None)


@dataclass(frozen=True)
class WalkingGait:
    # Index i describes the transition from frame i-1 to frame i, including wrap.
    advances: tuple[float, ...]
    floor_offsets: tuple[float, ...]

    @property
    def cycle_distance(self) -> float:
        return sum(self.advances)

    def scaled(self, horizontal: float, vertical: float) -> WalkingGait:
        return WalkingGait(tuple(value * horizontal for value in self.advances),
                           tuple(value * vertical for value in self.floor_offsets))


def walking_gait(soles: tuple[SoleFrame, ...], source_facing: str = "right") -> WalkingGait | None:
    """Use only a sole that stays in contact across both displayed frames.

    Its backward horizontal sweep gives forward root distance. A support change
    contributes no jump, and an unchanged pose contributes no movement. Front
    view art is a cadence approximation, not directional foot-locking geometry.
    Measurements use a stable reference raster; the renderer scales the result
    into logical desktop pixels instead of measuring resampling noise again.
    """
    if len(soles) < 2 or any(frame.left is None and frame.right is None for frame in soles):
        return None
    floors = tuple(frame.floor for frame in soles)
    floor = median(floors)
    spreads = [abs(frame.right[0] - frame.left[0]) for frame in soles
               if frame.left is not None and frame.right is not None]
    if not spreads:
        return None
    foot_span = median(spreads)
    if foot_span <= 1:
        return None
    heights = [frame.occupied_height for frame in soles if frame.occupied_height > 0]
    contact_tolerance = max(0.5, foot_span * 0.04, median(heights) * 0.015 if heights else 0)
    # Close/crossed feet shrink the median separation. That must not reject the
    # actual stride of the planted shoe when the feet are farther apart.
    maximum_sweep = max(spreads) / 2
    advances: list[float] = []
    for index, current in enumerate(soles):
        previous = soles[index - 1]
        sweeps = []
        for before, after in ((previous.left, current.left), (previous.right, current.right)):
            if (before is not None and after is not None
                    and previous.floor - before[1] <= contact_tolerance
                    and current.floor - after[1] <= contact_tolerance):
                sweep = before[0] - after[0]
                if source_facing == "left":
                    sweep = -sweep
                # Reject segmentation switches and subpixel anti-aliasing jitter.
                if 0.5 <= sweep <= maximum_sweep:
                    sweeps.append(sweep)
        advances.append(max(sweeps, default=0.0))
    if sum(advances) <= 1 or not all(math.isfinite(value) for value in advances):
        return None
    return WalkingGait(tuple(advances), tuple(floor - value for value in floors))


def running_gait(soles: tuple[SoleFrame, ...], source_facing: str = "right") -> WalkingGait | None:
    """Calibrate the run's own planted-sole sweeps without flattening its airborne frames."""
    gait = walking_gait(soles, source_facing)
    if gait is None:
        return None
    ground = max(frame.floor for frame in soles)
    spreads = [abs(frame.right[0] - frame.left[0]) for frame in soles
               if frame.left is not None and frame.right is not None]
    heights = [frame.occupied_height for frame in soles if frame.occupied_height > 0]
    tolerance = max(0.5, median(spreads) * 0.04, median(heights) * 0.015 if heights else 0)
    advances = tuple(value if ground - soles[index - 1].floor <= tolerance
                     and ground - soles[index].floor <= tolerance else 0.0
                     for index, value in enumerate(gait.advances))
    if sum(advances) <= 1:
        return None
    return WalkingGait(advances, (0.0,) * len(soles))
