from __future__ import annotations

import asyncio
import hashlib
import os
import sqlite3
import subprocess
import sys
import time
import json
import socket
import threading
from pathlib import Path

import numpy as np
import pytest

from rabispeech.remote_audio import RemoteAudioHub, RemoteAudioServerConfig
from rabispeech.playback import PlaybackUnavailableError
from rabispeech.config import load_settings


def test_offline_saved_selection_reports_recovery_without_local_fallback(tmp_path: Path) -> None:
    settings = tmp_path / "selection.json"
    settings.write_text(json.dumps({"version": 1, "selected_client_id": "offline-device"}))
    played = []
    hub = RemoteAudioHub(
        RemoteAudioServerConfig(enabled=True, host="127.0.0.1", port=0, token="test", settings_path=settings, discovery_port=0, service_name="test"),
        local_player=lambda *_args: played.append(True), local_stopper=lambda: None,
    )
    with pytest.raises(PlaybackUnavailableError, match="已离线"):
        hub.play(tmp_path / "unused.wav", 100, threading.Event())
    assert played == []
    assert hub.snapshot()["source"] == "remote"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_remote_audio_defaults_to_dynamic_and_preserves_explicit_port(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("RABISPEECH_REMOTE_AUDIO_PORT", raising=False)
    config = tmp_path / "config.json"
    config.write_text("{}", encoding="utf-8")
    assert load_settings(config).remote_audio.port == 0
    config.write_text('{"remote_audio":{"port":8782}}', encoding="utf-8")
    assert load_settings(config).remote_audio.port == 8782


def test_dynamic_remote_audio_port_is_advertised_and_connectable(tmp_path: Path) -> None:
    websockets = pytest.importorskip("websockets.asyncio.client")

    async def scenario() -> None:
        hub = RemoteAudioHub(
            RemoteAudioServerConfig(True, "127.0.0.1", 0, "test-token", tmp_path / "selection.json", 0, "dynamic"),
            local_player=lambda *_args: None, local_stopper=lambda: None,
        )
        await hub.start()
        loop = asyncio.get_running_loop()
        received = loop.create_future()

        class Client(asyncio.DatagramProtocol):
            def datagram_received(self, data, _addr):
                if not received.done():
                    received.set_result(json.loads(data))

        transport, _ = await loop.create_datagram_endpoint(Client, local_addr=("127.0.0.1", 0))
        try:
            discovery_port = hub._discovery_transport.get_extra_info("sockname")[1]
            assert hub.snapshot()["discovery_port"] == discovery_port > 0
            transport.sendto(b"RABI_VOICE_DISCOVER_V1", ("127.0.0.1", discovery_port))
            advertisement = await asyncio.wait_for(received, 3)
            assert advertisement["port"] == hub.snapshot()["port"] > 0
            async with websockets.connect(
                f"ws://127.0.0.1:{advertisement['port']}",
                additional_headers={"Authorization": "Bearer test-token"},
            ):
                pass
        finally:
            transport.close()
            await hub.stop()
        assert hub.snapshot()["port"] == 0
        assert hub.snapshot()["discovery_port"] == 0

    asyncio.run(scenario())


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
        chunk_id="chunk-one",
    )
    assert accepted is True
    assert received[0][0] == "phone-one-audio"
    np.testing.assert_allclose(received[0][1], [0.0, 0.5, -0.5])
    assert hub.feed_virtual_client(
        "phone-one-audio",
        np.array([0, 16_384, -16_384], dtype="<i2").tobytes(),
        sequence=1,
        chunk_id="chunk-one",
    ) is True
    assert len(received) == 1
    with pytest.raises(ValueError, match="retry conflicts"):
        hub.feed_virtual_client("phone-one-audio", b"\x00\x00", sequence=1, chunk_id="chunk-one")
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
        hub.feed_virtual_client("phone-one-audio", b"\x00\x00", sequence=3, chunk_id="chunk-three")
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
    with pytest.raises(ValueError, match="retry conflicts"):
        hub.feed_virtual_client(
            "phone-stream-a", b"\x00\x00", sequence=2, chunk_id="stable-chunk-two"
        )

    hub.start_virtual_client(
        client_id="phone-stream-a",
        name="Phone One",
        kind="mobile",
        message_adapter_type="rabilink",
        source_device_id="phone-one",
    )
    with pytest.raises(ValueError, match="sequence mismatch: expected 3, received 1"):
        hub.feed_virtual_client(
            "phone-stream-a", b"\x00\x00", sequence=1, chunk_id="stable-chunk-two"
        )


def test_rabilink_chunk_retry_after_stopped_stream_is_acknowledged_once_with_new_sequence(tmp_path: Path) -> None:
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
    first_payload = np.array([0, 16_384], dtype="<i2").tobytes()
    retried_payload = np.array([8_192, -8_192], dtype="<i2").tobytes()
    hub.start_virtual_client(
        client_id="phone-one-old",
        name="Phone One",
        kind="mobile",
        message_adapter_type="rabilink",
        source_device_id="phone-one",
    )
    asyncio.run(hub.select("remote", "phone-one-old"))
    asyncio.run(hub.start_capture(16_000, 100))
    assert hub.feed_virtual_client("phone-one-old", first_payload, sequence=1, chunk_id="stable-first")
    assert hub.feed_virtual_client("phone-one-old", retried_payload, sequence=2, chunk_id="stable-retry")
    assert len(received) == 2
    hub.stop_virtual_client("phone-one-old")

    hub.start_virtual_client(
        client_id="phone-one-new",
        name="Phone One",
        kind="mobile",
        message_adapter_type="rabilink",
        source_device_id="phone-one",
    )
    assert hub.selected_client_id == "phone-one-new"
    assert hub.feed_virtual_client("phone-one-new", retried_payload, sequence=1, chunk_id="stable-retry")
    assert len(received) == 2
    rebuilt = next(row for row in hub.snapshot()["clients"] if row["id"] == "phone-one-new")
    assert rebuilt["last_sequence"] == 1
    assert rebuilt["last_chunk_id"] == "stable-retry"
    assert rebuilt["last_chunk_bytes"] == len(retried_payload)

    hub.stop_virtual_client("phone-one-new")
    hub.start_virtual_client(
        client_id="phone-one-third",
        name="Phone One",
        kind="mobile",
        message_adapter_type="rabilink",
        source_device_id="phone-one",
    )
    with pytest.raises(ValueError, match="conflicts"):
        hub.feed_virtual_client("phone-one-third", b"\x00\x00", sequence=1, chunk_id="stable-retry")


