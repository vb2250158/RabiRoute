"""Bounded, read-only playback evidence at the existing companion capture point."""
from __future__ import annotations

from .timeout_settings import get_timeout_seconds

import asyncio
import sys


async def _sessions() -> list[dict]:
    from winrt.windows.media import MediaPlaybackType
    from winrt.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    )
    manager = await GlobalSystemMediaTransportControlsSessionManager.request_async()
    evidence = []
    for session in list(manager.get_sessions())[:8]:
        info = session.get_playback_info()
        if info.playback_status != GlobalSystemMediaTransportControlsSessionPlaybackStatus.PLAYING:
            continue
        properties = await session.try_get_media_properties_async()
        kind = properties.playback_type or info.playback_type
        evidence.append({"kind": "video" if kind == MediaPlaybackType.VIDEO else
                         "audio" if kind == MediaPlaybackType.MUSIC else "unknown",
                         "status": "playing", "title": (properties.title or "")[:200]})
    return evidence


def foreground_media_evidence(title: str) -> dict | None:
    if sys.platform != "win32" or not title:
        return None
    try:
        rows = asyncio.run(asyncio.wait_for(_sessions(), timeout=get_timeout_seconds("desktop.media.inspect", 1.5)))
    except Exception:
        # Unsupported players, denied metadata and timeouts retain visual classification.
        return None
    matching = [row for row in rows if row["title"] and row["title"].casefold() in title.casefold()]
    return next((row for row in matching if row["kind"] == "video"), next(iter(matching), None))
