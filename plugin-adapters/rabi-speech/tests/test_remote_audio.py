from __future__ import annotations

import asyncio
import json
import socket
from pathlib import Path

import numpy as np
import pytest

from rabispeech.remote_audio import RemoteAudioHub, RemoteAudioServerConfig


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_remote_audio_client_is_only_a_pcm_transport(tmp_path: Path) -> None:
    websockets = pytest.importorskip("websockets.asyncio.client")

    async def scenario() -> None:
        port = _free_port()
        discovery_port = _free_port()
        received: list[tuple[str, np.ndarray]] = []
        hub = RemoteAudioHub(
            RemoteAudioServerConfig(
                enabled=True,
                host="127.0.0.1",
                port=port,
                token="test-token",
                settings_path=tmp_path / "selection.json",
                discovery_port=discovery_port,
                service_name="test-host",
            ),
            local_player=lambda _path, _volume, _cancel: None,
            local_stopper=lambda: None,
        )
        hub.set_feed(lambda client_id, samples: received.append((client_id, samples)))
        await hub.start()
        try:
            async with websockets.connect(
                f"ws://127.0.0.1:{port}",
                additional_headers={"Authorization": "Bearer test-token"},
            ) as client:
                await client.send(json.dumps({
                    "type": "hello",
                    "clientId": "meeting-room-a",
                    "name": "Meeting Room A",
                    "sampleRate": 16_000,
                    "chunkMs": 100,
                }))
                assert json.loads(await client.recv())["type"] == "hello-accepted"
                assert json.loads(await client.recv()) == {
                    "type": "capture",
                    "enabled": False,
                    "sampleRate": 16_000,
                    "chunkMs": 100,
                }
                await hub.select("remote", "meeting-room-a")
                await hub.start_capture(16_000, 100)
                capture_messages = [json.loads(await client.recv()), json.loads(await client.recv())]
                assert capture_messages[-1]["enabled"] is True
                await client.send(np.array([0, 16_384, -16_384], dtype="<i2").tobytes())
                for _ in range(20):
                    if received:
                        break
                    await asyncio.sleep(0.01)
                assert received[0][0] == "meeting-room-a"
                np.testing.assert_allclose(received[0][1], [0.0, 0.5, -0.5])
        finally:
            await hub.stop()

    asyncio.run(scenario())
