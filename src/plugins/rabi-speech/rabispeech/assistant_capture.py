"""A bounded, in-memory PCM stream borrowed from the resident local microphone."""

from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from uuid import uuid4

import numpy as np


@dataclass(frozen=True)
class AssistantAudio:
    capture_id: str
    start_sample: int
    sample_rate: int
    chunks: AsyncIterator[bytes]
    time_at: Callable[[int], float | None] = lambda _: None


class AssistantCaptureWindow:
    def __init__(self, sample_rate: int, *, history_seconds: int = 30) -> None:
        self.capture_id = uuid4().hex
        self.sample_rate = sample_rate
        self._max_samples = sample_rate * history_seconds
        self._offsets: deque[int] = deque()
        self._frames: dict[int, tuple[bytes, float]] = {}
        self._end = 0
        self._changed = asyncio.Event()
        self._closed = False
        self.readers = 0
        self.realtime = False

    def append(self, audio: np.ndarray, *, muted: bool = False, captured_at: float | None = None) -> None:
        if self._closed or self.readers == 0:
            return
        data = bytes(audio.size * 2) if muted else (np.clip(audio, -1.0, 1.0) * 32_767).astype("<i2").tobytes()
        self._offsets.append(self._end)
        self._frames[self._end] = (data, time.time() if captured_at is None else captured_at)
        self._end += audio.size
        while len(self._offsets) > 1 and self._offsets[1] <= self._end - self._max_samples:
            self._frames.pop(self._offsets.popleft())
        self._changed.set()

    def time_at(self, sample: int) -> float | None:
        offset = next((offset for offset in reversed(self._offsets) if offset <= sample), None)
        if offset is None or sample >= self._end:
            return None
        frame, end_time = self._frames[offset]
        return end_time - (offset + len(frame) // 2 - sample) / self.sample_rate

    def subscribe(self, capture_id: str | None, sample: int | None) -> AssistantAudio:
        if self._closed or self.readers >= 2:
            raise ValueError("ASSISTANT_CAPTURE_UNAVAILABLE")
        if (capture_id is None) != (sample is None):
            raise ValueError("ASSISTANT_CAPTURE_CURSOR_INVALID")
        sample = self._end if sample is None else sample
        oldest = self._offsets[0] if self._offsets else self._end
        if (capture_id is not None and capture_id != self.capture_id) or not oldest <= sample <= self._end:
            raise ValueError("ASSISTANT_CAPTURE_CURSOR_EXPIRED")
        offset = next((offset for offset in reversed(self._offsets) if offset <= sample), sample)
        self.readers += 1
        released = False

        def release() -> None:
            nonlocal released
            if released:
                return
            released = True
            self.readers -= 1
            if self.readers == 0:
                self.close()

        # If the response is abandoned before iteration, return its reservation.
        pending = asyncio.get_running_loop().call_later(5, release)

        def start() -> Callable[[], None]:
            pending.cancel()
            if released:
                raise RuntimeError("ASSISTANT_CAPTURE_RESERVATION_EXPIRED")
            return release

        return AssistantAudio(self.capture_id, sample, self.sample_rate, self._stream(offset, sample, start), self.time_at)

    async def _stream(self, offset: int, sample: int, start: Callable[[], Callable[[], None]]) -> AsyncIterator[bytes]:
        release = start()
        try:
            while not self._closed:
                row = self._frames.get(offset)
                if row is not None:
                    frame, _ = row
                    start = (sample - offset) * 2
                    offset += len(frame) // 2
                    sample = offset
                    if start < len(frame):
                        yield frame[start:]
                    continue
                if offset < self._end:
                    raise RuntimeError("ASSISTANT_CAPTURE_OVERRUN")
                self._changed.clear()
                await self._changed.wait()
        finally:
            release()

    def close(self) -> None:
        self._closed = True
        self._offsets.clear()
        self._frames.clear()
        self._changed.set()
