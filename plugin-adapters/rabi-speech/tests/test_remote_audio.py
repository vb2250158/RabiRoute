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
