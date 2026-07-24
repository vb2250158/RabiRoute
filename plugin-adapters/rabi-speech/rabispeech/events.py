from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any


def _frame(event_type: str, data: object) -> str:
    safe_type = "".join(character if character.isalnum() or character in "_.:-" else "_" for character in event_type) or "message"
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {safe_type}\ndata: {payload}\n\n"


@dataclass(eq=False)
class _Subscriber:
    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue[tuple[str, object]]


class SpeechEventHub:
    """Thread-safe, bounded event fanout for the loopback control UI."""

    def __init__(self, queue_size: int = 32) -> None:
        self._queue_size = max(4, int(queue_size))
        self._subscribers: set[_Subscriber] = set()

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def publish(self, event_type: str, data: object) -> None:
        for subscriber in tuple(self._subscribers):
            subscriber.loop.call_soon_threadsafe(self._enqueue, subscriber, event_type, data)

    @staticmethod
    def _enqueue(subscriber: _Subscriber, event_type: str, data: object) -> None:
        if subscriber.queue.full():
            try:
                subscriber.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            subscriber.queue.put_nowait((event_type, data))
        except asyncio.QueueFull:
            pass

    async def stream(self) -> AsyncIterator[str]:
        subscriber = _Subscriber(asyncio.get_running_loop(), asyncio.Queue(maxsize=self._queue_size))
        self._subscribers.add(subscriber)
        try:
            yield "retry: 3000\n\n"
            yield _frame("ready", {"type": "ready"})
            while True:
                try:
                    event_type, data = await asyncio.wait_for(subscriber.queue.get(), timeout=15.0)
                    yield _frame(event_type, data)
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            self._subscribers.discard(subscriber)


__all__ = ["SpeechEventHub"]