def test_rabilink_chunk_ledger_survives_new_hub_and_prevents_duplicate_asr_feed(tmp_path: Path) -> None:
    received: list[tuple[str, np.ndarray]] = []
    config = RemoteAudioServerConfig(
        enabled=False,
        host="127.0.0.1",
        port=8782,
        token="",
        settings_path=tmp_path / "selection.json",
        discovery_port=8783,
        service_name="test-host",
    )

    def make_hub() -> RemoteAudioHub:
        result = RemoteAudioHub(
            config,
            local_player=lambda _path, _volume, _cancel: None,
            local_stopper=lambda: None,
        )
        result.set_feed(lambda client_id, samples: received.append((client_id, samples)))
        result.start_virtual_client(
            client_id="phone-one-audio",
            name="Phone One",
            kind="mobile",
            message_adapter_type="rabilink",
            source_device_id="phone-one",
        )
        asyncio.run(result.select("remote", "phone-one-audio"))
        asyncio.run(result.start_capture(16_000, 100))
        return result

    payload = np.array([0, 16_384, -16_384], dtype="<i2").tobytes()
    first = make_hub()
    assert first.feed_virtual_client("phone-one-audio", payload, sequence=1, chunk_id="durable-one")
    assert len(received) == 1

    rebuilt = make_hub()
    assert rebuilt.feed_virtual_client("phone-one-audio", payload, sequence=1, chunk_id="durable-one")
    assert len(received) == 1
    assert (tmp_path / "rabilink-audio-ack-ledger.sqlite3").exists()
    with pytest.raises(ValueError, match="durable ledger record"):
        another = make_hub()
        another.feed_virtual_client("phone-one-audio", b"\x00\x00", sequence=1, chunk_id="durable-one")


def test_durable_tuple_page_exposes_ordered_terminal_phone_tuples_without_payloads(tmp_path: Path) -> None:
    hub = RemoteAudioHub(
        RemoteAudioServerConfig(False, "127.0.0.1", 8782, "", tmp_path / "selection.json", 8783, "tuples"),
        local_player=lambda _path, _volume, _cancel: None,
        local_stopper=lambda: None,
    )
    hub.set_feed(lambda _client_id, _samples: None)
    hub.start_virtual_client(
        client_id="phone-tuples-audio", name="Phone", kind="mobile",
        message_adapter_type="rabilink", source_device_id="phone-tuples",
    )
    asyncio.run(hub.select("remote", "phone-tuples-audio"))
    asyncio.run(hub.start_capture(16_000, 100))
    first_payload = np.array([1, 2], dtype="<i2").tobytes()
    second_payload = np.array([3, 4], dtype="<i2").tobytes()
    assert hub.feed_virtual_client(
        "phone-tuples-audio", first_payload, sequence=1, chunk_id="audio-00000000000000000001"
    )
    assert hub.feed_virtual_client(
        "phone-tuples-audio", second_payload, sequence=2, chunk_id="audio-00000000000000000002"
    )

    first_page = hub.durable_tuple_page("phone-tuples", limit=1)
    assert first_page["has_more"] is True
    assert first_page["next_after_source_sequence"] == 1
    assert first_page["records"] == [{
        "source_device_id": "phone-tuples",
        "chunk_id": "audio-00000000000000000001",
        "accepted_bytes": len(first_payload),
        "sha256": hashlib.sha256(first_payload).hexdigest(),
        "source_sequence": 1,
        "stream_sequence": 1,
        "terminal": True,
        "terminal_status": "processed",
        "processed_at": first_page["records"][0]["processed_at"],
    }]
    second_page = hub.durable_tuple_page(
        "phone-tuples", after_source_sequence=first_page["next_after_source_sequence"], limit=1
    )
    assert second_page["has_more"] is False
    assert second_page["records"][0]["source_sequence"] == 2
    assert second_page["records"][0]["chunk_id"] == "audio-00000000000000000002"
    assert "owner_id" not in second_page["records"][0]
    assert "payload" not in second_page["records"][0]


def _ledger_worker(tmp_path: Path, mode: str, marker: Path, gate: Path | None = None) -> subprocess.Popen[bytes]:
    worker = Path(__file__).with_name("rabilink_ledger_process_worker.py")
    environment = os.environ.copy()
    plugin_root = str(Path(__file__).parents[1])
    environment["PYTHONPATH"] = plugin_root + os.pathsep + environment.get("PYTHONPATH", "")
    arguments = [sys.executable, str(worker), str(tmp_path), mode, str(marker)]
    if gate is not None:
        arguments.append(str(gate))
    return subprocess.Popen(arguments, env=environment)


def test_durable_ledger_claim_is_atomic_across_independent_processes(tmp_path: Path) -> None:
    marker = tmp_path / "feeds.txt"
    gate = tmp_path / "go"
    first = _ledger_worker(tmp_path, "slow", marker, gate)
    second = _ledger_worker(tmp_path, "normal", marker, gate)
    gate.write_text("go", encoding="utf-8")
    codes = {first.wait(timeout=15), second.wait(timeout=15)}
    assert codes <= {0, 3}
    assert 0 in codes
    replay = _ledger_worker(tmp_path, "normal", marker)
    assert replay.wait(timeout=15) == 0
    assert marker.read_bytes() == b"feed\n"


