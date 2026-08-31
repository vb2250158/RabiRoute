from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

import numpy as np

from rabispeech.remote_audio import RemoteAudioHub, RemoteAudioServerConfig


root = Path(sys.argv[1])
mode = sys.argv[2]
marker = Path(sys.argv[3])
gate = Path(sys.argv[4]) if len(sys.argv) > 4 else None


def cutpoint(stage: str, _source: str, _chunk: str) -> None:
    if mode == "cut_claimed" and stage == "claimed":
        os._exit(91)
    if mode == "cut_delivery_started" and stage == "delivery_started":
        os._exit(92)
    if mode == "cut_after_feed" and stage == "feed_returned":
        os._exit(94)


def feed(_client_id: str, _samples: np.ndarray) -> None:
    with marker.open("ab") as stream:
        stream.write(b"feed\n")
        stream.flush()
        os.fsync(stream.fileno())
    if mode == "slow":
        time.sleep(0.4)
    if mode == "kill_in_feed":
        os._exit(93)


hub = RemoteAudioHub(
    RemoteAudioServerConfig(
        enabled=False,
        host="127.0.0.1",
        port=8782,
        token="",
        settings_path=root / "selection.json",
        discovery_port=8783,
        service_name="process-worker",
    ),
    local_player=lambda _path, _volume, _cancel: None,
    local_stopper=lambda: None,
    durable_chunk_lease_seconds=0.5,
    durable_chunk_cutpoint=cutpoint,
)
hub.set_feed(feed)
hub.start_virtual_client(
    client_id="phone-process-audio",
    name="Process Phone",
    kind="mobile",
    message_adapter_type="rabilink",
    source_device_id="phone-process",
)
asyncio.run(hub.select("remote", "phone-process-audio"))
asyncio.run(hub.start_capture(16_000, 100))
if gate is not None:
    deadline = time.time() + 10
    while not gate.exists() and time.time() < deadline:
        time.sleep(0.01)

try:
    accepted = hub.feed_virtual_client(
        "phone-process-audio",
        np.array([0, 16_384, -16_384], dtype="<i2").tobytes(),
        sequence=1,
        chunk_id="process-chunk-one",
    )
except ValueError as error:
    message = str(error)
    if "being processed" in message:
        raise SystemExit(3)
    if "ambiguous prior ASR delivery" in message:
        raise SystemExit(4)
    raise
raise SystemExit(0 if accepted else 5)
