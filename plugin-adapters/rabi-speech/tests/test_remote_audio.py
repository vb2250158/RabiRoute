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


def test_remote_audio_client_is_only_a_pcm_transport_and_cannot_spoof_rabilink(tmp_path: Path) -> None:
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
                    "deviceKind": "mobile",
                    "messageAdapterType": "rabilink",
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
                assert hub.selected_client_name == "Meeting Room A"
                assert hub.selected_client_kind == "mobile"
                assert hub.selected_message_adapter_type == "speech"
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


def test_rabilink_virtual_audio_client_reuses_the_host_pcm_feed(tmp_path: Path) -> None:
    received: list[tuple[str, np.ndarray]] = []
    hub = RemoteAudioHub(
        RemoteAudioServerConfig(
            enabled=False,
            host="127.0.0.1",
            port=8782,
            token="",
            settings_path=tmp_path / "selection.json",
            discovery_port=8783,
            service_name="test-host",
        ),
        local_player=lambda _path, _volume, _cancel: None,
        local_stopper=lambda: None,
    )
    hub.set_feed(lambda client_id, samples: received.append((client_id, samples)))
    hub.start_virtual_client(
        client_id="phone-one-audio",
        name="Phone One",
        kind="mobile",
        device_model="HBP-AL00",
        message_adapter_type="rabilink",
        source_device_id="phone-one",
        route_profile_id="mobile-main",
        session_id="phone-one",
        resume_running=True,
    )
    asyncio.run(hub.select("remote", "phone-one-audio"))
    asyncio.run(hub.start_capture(16_000, 100))
    accepted = hub.feed_virtual_client(
        "phone-one-audio",
        np.array([0, 16_384, -16_384], dtype="<i2").tobytes(),
        sequence=1,
    )
    assert accepted is True
    assert received[0][0] == "phone-one-audio"
    np.testing.assert_allclose(received[0][1], [0.0, 0.5, -0.5])
    assert hub.feed_virtual_client(
        "phone-one-audio",
        np.array([0, 16_384, -16_384], dtype="<i2").tobytes(),
        sequence=1,
    ) is True
    assert len(received) == 1
    with pytest.raises(ValueError, match="retried with different PCM bytes"):
        hub.feed_virtual_client("phone-one-audio", b"\x00\x00", sequence=1)
    assert hub.selected_message_adapter_type == "rabilink"
    assert hub.selected_source_device_id == "phone-one"
    assert hub.selected_route_profile_id == "mobile-main"
    assert hub.selected_session_id == "phone-one"
    row = hub.snapshot()["clients"][0]
    assert row["device_model"] == "HBP-AL00"
    assert row["last_sequence"] == 1
    assert row["received_bytes"] == len(np.array([0, 16_384, -16_384], dtype="<i2").tobytes())
    assert row["accepted_chunks"] == 1
    events = hub.snapshot()["events"]
    assert events[0]["kind"] == "pcm_received"
    assert events[0]["direction"] == "inbound"
    assert events[0]["client_id"] == "phone-one-audio"
    assert hub.stale_virtual_client_id(15, client_id="phone-one-audio", now=float(row["last_audio_at"]) + 14.9) is None
    assert hub.stale_virtual_client_id(15, client_id="phone-one-audio", now=float(row["last_audio_at"]) + 15) == "phone-one-audio"
    with pytest.raises(ValueError, match="expected 2, received 3"):
        hub.feed_virtual_client("phone-one-audio", b"\x00\x00", sequence=3)
    _, resume_running = hub.stop_virtual_client("phone-one-audio")
    assert resume_running is True