def test_claimed_crash_is_recovered_after_lease_without_duplicate_feed(tmp_path: Path) -> None:
    marker = tmp_path / "feeds.txt"
    crashed = _ledger_worker(tmp_path, "cut_claimed", marker)
    assert crashed.wait(timeout=15) == 91
    time.sleep(0.6)
    replay = _ledger_worker(tmp_path, "normal", marker)
    assert replay.wait(timeout=15) == 0
    assert marker.read_bytes() == b"feed\n"


def test_pre_feed_cutpoint_is_recovered_after_lease_and_feeds_once(tmp_path: Path) -> None:
    marker = tmp_path / "feeds.txt"
    crashed = _ledger_worker(tmp_path, "cut_delivery_started", marker)
    assert crashed.wait(timeout=15) == 92
    time.sleep(0.6)
    replay = _ledger_worker(tmp_path, "normal", marker)
    assert replay.wait(timeout=15) == 0
    assert marker.read_bytes() == b"feed\n"


@pytest.mark.parametrize(("mode", "exit_code"), (("kill_in_feed", 93), ("cut_after_feed", 94)))
def test_in_or_post_feed_crash_stays_ambiguous_and_never_auto_refeeds_or_acks(
    tmp_path: Path, mode: str, exit_code: int,
) -> None:
    marker = tmp_path / "feeds.txt"
    crashed = _ledger_worker(tmp_path, mode, marker)
    assert crashed.wait(timeout=15) == exit_code
    time.sleep(0.6)
    replay = _ledger_worker(tmp_path, "normal", marker)
    assert replay.wait(timeout=15) == 4
    assert marker.read_bytes() == b"feed\n"
    with sqlite3.connect(tmp_path / "rabilink-audio-ack-ledger.sqlite3") as database:
        state, result = database.execute(
            "SELECT state, result FROM processed_chunks WHERE chunk_id = 'process-chunk-one'"
        ).fetchone()
    assert (state, result) == ("delivery_started", "ambiguous")


def test_ambiguous_chunk_requires_explicit_tuple_checked_operator_resolution(tmp_path: Path) -> None:
    marker = tmp_path / "feeds.txt"
    crashed = _ledger_worker(tmp_path, "cut_after_feed", marker)
    assert crashed.wait(timeout=15) == 94
    payload = np.array([0, 16_384, -16_384], dtype="<i2").tobytes()
    checksum = hashlib.sha256(payload).hexdigest()
    hub = RemoteAudioHub(
        RemoteAudioServerConfig(False, "127.0.0.1", 8782, "", tmp_path / "selection.json", 8783, "resolve"),
        local_player=lambda _path, _volume, _cancel: None,
        local_stopper=lambda: None,
    )
    with pytest.raises(ValueError, match="conflicts"):
        hub.resolve_ambiguous_chunk("phone-process", "process-chunk-one", len(payload), "0" * 64, "replay")
    resolved = hub.resolve_ambiguous_chunk(
        "phone-process", "process-chunk-one", len(payload), checksum, "skip"
    )
    assert resolved["state"] == "processed"
    replay = _ledger_worker(tmp_path, "normal", marker)
    assert replay.wait(timeout=15) == 0
    assert marker.read_bytes() == b"feed\n"


def test_operator_replay_is_explicit_and_auditable(tmp_path: Path) -> None:
    marker = tmp_path / "feeds.txt"
    crashed = _ledger_worker(tmp_path, "kill_in_feed", marker)
    assert crashed.wait(timeout=15) == 93
    payload = np.array([0, 16_384, -16_384], dtype="<i2").tobytes()
    checksum = hashlib.sha256(payload).hexdigest()
    hub = RemoteAudioHub(
        RemoteAudioServerConfig(False, "127.0.0.1", 8782, "", tmp_path / "selection.json", 8783, "resolve"),
        local_player=lambda _path, _volume, _cancel: None,
        local_stopper=lambda: None,
    )
    resolved = hub.resolve_ambiguous_chunk(
        "phone-process", "process-chunk-one", len(payload), checksum, "replay", "test-operator"
    )
    assert resolved["state"] == "claimed"
    assert resolved["audit_event_id"]
    replay = _ledger_worker(tmp_path, "normal", marker)
    assert replay.wait(timeout=15) == 0
    assert marker.read_bytes() == b"feed\nfeed\n"
    reopened = RemoteAudioHub(
        RemoteAudioServerConfig(False, "127.0.0.1", 8782, "", tmp_path / "selection.json", 8783, "audit"),
        local_player=lambda _path, _volume, _cancel: None,
        local_stopper=lambda: None,
    )
    snapshot = reopened.snapshot()["durable_chunk_ledger"]
    assert snapshot["resolution_audit_count"] == 1
    assert snapshot["recent_resolutions"][0] == {
        "event_id": resolved["audit_event_id"],
        "source_device_id": "phone-process",
        "chunk_id": "process-chunk-one",
        "accepted_bytes": len(payload),
        "sha256": checksum,
        "source_sequence": 0,
        "decision": "replay",
        "resolved_at": snapshot["recent_resolutions"][0]["resolved_at"],
        "operator": "test-operator",
        "action": "resolve_ambiguous",
        "result": "claimed",
    }
    reopened.retire_durable_source(
        "phone-process",
        phone_spool_empty=True,
        maximum_phone_retention_elapsed=True,
        operator_confirmation="retire:phone-process",
    )
    after_retirement = reopened.snapshot()["durable_chunk_ledger"]
    assert after_retirement["processed"] == 0
    assert after_retirement["resolution_audit_count"] == 1
    assert after_retirement["recent_resolutions"][0]["event_id"] == resolved["audit_event_id"]


