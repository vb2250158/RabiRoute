"""Stride calibration derived from rendered soles and authored source facing."""
from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import median


@dataclass(frozen=True)
class SoleFrame:
    left: tuple[float, float] | None
    right: tuple[float, float] | None

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


def walking_gait(soles: tuple[SoleFrame, ...], source_facing: str = "right") -> WalkingGait | None:
    """Use only a sole that stays in contact across both displayed frames.

    Its backward horizontal sweep gives forward root distance. A support change
    contributes no jump, and an unchanged pose contributes no movement. Front
    view art is a cadence approximation, not directional foot-locking geometry.
    All measurements are in rendered logical pixels, so resizing scales stride.
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
    contact_tolerance = max(0.5, foot_span * 0.04)
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
                if 0.5 <= sweep <= foot_span / 2:
                    sweeps.append(sweep)
        advances.append(max(sweeps, default=0.0))
    if sum(advances) <= 1 or not all(math.isfinite(value) for value in advances):
        return None
    return WalkingGait(tuple(advances), tuple(floor - value for value in floors))