def test_rabilink_virtual_audio_chunk_id_deduplicates_after_stream_rebuild(tmp_path: Path) -> None:
    received: list[tuple[str, np.ndarray]] = []
    hub = RemoteAudioHub(
        RemoteAudioServerConfig(
            enabled=False,
            host="127.0.0.1",
            port=8782,
            token="",
            settings_path=tmp_path / "selection.json",
            discovery_port=8783,
            service_name="test-host",
        ),
        local_player=lambda _path, _volume, _cancel: None,
        local_stopper=lambda: None,
    )
    hub.set_feed(lambda client_id, samples: received.append((client_id, samples)))
    first_payload = np.array([0, 16_384, -16_384], dtype="<i2").tobytes()
    second_payload = np.array([8_192, -8_192], dtype="<i2").tobytes()

    hub.start_virtual_client(
        client_id="phone-stream-a",
        name="Phone One",
        kind="mobile",
        message_adapter_type="rabilink",
        source_device_id="phone-one",
    )
    asyncio.run(hub.select("remote", "phone-stream-a"))
    asyncio.run(hub.start_capture(16_000, 100))
    assert hub.feed_virtual_client(
        "phone-stream-a", first_payload, sequence=1, chunk_id="stable-chunk-one"
    ) is True
    assert len(received) == 1

    hub.start_virtual_client(
        client_id="phone-stream-a",
        name="Phone One",
        kind="mobile",
        message_adapter_type="rabilink",
        source_device_id="phone-one",
    )
    assert hub.feed_virtual_client(
        "phone-stream-a", first_payload, sequence=1, chunk_id="stable-chunk-one"
    ) is True
    assert len(received) == 1
    assert hub.snapshot()["clients"][0]["last_sequence"] == 1
    assert hub.snapshot()["clients"][0]["received_bytes"] == len(first_payload)
    assert hub.snapshot()["clients"][0]["accepted_chunks"] == 1
    assert hub.feed_virtual_client(
        "phone-stream-a", second_payload, sequence=2, chunk_id="stable-chunk-two"
    ) is True
    assert len(received) == 2
    assert received[1][0] == "phone-stream-a"
    np.testing.assert_allclose(received[1][1], [0.25, -0.25])
    assert hub.snapshot()["clients"][0]["last_sequence"] == 2
    assert hub.snapshot()["clients"][0]["received_bytes"] == len(first_payload) + len(second_payload)
    assert hub.snapshot()["clients"][0]["accepted_chunks"] == 2
    assert hub.feed_virtual_client(
        "phone-stream-a", second_payload, sequence=2, chunk_id="stable-chunk-two"
    ) is True
    assert len(received) == 2
    assert hub.snapshot()["clients"][0]["received_bytes"] == len(first_payload) + len(second_payload)
    assert hub.snapshot()["clients"][0]["accepted_chunks"] == 2

    hub.start_virtual_client(
        client_id="phone-stream-a",
        name="Phone One",
        kind="mobile",
        message_adapter_type="rabilink",
        source_device_id="phone-one",
    )
    with pytest.raises(ValueError, match="retried with different PCM bytes"):
        hub.feed_virtual_client(
            "phone-stream-a", b"\x00\x00", sequence=1, chunk_id="stable-chunk-two"
        )


def test_rabilink_virtual_audio_clients_connect_concurrently_but_only_selected_device_feeds_asr(
    tmp_path: Path,
) -> None:
    received: list[tuple[str, np.ndarray]] = []
    hub = RemoteAudioHub(
        RemoteAudioServerConfig(
            enabled=False,
            host="127.0.0.1",
            port=8782,
            token="",
            settings_path=tmp_path / "selection.json",
            discovery_port=8783,
            service_name="test-host",
        ),
        local_player=lambda _path, _volume, _cancel: None,
        local_stopper=lambda: None,
    )
    hub.set_feed(lambda client_id, samples: received.append((client_id, samples)))
    for suffix in ("one", "two"):
        hub.start_virtual_client(
            client_id=f"phone-{suffix}-audio",
            name=f"Phone {suffix.title()}",
            kind="mobile",
            message_adapter_type="rabilink",
            source_device_id=f"phone-{suffix}",
            route_profile_id=f"route-{suffix}",
        )

    asyncio.run(hub.select("remote", "phone-one-audio"))
    asyncio.run(hub.start_capture(16_000, 100))
    payload = np.array([0, 16_384, -16_384], dtype="<i2").tobytes()
    assert hub.feed_virtual_client("phone-one-audio", payload, sequence=1, chunk_id="one-1")
    assert hub.feed_virtual_client("phone-two-audio", payload, sequence=1, chunk_id="two-1")
    assert [item[0] for item in received] == ["phone-one-audio"]

    rows = {row["id"]: row for row in hub.snapshot()["clients"]}
    assert set(rows) == {"phone-one-audio", "phone-two-audio"}
    assert rows["phone-one-audio"]["selected"] is True
    assert rows["phone-one-audio"]["accepted_chunks"] == 1
    assert rows["phone-two-audio"]["selected"] is False
    assert rows["phone-two-audio"]["last_sequence"] == 1
    assert rows["phone-two-audio"]["accepted_chunks"] == 0

    asyncio.run(hub.select("remote", "phone-two-audio"))
    assert hub.feed_virtual_client("phone-one-audio", payload, sequence=2, chunk_id="one-2")
    assert hub.feed_virtual_client("phone-two-audio", payload, sequence=2, chunk_id="two-2")
    assert [item[0] for item in received] == ["phone-one-audio", "phone-two-audio"]
    assert hub.selected_source_device_id == "phone-two"
    assert hub.selected_route_profile_id == "route-two"

    hub.stop_virtual_client("phone-two-audio")
    snapshot = hub.snapshot()
    assert snapshot["selected_client_id"] == "phone-two-audio"
    assert snapshot["selected_online"] is False
    assert any(row["id"] == "phone-one-audio" and row["online"] for row in snapshot["clients"])

    hub.start_virtual_client(
        client_id="phone-two-audio",
        name="Phone Two",
        kind="mobile",
        message_adapter_type="rabilink",
        source_device_id="phone-two",
        route_profile_id="route-two",
    )
    assert hub.snapshot()["selected_online"] is True