def test_legacy_six_column_ledger_upgrades_restarts_and_keeps_multiprocess_claim_atomic(
    tmp_path: Path,
) -> None:
    ledger_path = tmp_path / "rabilink-audio-ack-ledger.sqlite3"
    with sqlite3.connect(ledger_path) as database:
        database.execute(
            "CREATE TABLE processed_chunks ("
            "source_device_id TEXT NOT NULL, chunk_id TEXT NOT NULL, accepted_bytes INTEGER NOT NULL, "
            "sha256 TEXT NOT NULL, processed_at REAL NOT NULL, result TEXT NOT NULL, "
            "PRIMARY KEY (source_device_id, chunk_id))"
        )
        database.execute(
            "INSERT INTO processed_chunks VALUES (?, ?, ?, ?, ?, ?)",
            ("legacy-phone", "legacy-one", 2, hashlib.sha256(b"\x00\x00").hexdigest(), time.time(), "processed"),
        )
        database.execute("PRAGMA user_version = 0")

    def rebuild() -> RemoteAudioHub:
        return RemoteAudioHub(
            RemoteAudioServerConfig(False, "127.0.0.1", 8782, "", tmp_path / "selection.json", 8783, "migration"),
            local_player=lambda _path, _volume, _cancel: None,
            local_stopper=lambda: None,
        )

    assert rebuild().snapshot()["durable_chunk_ledger"]["schema_version"] == 3
    with sqlite3.connect(ledger_path) as database:
        columns = {row[1] for row in database.execute("PRAGMA table_info(processed_chunks)")}
        assert {"state", "owner_id", "lease_until", "updated_at", "source_sequence", "stream_sequence"} <= columns
        assert database.execute("PRAGMA user_version").fetchone()[0] == 3
        assert database.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resolution_audit'"
        ).fetchone() is not None
        assert database.execute(
            "SELECT state FROM processed_chunks WHERE source_device_id = 'legacy-phone'"
        ).fetchone()[0] == "processed"

    marker = tmp_path / "feeds.txt"
    gate = tmp_path / "go"
    first = _ledger_worker(tmp_path, "slow", marker, gate)
    second = _ledger_worker(tmp_path, "normal", marker, gate)
    gate.write_text("go", encoding="utf-8")
    codes = {first.wait(timeout=15), second.wait(timeout=15)}
    assert codes <= {0, 3}
    assert 0 in codes
    assert marker.read_bytes() == b"feed\n"
    restarted = rebuild().snapshot()["durable_chunk_ledger"]
    assert restarted["schema_version"] == 3
    assert restarted["processed"] == 2


def test_concurrent_selection_writers_use_independent_staging_files_and_keep_last_writer(tmp_path: Path) -> None:
    settings, gate = tmp_path / "selection.json", tmp_path / "write-go"
    code = r'''
import asyncio, contextlib, sys, time
from pathlib import Path
from rabispeech.remote_audio import RemoteAudioHub, RemoteAudioServerConfig
settings, ready, gate, value = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]
hub = RemoteAudioHub(RemoteAudioServerConfig(False, "127.0.0.1", 0, "", settings, 0, "fixture"), local_player=lambda *_args:None, local_stopper=lambda:None)
original_open = Path.open
@contextlib.contextmanager
def coordinated_open(path, mode="r", *args, **kwargs):
    with original_open(path, mode, *args, **kwargs) as output:
        if mode == "x" and path.name.endswith(".tmp"):
            ready.with_suffix(".stage").write_text(str(path), encoding="utf-8")
        yield output
Path.open = coordinated_open
ready.write_text("ready", encoding="utf-8")
deadline = time.monotonic() + 15
while not gate.is_file():
    if time.monotonic() > deadline: raise TimeoutError("Selection writer fixture gate did not open")
    time.sleep(0.01)
hub._write_selection(value)
'''
    ready_files = [tmp_path / f"writer-{index}.ready" for index in range(2)]
    processes = [subprocess.Popen([sys.executable, "-c", code, str(settings), str(ready), str(gate), f"writer-{index}"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)) for index, ready in enumerate(ready_files)]
    try:
        deadline = time.monotonic() + 15
        while not all(ready.is_file() for ready in ready_files):
            assert all(process.poll() is None for process in processes), "Concurrent writer failed before both staging files were open"
            assert time.monotonic() < deadline, "Concurrent selection staging did not become ready"
            time.sleep(0.01)
        gate.write_text("go", encoding="utf-8")
        for process in processes:
            output, error = process.communicate(timeout=15)
            assert process.returncode == 0, output + error
        assert len({ready.with_suffix(".stage").read_text(encoding="utf-8") for ready in ready_files}) == 2
        assert json.loads(settings.read_text(encoding="utf-8")) in [
            {"version": 1, "selected_client_id": "writer-0"}, {"version": 1, "selected_client_id": "writer-1"}]
        hub = RemoteAudioHub(RemoteAudioServerConfig(False, "127.0.0.1", 0, "", settings, 0, "fixture"),
            local_player=lambda *_args:None, local_stopper=lambda:None)
        hub._write_selection("last-writer")
        assert settings.read_text(encoding="utf-8") == json.dumps({"version": 1, "selected_client_id": "last-writer"}, ensure_ascii=False, indent=2) + "\n"
        assert not list(tmp_path.glob("*.tmp"))
    finally:
        gate.write_text("go", encoding="utf-8")
        for process in processes:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)


