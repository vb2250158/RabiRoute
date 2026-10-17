"""Release velocity and bounded, frame-rate independent desktop-pet flight.

All positions, sizes and velocities use the caller's single desktop coordinate
space (native pixels on Windows). No Qt or persistent settings live here.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field


@dataclass
class ReleaseTrail:
    samples: deque = field(default_factory=lambda: deque(maxlen=64))

    def add(self, now: float, cursor: tuple[float, float]) -> None:
        if self.samples and now <= self.samples[-1][0]:
            return
        self.samples.append((now, *cursor))
        while self.samples and now - self.samples[0][0] > .2:
            self.samples.popleft()

    def velocity(self, now: float, scale: float) -> tuple[float, float] | None:
        rows = [row for row in self.samples if 0 <= now - row[0] <= .1]
        if len(rows) < 2 or rows[-1][0] - rows[0][0] < .02:
            return None
        last = rows[-1]
        moved = next((row for row in reversed(rows) if math.hypot(row[1] - last[1], row[2] - last[2]) > 2 * scale), None)
        if moved is None or now - moved[0] > .065:
            return None
        # Least squares uses a time window, rather than mouse-event frequency.
        mean_t = sum(row[0] - now for row in rows) / len(rows)
        variance = sum((row[0] - now - mean_t) ** 2 for row in rows)
        vx, vy = (sum((row[0] - now - mean_t) * row[axis] for row in rows) / variance for axis in (1, 2))
        speed = math.hypot(vx, vy)
        if speed < 500 * scale:
            return None
        capped = 3600 * scale * (1 - math.exp(-speed / (3600 * scale)))
        return vx * capped / speed, vy * capped / speed


@dataclass(frozen=True)
class DisplayArea:
    panel: tuple[float, float, float, float]  # left, top, right, bottom, exclusive
    work: tuple[float, float, float, float]

    def contains(self, x: float, y: float) -> bool:
        left, top, right, bottom = self.panel
        return left <= x < right and top <= y < bottom

    def distance(self, x: float, y: float) -> float:
        left, top, right, bottom = self.panel
        return max(left - x, 0, x - right) ** 2 + max(top - y, 0, y - bottom) ** 2


@dataclass
class PetFlight:
    x: float
    y: float
    vx: float
    vy: float
    at_rest: bool = False

    def advance(self, elapsed: float, size: tuple[float, float], displays: list[DisplayArea]) -> tuple[int, int]:
        if not displays:
            self.at_rest = True
            return round(self.x), round(self.y)
        width, height = size
        scale = max(.1, width / 256)
        remaining = max(0, min(.05, elapsed))
        # Small substeps cannot tunnel across a narrow panel or a corner hole.
        while remaining > 1e-9 and not self.at_rest:
            dt = min(1 / 240, remaining)
            remaining -= dt
            self.vy += 1400 * scale * dt
            self.vx *= math.exp(-.12 * dt)
            self.x += self.vx * dt
            self.y += self.vy * dt
            for axis in (0, 1):
                cx, cy = self.x + width / 2, self.y + height / 2
                display = min(displays, key=lambda area: area.distance(cx, cy))
                # At a seam prefer the panel actually containing the center.
                display = next((area for area in displays if area.contains(cx, cy)), display)
                left, top, right, bottom = display.work
                pl, pt, pr, pb = display.panel
                if axis == 0:
                    low, high = left, max(left, right - width)
                    value, velocity = self.x, self.vx
                    probe = (pl - 1, cy) if value < low else (pr, cy)
                else:
                    low, high = top, max(top, bottom - height)
                    value, velocity = self.y, self.vy
                    probe = (cx, pt - 1) if value < low else (cx, pb)
                if low <= value < high or (axis == 0 and value == high):
                    continue
                # Full panels determine seams; work areas determine the floor.
                if any(area is not display and area.contains(*probe) for area in displays):
                    continue
                value = low if value < low else high
                velocity = abs(velocity) * .58 if value == low else -abs(velocity) * .58
                if axis == 0:
                    self.x, self.vx = value, velocity
                else:
                    self.y = value
                    if value == high:
                        self.vx *= math.exp(-5 * dt)
                        self.vy = 0 if abs(velocity) < 45 * scale else velocity
                        if self.vy == 0 and abs(self.vx) < 15 * scale:
                            self.vx = 0
                            self.at_rest = True
                    else:
                        self.vy = velocity
        return round(self.x), round(self.y)