def test_selection_replace_failure_preserves_previous_settings_and_cleans_its_stage(tmp_path: Path, monkeypatch) -> None:
    settings = tmp_path / "selection.json"
    previous = '{"version": 1, "selected_client_id": "previous"}\n'
    settings.write_text(previous, encoding="utf-8")
    hub = RemoteAudioHub(RemoteAudioServerConfig(False, "127.0.0.1", 0, "", settings, 0, "fixture"),
        local_player=lambda *_args:None, local_stopper=lambda:None)
    def deny_replace(*_args):
        raise PermissionError("fixture replacement denied")
    monkeypatch.setattr(Path, "replace", deny_replace)
    with pytest.raises(PermissionError, match="replacement denied"):
        hub._write_selection("next")
    assert hub.selected_client_id == "previous"
    assert settings.read_text(encoding="utf-8") == previous
    assert not list(tmp_path.glob("*.tmp"))


def test_durable_source_retirement_is_operator_confirmed_safe_and_retains_audit(tmp_path: Path) -> None:
    marker = tmp_path / "feeds.txt"
    processed = _ledger_worker(tmp_path, "normal", marker)
    assert processed.wait(timeout=15) == 0
    hub = RemoteAudioHub(
        RemoteAudioServerConfig(False, "127.0.0.1", 8782, "", tmp_path / "selection.json", 8783, "retire"),
        local_player=lambda _path, _volume, _cancel: None,
        local_stopper=lambda: None,
    )
    with pytest.raises(ValueError, match="exact operator confirmation"):
        hub.retire_durable_source(
            "phone-process", phone_spool_empty=True, maximum_phone_retention_elapsed=True,
            operator_confirmation="yes",
        )
    with pytest.raises(ValueError, match="empty phone spool"):
        hub.retire_durable_source(
            "phone-process", phone_spool_empty=False, maximum_phone_retention_elapsed=True,
            operator_confirmation="retire:phone-process",
        )
    result = hub.retire_durable_source(
        "phone-process", phone_spool_empty=True, maximum_phone_retention_elapsed=True,
        operator_confirmation="retire:phone-process",
    )
    assert result == {
        "source_device_id": "phone-process", "retired": True, "removed_chunks": 1,
        "removed_bytes": 6, "audit_retained": True,
    }
    snapshot = hub.snapshot()["durable_chunk_ledger"]
    assert snapshot["processed"] == 0
    assert snapshot["retired_sources"] == 1
    assert snapshot["automatic_pruning"] is False
    hub.start_virtual_client(
        client_id="retired-reconnect", name="Retired", kind="mobile",
        message_adapter_type="rabilink", source_device_id="phone-process",
    )
    hub.set_feed(lambda _client_id, _samples: None)
    asyncio.run(hub.select("remote", "retired-reconnect"))
    asyncio.run(hub.start_capture(16_000, 100))
    with pytest.raises(ValueError, match="is retired"):
        hub.feed_virtual_client(
            "retired-reconnect", np.array([0, 16_384, -16_384], dtype="<i2").tobytes(),
            sequence=1, chunk_id="process-chunk-one",
        )


def test_durable_source_retirement_refuses_unresolved_ambiguous_chunks(tmp_path: Path) -> None:
    marker = tmp_path / "feeds.txt"
    crashed = _ledger_worker(tmp_path, "kill_in_feed", marker)
    assert crashed.wait(timeout=15) == 93
    hub = RemoteAudioHub(
        RemoteAudioServerConfig(False, "127.0.0.1", 8782, "", tmp_path / "selection.json", 8783, "retire"),
        local_player=lambda _path, _volume, _cancel: None,
        local_stopper=lambda: None,
    )
    with pytest.raises(ValueError, match="Resolve every ambiguous"):
        hub.retire_durable_source(
            "phone-process", phone_spool_empty=True, maximum_phone_retention_elapsed=True,
            operator_confirmation="retire:phone-process",
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
    assert not hub.feed_virtual_client("phone-two-audio", payload, sequence=1, chunk_id="two-1")
    assert [item[0] for item in received] == ["phone-one-audio"]

    rows = {row["id"]: row for row in hub.snapshot()["clients"]}
    assert set(rows) == {"phone-one-audio", "phone-two-audio"}
    assert rows["phone-one-audio"]["selected"] is True
    assert rows["phone-one-audio"]["accepted_chunks"] == 1
    assert rows["phone-two-audio"]["selected"] is False
    assert rows["phone-two-audio"]["last_sequence"] == 0
    assert rows["phone-two-audio"]["accepted_chunks"] == 0

    asyncio.run(hub.select("remote", "phone-two-audio"))
    assert not hub.feed_virtual_client("phone-one-audio", payload, sequence=2, chunk_id="one-2")
    assert hub.feed_virtual_client("phone-two-audio", payload, sequence=1, chunk_id="two-1")
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


def test_rabilink_rebuilt_stream_atomically_takes_over_selected_source_before_old_stream_stops(
    tmp_path: Path,
) -> None:
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
    hub.start_virtual_client(
        client_id="phone-one-audio-old",
        name="Phone One",
        kind="mobile",
        message_adapter_type="rabilink",
        source_device_id="phone-one",
    )
    asyncio.run(hub.select("remote", "phone-one-audio-old"))

    hub.start_virtual_client(
        client_id="phone-one-audio-new",
        name="Phone One",
        kind="mobile",
        message_adapter_type="rabilink",
        source_device_id="phone-one",
    )

    during_handoff = hub.snapshot()
    assert during_handoff["selected_client_id"] == "phone-one-audio-new"
    assert during_handoff["selected_online"] is True
    hub.stop_virtual_client("phone-one-audio-old")
    after_old_stop = hub.snapshot()
    assert after_old_stop["selected_client_id"] == "phone-one-audio-new"
    assert after_old_stop["selected_online"] is True


def test_rabilink_repeated_start_for_same_stable_stream_preserves_transport_state(
    tmp_path: Path,
) -> None:
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
    received: list[np.ndarray] = []
    hub.set_feed(lambda _client_id, samples: received.append(samples))
    hub.start_virtual_client(
        client_id="phone-one-audio",
        name="Phone One",
        kind="mobile",
        message_adapter_type="rabilink",
        source_device_id="phone-one",
        route_profile_id="mobile-main",
    )
    asyncio.run(hub.select("remote", "phone-one-audio"))
    asyncio.run(hub.start_capture(16_000, 100))
    payload = np.array([0, 16_384, -16_384], dtype="<i2").tobytes()
    assert hub.feed_virtual_client("phone-one-audio", payload, sequence=1, chunk_id="chunk-one")
    before = hub.snapshot()["clients"][0]

    hub.start_virtual_client(
        client_id="phone-one-audio",
        name="Phone One Renamed",
        kind="mobile",
        message_adapter_type="rabilink",
        source_device_id="phone-one",
        route_profile_id="mobile-main",
    )

    after = hub.snapshot()["clients"][0]
    assert after["connected_at"] == before["connected_at"]
    assert after["last_sequence"] == 1
    assert after["received_bytes"] == len(payload)
    assert after["accepted_chunks"] == 1
    assert len([event for event in hub.list_events(limit=20) if event["kind"] == "client_connected"]) == 1


def test_selection_commit_failure_keeps_original_source_and_emits_nothing_then_recovers(tmp_path: Path, monkeypatch):
    settings = tmp_path / "selection.json"
    previous = '{"version":1,"selected_client_id":"previous"}\n'
    settings.write_text(previous, encoding="utf-8")
    hub = RemoteAudioHub(RemoteAudioServerConfig(False, "127.0.0.1", 0, "", settings, 0, "fixture"),
        local_player=lambda *_args: None, local_stopper=lambda: None)
    hub._clients["next"] = object()
    events, captures = [], []
    monkeypatch.setattr(hub, "_append_event", lambda **fields: events.append(fields))
    async def sync(): captures.append(hub.selected_client_id)
    monkeypatch.setattr(hub, "_sync_capture_commands", sync)
    original = Path.replace
    def deny(*_args): raise PermissionError("fixture reader denies replacement")
    monkeypatch.setattr(Path, "replace", deny)
    for source, client in [("local", None), ("remote", "next")]:
        with pytest.raises(ValueError, match="原文件和选择仍保留") as failed:
            asyncio.run(hub.select(source, client))
        assert isinstance(failed.value.__cause__, PermissionError)
        assert hub.selected_client_id == "previous"
        assert settings.read_text(encoding="utf-8") == previous
        assert events == captures == []
    monkeypatch.setattr(Path, "replace", original)
    # Snapshot DTO is not part of this persistence fault seam.
    monkeypatch.setattr(hub, "snapshot", lambda: {"selected_client_id": hub.selected_client_id})
    assert asyncio.run(hub.select("remote", "next"))["selected_client_id"] == "next"
    assert json.loads(settings.read_text(encoding="utf-8"))["selected_client_id"] == "next"
    assert captures == ["next"] and events[0]["client_id"] == "next"


def test_same_owner_selection_serializes_replace_and_ram_commit(tmp_path: Path, monkeypatch):
    settings = tmp_path / "selection.json"
    hub = RemoteAudioHub(RemoteAudioServerConfig(False, "127.0.0.1", 0, "", settings, 0, "fixture"),
        local_player=lambda *_args: None, local_stopper=lambda: None)
    replaced, finish_first, second_started = threading.Event(), threading.Event(), threading.Event()
    original, errors = Path.replace, []
    def replace(path, target):
        value = json.loads(path.read_text(encoding="utf-8"))["selected_client_id"]
        if value == "second": assert hub.selected_client_id == "first"
        result = original(path, target)
        if value == "first":
            replaced.set()
            assert finish_first.wait(5)
        return result
    monkeypatch.setattr(Path, "replace", replace)
    def write(value):
        try:
            if value == "second": second_started.set()
            hub._write_selection(value)
        except BaseException as error: errors.append(error)
    first = threading.Thread(target=write, args=("first",))
    second = threading.Thread(target=write, args=("second",))
    first.start()
    try:
        assert replaced.wait(5)
        second.start(); assert second_started.wait(5)
    finally:
        finish_first.set(); first.join(5)
        if second.ident is not None: second.join(5)
    assert not first.is_alive() and not second.is_alive() and not errors
    assert hub.selected_client_id == "second"
    assert json.loads(settings.read_text(encoding="utf-8"))["selected_client_id"] == "second"


@pytest.mark.parametrize("branch", ["initial", "same-source", "legacy-stream"])
def test_virtual_selection_commits_only_after_save_for_each_existing_branch(tmp_path, monkeypatch, branch):
    settings = tmp_path / "selection.json"
    if branch == "legacy-stream": settings.write_text('{"version":1,"selected_client_id":"phone-old"}', encoding="utf-8")
    hub = RemoteAudioHub(RemoteAudioServerConfig(False, "127.0.0.1", 0, "", settings, 0, "fixture"),
        local_player=lambda *_args: None, local_stopper=lambda: None)
    def start(client):
        return hub.start_virtual_client(client_id=client, name=client, kind="phone", message_adapter_type="rabilink", source_device_id="phone")
    if branch == "same-source": start("old-stream")
    previous_id, previous_raw = hub.selected_client_id, settings.read_bytes() if settings.exists() else None
    events = []
    monkeypatch.setattr(hub, "_append_event", lambda **fields: events.append(fields))
    original = Path.replace
    def deny(*_args): raise PermissionError("fixture selection commit denied")
    monkeypatch.setattr(Path, "replace", deny)
    with pytest.raises(PermissionError, match="commit denied"): start("new-stream")
    assert hub.selected_client_id == previous_id
    assert (settings.read_bytes() if settings.exists() else None) == previous_raw
    assert not events
    monkeypatch.setattr(Path, "replace", original)
    start("new-stream")
    assert hub.selected_client_id == "new-stream"
    assert json.loads(settings.read_text(encoding="utf-8"))["selected_client_id"] == "new-stream"


@pytest.mark.parametrize("raw", [b'{broken', b'{"version":2,"selected_client_id":null,"future":{"keep":true}}', b'[]', b'{"version":1,"selected_client_id":42}'])
def test_bad_selection_is_local_diagnostic_and_explicit_choice_preserves_raw_before_recovery(tmp_path, raw):
    settings = tmp_path / "selection.json"
    settings.write_bytes(raw)
    played = []
    hub = RemoteAudioHub(RemoteAudioServerConfig(False, "127.0.0.1", 0, "", settings, 0, "fixture"),
        local_player=lambda *_args: played.append(True), local_stopper=lambda: None)
    registered = hub.start_virtual_client(client_id="phone", name="Fixture", kind="phone", message_adapter_type="rabilink")
    assert registered["source"] == "unavailable" and not registered["selected_online"]
    assert registered["selection_storage_error"] and registered["clients"][0]["id"] == "phone"
    assert hub.selected_client_id is None and settings.read_bytes() == raw
    with pytest.raises(PlaybackUnavailableError): hub.play(tmp_path / "unused.wav", 100, threading.Event())
    assert not played
    restored = asyncio.run(hub.select("remote", "phone"))
    backup = restored["selection_recovery"]
    preserved = settings.parent / f".{settings.name}.recovery" / backup["id"]
    assert preserved.read_bytes() == raw
    assert backup["sha256"] == __import__("hashlib").sha256(raw).hexdigest()
    assert restored["source"] == "remote" and restored["selection_storage_error"] is None
    assert restored["selected_client_id"] == "phone"
    assert json.loads(settings.read_text(encoding="utf-8"))["selected_client_id"] == "phone"


def test_v1_selection_extensions_remain_in_the_one_formal_store(tmp_path):
    settings = tmp_path / "selection.json"
    extra = {"vendor": {"enabled": False, "unknown": [1, "two"]}, "future_hint": "keep"}
    settings.write_text(json.dumps({"version": 1, "selected_client_id": "saved", **extra}), encoding="utf-8")
    hub = RemoteAudioHub(RemoteAudioServerConfig(False, "127.0.0.1", 0, "", settings, 0, "fixture"),
        local_player=lambda *_args: None, local_stopper=lambda: None)
    hub.start_virtual_client(client_id="phone", name="Fixture", kind="phone", message_adapter_type="rabilink")
    assert hub.selected_client_id == "saved"
    asyncio.run(hub.select("remote", "phone"))
    assert json.loads(settings.read_text(encoding="utf-8")) == {"version":1,"selected_client_id":"phone",**extra}
    assert not (settings.parent / f".{settings.name}.recovery").exists()


def test_failed_selection_recovery_keeps_raw_and_can_be_retried_on_the_same_owner(tmp_path, monkeypatch):
    settings = tmp_path / "selection.json"
    raw = b'{broken original'
    settings.write_bytes(raw)
    hub = RemoteAudioHub(RemoteAudioServerConfig(False, "127.0.0.1", 0, "", settings, 0, "fixture"),
        local_player=lambda *_args: None, local_stopper=lambda: None)
    hub.start_virtual_client(client_id="phone", name="Fixture", kind="phone", message_adapter_type="rabilink")
    original = Path.replace
    def deny(*_args): raise PermissionError("fixture original entry cannot be replaced")
    monkeypatch.setattr(Path,"replace",deny)
    with pytest.raises(ValueError,match="原文件和选择仍保留"): asyncio.run(hub.select("remote","phone"))
    assert settings.read_bytes() == raw and hub.selected_client_id is None
    assert hub.snapshot()["selection_storage_error"]
    monkeypatch.setattr(Path,"replace",original)
    assert asyncio.run(hub.select("remote","phone"))["selected_client_id"] == "phone"


def test_failed_raw_snapshot_does_not_leave_a_partial_backup_that_blocks_recovery(tmp_path, monkeypatch):
    settings=tmp_path/"selection.json"
    raw=b'{broken original bytes'
    settings.write_bytes(raw)
    hub=RemoteAudioHub(RemoteAudioServerConfig(False,"127.0.0.1",0,"",settings,0,"fixture"),local_player=lambda *_:None,local_stopper=lambda:None)
    original=Path.open
    class FailedSnapshot:
        def __init__(self, stream): self.stream=stream
        def __enter__(self): return self
        def __exit__(self, *args): return self.stream.__exit__(*args)
        def write(self, data):
            self.stream.write(data[:1])
            raise OSError("fixture snapshot disk full")
    def opened(path,mode="r",*args,**kwargs):
        stream=original(path,mode,*args,**kwargs)
        return FailedSnapshot(stream) if mode=="xb" and path.name.endswith(".raw.tmp") else stream
    monkeypatch.setattr(Path,"open",opened)
    with pytest.raises(ValueError): asyncio.run(hub.select("local"))
    assert settings.read_bytes()==raw and hub.snapshot()["selection_storage_error"]
    assert not list((settings.parent/f".{settings.name}.recovery").glob("*.raw"))
    monkeypatch.setattr(Path,"open",original)
    result=asyncio.run(hub.select("local"))
    assert result["source"]=="local" and result["selection_storage_error"] is None
    assert (settings.parent/f".{settings.name}.recovery"/result["selection_recovery"]["id"]).read_bytes()==raw


def test_selection_read_permission_repair_uses_existing_choice_and_preserves_v1_extensions(tmp_path, monkeypatch):
    settings=tmp_path/"selection.json"
    raw=b'{"version":1,"selected_client_id":"old","vendor":{"keep":true}}'
    settings.write_bytes(raw)
    original, original_bytes = Path.read_text, Path.read_bytes
    def deny(path,*args,**kwargs):
        if path==settings: raise PermissionError("fixture selection read denied")
        return original(path,*args,**kwargs)
    def deny_bytes(path,*args,**kwargs):
        if path==settings: raise PermissionError("fixture selection read denied")
        return original_bytes(path,*args,**kwargs)
    monkeypatch.setattr(Path,"read_text",deny)
    monkeypatch.setattr(Path,"read_bytes",deny_bytes)
    hub=RemoteAudioHub(RemoteAudioServerConfig(False,"127.0.0.1",0,"",settings,0,"fixture"),local_player=lambda *_:None,local_stopper=lambda:None)
    assert hub.snapshot()["selection_storage_error"] and hub.source=="unavailable"
    hub.start_virtual_client(client_id="phone",name="Fixture",kind="phone",message_adapter_type="rabilink")
    assert original_bytes(settings)==raw and hub.selected_client_id is None
    monkeypatch.setattr(Path,"read_text",original)
    monkeypatch.setattr(Path,"read_bytes",original_bytes)
    result=asyncio.run(hub.select("remote","phone"))
    assert result["selected_client_id"]=="phone" and result["selection_storage_error"] is None
    assert json.loads(settings.read_text())["vendor"]=={"keep":True}
    assert (settings.parent/f".{settings.name}.recovery"/result["selection_recovery"]["id"]).read_bytes()==raw


@pytest.mark.parametrize("explicit", [False, True])
def test_current_selection_bytes_changed_after_init_are_checked_before_commit(tmp_path, explicit):
    settings=tmp_path/"selection.json"
    settings.write_text('{"version":1,"selected_client_id":null}',encoding="utf-8")
    hub=RemoteAudioHub(RemoteAudioServerConfig(False,"127.0.0.1",0,"",settings,0,"fixture"),local_player=lambda *_:None,local_stopper=lambda:None)
    raw=b'{damaged after owner initialization'
    settings.write_bytes(raw)
    if explicit:
        result=asyncio.run(hub.select("local"))
        backup=settings.parent/f".{settings.name}.recovery"/result["selection_recovery"]["id"]
        assert backup.read_bytes()==raw
        assert result["source"]=="local" and result["selection_storage_error"] is None
    else:
        result=hub.start_virtual_client(client_id="phone",name="Fixture",kind="phone",message_adapter_type="rabilink")
        assert settings.read_bytes()==raw and result["source"]=="unavailable"
        assert result["selection_storage_error"] and result["clients"][0]["id"]=="phone"


def test_commit_merges_current_extensions_and_respects_current_explicit_choice(tmp_path):
    settings=tmp_path/"selection.json"
    settings.write_text('{"version":1,"selected_client_id":null,"deleted":"old"}',encoding="utf-8")
    hub=RemoteAudioHub(RemoteAudioServerConfig(False,"127.0.0.1",0,"",settings,0,"fixture"),local_player=lambda *_:None,local_stopper=lambda:None)
    current={"version":1,"selected_client_id":"pinned-other","vendor":{"new":True}}
    settings.write_text(json.dumps(current),encoding="utf-8")
    hub.start_virtual_client(client_id="phone",name="Fixture",kind="phone",message_adapter_type="rabilink")
    assert json.loads(settings.read_text())==current and hub.selected_client_id=="pinned-other"
    asyncio.run(hub.select("remote","phone"))
    assert json.loads(settings.read_text())=={**current,"selected_client_id":"phone"}


def test_hard_exited_snapshot_stage_and_invalid_old_digest_do_not_block_same_owner_recovery(tmp_path):
    settings=tmp_path/"selection.json"
    raw=b'{original damaged selection'
    settings.write_bytes(raw)
    hub=RemoteAudioHub(RemoteAudioServerConfig(False,"127.0.0.1",0,"",settings,0,"fixture"),local_player=lambda *_:None,local_stopper=lambda:None)
    directory=settings.parent/f".{settings.name}.recovery"
    directory.mkdir()
    old=directory/(__import__("hashlib").sha256(raw).hexdigest()+".raw")
    old.write_bytes(b'{')
    code=r'''import os,sys,asyncio
from pathlib import Path
from rabispeech.remote_audio import RemoteAudioHub,RemoteAudioServerConfig
settings=Path(sys.argv[1]);hub=RemoteAudioHub(RemoteAudioServerConfig(False,"127.0.0.1",0,"",settings,0,"fixture"),local_player=lambda *_:None,local_stopper=lambda:None)
original=Path.open
class HardExit:
 def __init__(self,stream):self.stream=stream
 def __enter__(self):return self
 def __exit__(self,*args):return self.stream.__exit__(*args)
 def write(self,data):
  self.stream.write(data[:1]);self.stream.flush();os.fsync(self.stream.fileno());os._exit(29)
def opened(path,mode="r",*args,**kwargs):
 stream=original(path,mode,*args,**kwargs)
 return HardExit(stream) if mode=="xb" and path.name.endswith(".raw.tmp") else stream
Path.open=opened
asyncio.run(hub.select("local"))
'''
    process=subprocess.run([sys.executable,"-c",code,str(settings)],capture_output=True,text=True,timeout=15,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
    assert process.returncode==29,process.stdout+process.stderr
    partials={path:path.read_bytes() for path in directory.glob("*.tmp")}
    assert len(partials)==1 and next(iter(partials.values()))==raw[:1]
    assert settings.read_bytes()==raw
    result=asyncio.run(hub.select("local"))
    backup=directory/result["selection_recovery"]["id"]
    assert backup.read_bytes()==raw and backup!=old
    assert old.read_bytes()==b'{' and all(path.read_bytes()==data for path,data in partials.items())
    assert result["source"]=="local" and result["selection_storage_error"] is None
