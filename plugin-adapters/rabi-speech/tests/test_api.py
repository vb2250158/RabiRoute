from __future__ import annotations

import base64
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import hashlib
import os
import threading
import time
import wave
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Callable

import pytest
from fastapi.testclient import TestClient

from rabispeech.app import _RABILINK_AUDIO_STALE_TIMEOUT_SECONDS, create_app
from rabispeech.config import load_settings
from rabispeech.contracts import (
    SpeechAudioArtifact,
    SpeechSynthesisRequest,
    TranscriptSegment,
    TranscriptionRequest,
    TranscriptionResult,
)
from rabispeech.registry import ProviderRegistry
from rabispeech.tts_audio_store import TtsAudioStoreRegistry
from rabispeech.windows_audio_session import WindowsAudioSessionKeepalive


class FakeTts:
    provider_id = "fake-tts"

    def __init__(self, output: Path) -> None:
        self.output = output
        self.requests: list[SpeechSynthesisRequest] = []

    async def synthesize(self, request: SpeechSynthesisRequest) -> SpeechAudioArtifact:
        self.requests.append(request)
        return SpeechAudioArtifact(self.output, "audio/wav", self.provider_id, request.model)

    def capabilities(self) -> dict[str, object]:
        return {"kind": "tts", "enabled": True}


def test_default_rabilink_audio_stale_timeout_covers_relay_request_deadline() -> None:
    assert _RABILINK_AUDIO_STALE_TIMEOUT_SECONDS >= 75.0


class FakeAsr:
    provider_id = "fake-asr"

    def __init__(self) -> None:
        self.requests: list[TranscriptionRequest] = []
        self.speaker: str | None = None

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        self.requests.append(request)
        assert request.audio_path.read_bytes()
        return TranscriptionResult(
            text="本地识别成功",
            language="zh",
            duration=1.25,
            provider=self.provider_id,
            model=request.model,
            segments=[TranscriptSegment(id=0, start=0.0, end=1.25, text="本地识别成功", speaker=self.speaker)],
        )

    def capabilities(self) -> dict[str, object]:
        return {"kind": "asr", "enabled": True, "model": "test"}


class SlowWarmupAsr(FakeAsr):
    def __init__(self) -> None:
        super().__init__()
        self.warmup_started = False

    async def warmup(self) -> None:
        self.warmup_started = True
        await asyncio.Event().wait()


class SlowCapabilitiesAsr(FakeAsr):
    def __init__(self) -> None:
        super().__init__()
        self.capability_reads = 0

    def capabilities(self) -> dict[str, object]:
        self.capability_reads += 1
        time.sleep(0.2)
        return super().capabilities()


def wav_file(path: Path) -> Path:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * 160)
    return path


def fixture(
    tmp_path: Path,
    setup_roles: Callable[[Path], None] | None = None,
    *,
    roles_root: Path | None = None,
    tts_audio_dir: Path | None = None,
    tts_audio_retention_minutes: float = 1440.0,
    rabilink_audio_stale_timeout_seconds: float = 15.0,
) -> tuple[TestClient, FakeTts, FakeAsr]:
    settings = load_settings(Path(__file__).parents[1] / "config.example.json")
    settings = replace(
        settings,
        speaker_recognition=replace(settings.speaker_recognition, enabled=False),
        server=replace(
            settings.server,
            temp_dir=tmp_path / "temp",
            playback_dir=tmp_path / "playback",
            records_dir=tmp_path / "records",
            tts_audio_dir=tts_audio_dir or tmp_path / "tts-audio",
            tts_audio_retention_minutes=tts_audio_retention_minutes,
            ffmpeg="",
        ),
        remote_audio=replace(
            settings.remote_audio,
            settings_path=tmp_path / "audio-stream-settings.json",
        ),
    )
    tts = FakeTts(wav_file(tmp_path / "speech.wav"))
    asr = FakeAsr()
    registry = ProviderRegistry(tts.provider_id, asr.provider_id)
    registry.register_tts(tts)
    registry.register_asr(asr)
    roles_root = roles_root or tmp_path / "roles"
    if setup_roles:
        setup_roles(roles_root)
    return TestClient(create_app(
        settings,
        registry,
        audio_session_keepalive=WindowsAudioSessionKeepalive(enabled=False),
        roles_root=roles_root,
        rabilink_audio_stale_timeout_seconds=rabilink_audio_stale_timeout_seconds,
    )), tts, asr


def auth() -> dict[str, str]:
    return {}


def test_loopback_microphone_status_and_contract_are_discoverable(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)
    status = client.get("/v1/microphone/status")
    assert status.status_code == 200
    assert status.json()["mode"] == "host_resident"
    assert status.json()["running"] is False
    assert status.json()["config"]["streaming_enabled"] is False
    assert status.json()["config"]["barge_in_mode"] == "off"
    assert status.json()["config"]["barge_in_confirm_ms"] == 200
    models = client.get("/v1/models").json()
    assert models["api"]["microphone_start"]["scope"] == "loopback-only"
    assert models["api"]["microphone_settings"]["endpoint"] == "/v1/microphone/settings"
    updated = client.put("/v1/microphone/settings", json={
        "record_threshold": 0.02,
        "route_id": "legacy-route",
        "barge_in_mode": "echo_protected",
        "barge_in_confirm_ms": 250,
        "streaming_enabled": False,
    })
    assert updated.status_code == 200
    assert updated.json()["config"]["record_threshold"] == 0.02
    assert updated.json()["config"]["auto_submit"] is True
    assert updated.json()["config"]["route_id"] is None
    assert updated.json()["config"]["barge_in_mode"] == "echo_protected"
    assert updated.json()["config"]["barge_in_confirm_ms"] == 250
    assert updated.json()["config"]["streaming_enabled"] is False
    assert updated.json()["running"] is False
    invalid = client.put("/v1/microphone/settings", json={"barge_in_mode": "unsupported"})
    assert invalid.status_code == 200
    assert invalid.json()["config"]["barge_in_mode"] == "off"
    assert invalid.json()["config"]["streaming_enabled"] is False


def test_health_is_available_while_provider_warmup_continues(tmp_path: Path) -> None:
    settings = load_settings(Path(__file__).parents[1] / "config.example.json")
    settings = replace(
        settings,
        speaker_recognition=replace(settings.speaker_recognition, enabled=False),
        server=replace(
            settings.server,
            temp_dir=tmp_path / "temp",
            playback_dir=tmp_path / "playback",
            records_dir=tmp_path / "records",
            tts_audio_dir=tmp_path / "tts-audio",
            ffmpeg="",
        ),
        remote_audio=replace(settings.remote_audio, settings_path=tmp_path / "audio-stream-settings.json"),
    )
    tts = FakeTts(wav_file(tmp_path / "speech.wav"))
    asr = SlowWarmupAsr()
    registry = ProviderRegistry(tts.provider_id, asr.provider_id)
    registry.register_tts(tts)
    registry.register_asr(asr)
    client = TestClient(create_app(
        settings,
        registry,
        audio_session_keepalive=WindowsAudioSessionKeepalive(enabled=False),
        roles_root=tmp_path / "roles",
    ))

    with client:
        assert client.get("/health").status_code == 200
        deadline = time.time() + 2
        while not asr.warmup_started and time.time() < deadline:
            time.sleep(0.01)
        assert asr.warmup_started


def test_health_does_not_wait_for_full_provider_discovery(tmp_path: Path) -> None:
    settings = load_settings(Path(__file__).parents[1] / "config.example.json")
    settings = replace(
        settings,
        speaker_recognition=replace(settings.speaker_recognition, enabled=False),
        server=replace(
            settings.server,
            temp_dir=tmp_path / "temp",
            playback_dir=tmp_path / "playback",
            records_dir=tmp_path / "records",
            tts_audio_dir=tmp_path / "tts-audio",
            ffmpeg="",
        ),
        remote_audio=replace(settings.remote_audio, settings_path=tmp_path / "audio-stream-settings.json"),
    )
    tts = FakeTts(wav_file(tmp_path / "speech.wav"))
    asr = SlowCapabilitiesAsr()
    registry = ProviderRegistry(tts.provider_id, asr.provider_id)
    registry.register_tts(tts)
    registry.register_asr(asr)
    client = TestClient(create_app(
        settings,
        registry,
        audio_session_keepalive=WindowsAudioSessionKeepalive(enabled=False),
        roles_root=tmp_path / "roles",
    ))

    started = time.perf_counter()
    response = client.get("/health")
    elapsed = time.perf_counter() - started

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert set(response.json()) == {"ok", "service"}
    assert asr.capability_reads == 0
    assert elapsed < 0.2


def test_rabilink_audio_stream_reuses_host_microphone_vad_and_asr_runtime(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)
    started = client.post("/v1/audio-streams/rabilink/start", json={
        "stream_id": "phone-one-audio",
        "name": "Rabi Android · HBP-AL00 · abc123",
        "device_kind": "mobile",
        "device_model": "HBP-AL00",
        "source_device_id": "phone-one-stable",
        "message_adapter_type": "speech",
        "route_profile_id": "mobile-main",
        "session_id": "phone-one",
    })
    assert started.status_code == 200
    assert started.json()["source"] == "remote"
    assert started.json()["rabilink_chunk_protocol"] == {
        "version": 2,
        "durable_ack_tuple": True,
        "cross_process_claim": True,
        "ambiguous_replay_policy": "retain_without_ack",
        "ambiguous_resolution": "explicit_operator_decision",
    }
    assert started.json()["durable_chunk_ledger"]["retention"] == "indefinite_until_explicit_source_retirement"
    assert started.json()["durable_chunk_ledger"]["automatic_pruning"] is False
    selected = started.json()["clients"][0]
    assert selected["id"] == "phone-one-audio"
    assert selected["name"] == "Rabi Android · HBP-AL00 · abc123"
    assert selected["device_model"] == "HBP-AL00"
    assert selected["source_device_id"] == "phone-one-stable"
    assert selected["message_adapter_type"] == "rabilink"
    assert selected["received_bytes"] == 0
    assert any(event["kind"] == "client_connected" for event in started.json()["events"])
    chunk = client.post(
        "/v1/audio-streams/rabilink/chunk?streamId=phone-one-audio&sequence=1&chunkId=audio-00000000000000000001",
        content=b"\x00\x00" * 1600,
        headers={"content-type": "application/octet-stream"},
    )
    assert chunk.status_code == 200
    assert chunk.json()["accepted_bytes"] == 3200
    assert chunk.json()["sequence"] == 1
    assert chunk.json()["chunk_id"] == "audio-00000000000000000001"
    assert chunk.json()["sha256"] == hashlib.sha256(b"\x00\x00" * 1600).hexdigest()
    stream_after_chunk = client.get("/v1/audio-streams").json()
    assert stream_after_chunk["clients"][0]["last_chunk_id"] == "audio-00000000000000000001"
    assert stream_after_chunk["clients"][0]["last_chunk_bytes"] == 3200
    assert stream_after_chunk["clients"][0]["last_chunk_sha256"] == chunk.json()["sha256"]
    assert stream_after_chunk["events"][0]["kind"] == "pcm_received"
    assert stream_after_chunk["events"][0]["direction"] == "inbound"
    assert stream_after_chunk["events"][0]["total_bytes"] == 3200
    duplicate = client.post(
        "/v1/audio-streams/rabilink/chunk?streamId=phone-one-audio&sequence=1&chunkId=audio-00000000000000000001",
        content=b"\x00\x00" * 1600,
        headers={"content-type": "application/octet-stream"},
    )
    assert duplicate.status_code == 200
    assert duplicate.json()["sha256"] == chunk.json()["sha256"]
    conflicting_duplicate = client.post(
        "/v1/audio-streams/rabilink/chunk?streamId=phone-one-audio&sequence=1&chunkId=audio-conflict",
        content=b"\x00\x00" * 1600,
        headers={"content-type": "application/octet-stream"},
    )
    assert conflicting_duplicate.status_code == 409
    assert "id, byte count, or checksum" in conflicting_duplicate.json()["detail"]
    out_of_order = client.post(
        "/v1/audio-streams/rabilink/chunk?streamId=phone-one-audio&sequence=3&chunkId=audio-00000000000000000003",
        content=b"\x00\x00" * 1600,
        headers={"content-type": "application/octet-stream"},
    )
    assert out_of_order.status_code == 409
    assert "expected 2, received 3" in out_of_order.json()["detail"]
    stopped = client.post("/v1/audio-streams/rabilink/stop", json={"stream_id": "phone-one-audio"})
    assert stopped.status_code == 200
    assert client.get("/v1/microphone/status").json()["running"] is True
    stopped_state = client.get("/v1/audio-streams").json()
    assert stopped_state["selected_client_id"] == "phone-one-audio"
    assert stopped_state["selected_online"] is False
    history = client.get(
        "/v1/audio-streams/events",
        params={"source_device_id": "phone-one-stable", "limit": 20},
    )
    assert history.status_code == 200
    history_kinds = [event["kind"] for event in history.json()["events"]]
    assert "client_disconnected" in history_kinds
    assert "pcm_received" in history_kinds
    reopened, _tts_again, _asr_again = fixture(tmp_path)
    persisted = reopened.get(
        "/v1/audio-streams/events",
        params={"source_device_id": "phone-one-stable", "limit": 20},
    ).json()["events"]
    assert any(event["kind"] == "client_connected" for event in persisted)
    assert any(event["kind"] == "pcm_received" for event in persisted)


def test_rabilink_operator_lifecycle_endpoints_require_exact_evidence_and_retain_retirement_audit(
    tmp_path: Path,
) -> None:
    client, _tts, _asr = fixture(tmp_path)
    assert client.post("/v1/audio-streams/rabilink/start", json={
        "stream_id": "retire-phone-audio", "source_device_id": "retire-phone",
    }).status_code == 200
    payload = b"\x00\x00" * 160
    assert client.post(
        "/v1/audio-streams/rabilink/chunk?streamId=retire-phone-audio&sequence=1&chunkId=audio-00000000000000000001",
        content=payload, headers={"content-type": "application/octet-stream"},
    ).status_code == 200
    tuples = client.get(
        "/v1/audio-streams/rabilink/ledger/tuples",
        params={"sourceDeviceId": "retire-phone", "afterSourceSequence": 0, "limit": 1},
    )
    assert tuples.status_code == 200
    assert tuples.json()["records"] == [{
        "source_device_id": "retire-phone",
        "chunk_id": "audio-00000000000000000001",
        "accepted_bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "source_sequence": 1,
        "stream_sequence": 1,
        "terminal": True,
        "terminal_status": "processed",
        "processed_at": tuples.json()["records"][0]["processed_at"],
    }]
    refused = client.post("/v1/audio-streams/rabilink/sources/retire", json={
        "source_device_id": "retire-phone", "phone_spool_empty": True,
        "maximum_phone_retention_elapsed": True, "operator_confirmation": "yes",
    })
    assert refused.status_code == 409
    assert client.post("/v1/audio-streams/rabilink/stop", json={
        "stream_id": "retire-phone-audio",
    }).status_code == 200
    retired = client.post("/v1/audio-streams/rabilink/sources/retire", json={
        "source_device_id": "retire-phone", "phone_spool_empty": True,
        "maximum_phone_retention_elapsed": True,
        "operator_confirmation": "retire:retire-phone",
    })
    assert retired.status_code == 200
    assert retired.json()["removed_chunks"] == 1
    assert retired.json()["removed_bytes"] == len(payload)
    assert retired.json()["audit_retained"] is True
    ledger = client.get("/v1/audio-streams").json()["durable_chunk_ledger"]
    assert ledger["retired_sources"] == 1
    missing = client.post("/v1/audio-streams/rabilink/ambiguous/resolve", json={
        "source_device_id": "retire-phone", "chunk_id": "missing", "accepted_bytes": 2,
        "sha256": hashlib.sha256(b"\x00\x00").hexdigest(), "decision": "skip",
    })
    assert missing.status_code == 409


def test_rabilink_audio_stream_expiry_is_rearmed_by_pcm_events(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path, rabilink_audio_stale_timeout_seconds=0.3)
    with client:
        started = client.post("/v1/audio-streams/rabilink/start", json={
            "stream_id": "phone-event-audio",
            "source_device_id": "phone-event",
            "route_profile_id": "mobile-main",
            "session_id": "phone-event",
        })
        assert started.status_code == 200
        time.sleep(0.1)
        chunk = client.post(
            "/v1/audio-streams/rabilink/chunk?streamId=phone-event-audio&sequence=1&chunkId=audio-event-1",
            content=b"\x00\x00" * 160,
            headers={"content-type": "application/octet-stream"},
        )
        assert chunk.status_code == 200
        time.sleep(0.15)
        assert client.get("/v1/microphone/status").json()["running"] is True
        time.sleep(0.2)
        assert client.get("/v1/microphone/status").json()["running"] is True
        expired = client.get("/v1/audio-streams").json()
        assert expired["selected_client_id"] == "phone-event-audio"
        assert expired["selected_online"] is False


def test_rabilink_unselected_virtual_client_does_not_ack_or_advance_sequence(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)
    first = client.post("/v1/audio-streams/rabilink/start", json={
        "stream_id": "selected-phone-audio",
        "source_device_id": "selected-phone",
        "route_profile_id": "route-a",
        "session_id": "selected-phone",
    })
    assert first.status_code == 200
    second = client.post("/v1/audio-streams/rabilink/start", json={
        "stream_id": "unselected-phone-audio",
        "source_device_id": "unselected-phone",
        "route_profile_id": "route-b",
        "session_id": "unselected-phone",
    })
    assert second.status_code == 200

    rejected = client.post(
        "/v1/audio-streams/rabilink/chunk?streamId=unselected-phone-audio&sequence=1&chunkId=audio-unselected-1",
        content=b"\x00\x00" * 160,
        headers={"content-type": "application/octet-stream"},
    )

    assert rejected.status_code == 409
    snapshot = client.get("/v1/audio-streams").json()
    unselected = next(row for row in snapshot["clients"] if row["id"] == "unselected-phone-audio")
    assert unselected["last_sequence"] == 0
    assert unselected["last_chunk_id"] is None
    assert unselected["received_bytes"] == 0


def test_rabilink_audio_stream_keepalive_preserves_online_selection_without_fake_pcm(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path, rabilink_audio_stale_timeout_seconds=0.3)
    with client:
        started = client.post("/v1/audio-streams/rabilink/start", json={
            "stream_id": "phone-keepalive-audio",
            "source_device_id": "phone-keepalive",
            "route_profile_id": "mobile-main",
            "session_id": "phone-keepalive",
        })
        assert started.status_code == 200
        time.sleep(0.2)
        kept_alive = client.post(
            "/v1/audio-streams/rabilink/keepalive?streamId=phone-keepalive-audio",
        )
        assert kept_alive.status_code == 200
        assert kept_alive.json()["received_bytes"] == 0
        time.sleep(0.2)
        snapshot = client.get("/v1/audio-streams").json()
        assert snapshot["selected_online"] is True
        assert snapshot["clients"][0]["received_bytes"] == 0
        time.sleep(0.2)
        assert client.get("/v1/audio-streams").json()["selected_online"] is False


def test_host_playback_volume_api_persists_and_supports_put_and_patch(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)

    assert client.get("/v1/playback/status").json()["volume"] == 100
    updated = client.put("/v1/playback/settings", json={"volume": 35})
    assert updated.status_code == 200
    assert updated.json()["volume"] == 35
    patched = client.patch("/v1/playback/settings", json={"volume": 64})
    assert patched.status_code == 200
    assert patched.json()["volume"] == 64
    assert json.loads((tmp_path / "playback-settings.json").read_text(encoding="utf-8"))["volume"] == 64
    assert client.put("/v1/playback/settings", json={"volume": -1}).status_code == 422
    assert client.patch("/v1/playback/settings", json={"volume": 101}).status_code == 422
    assert client.patch("/v1/playback/settings", json={"volume": True}).status_code == 422

    discovery = client.get("/v1/capabilities").json()["api"]["playback_settings"]
    assert discovery == {
        "method": "PUT",
        "endpoint": "/v1/playback/settings",
        "scope": "loopback-only",
    }


def test_openai_style_tts(tmp_path: Path) -> None:
    client, tts, _asr = fixture(tmp_path)
    profile = tmp_path / "roles" / "character-a" / "voice" / "voice-profile.json"
    profile.parent.mkdir(parents=True)
    profile.write_text(json.dumps({
        "default_model": "fake-tts/persona-model",
        "language": "zh-CN",
        "instructions": "稳重表达。",
        "speed": 0.9,
    }, ensure_ascii=False), encoding="utf-8")
    response = client.post(
        "/v1/audio/speech",
        headers=auth(),
        json={"model": "fake-tts/voice-model", "input": "你好", "voice": "CHARACTER-A", "response_format": "wav"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.headers["x-rabispeech-provider"] == "fake-tts"
    assert tts.requests[0].model == "persona-model"
    assert tts.requests[0].voice == "CHARACTER-A"
    assert tts.requests[0].language == "zh-CN"
    assert tts.requests[0].instructions == "稳重表达。"
    assert tts.requests[0].speed == 0.9
    persona_cache = tmp_path / "roles" / "character-a" / "voice" / "cache" / "tts-audio"
    retained = list(persona_cache.glob("*.wav"))
    assert len(retained) == 1
    assert not list((tmp_path / "tts-audio").glob("*.wav"))
    record = client.get("/v1/records", params={"kind": "tts"}).json()["data"][0]
    assert record["audio_file"] == f"character-a/voice/cache/tts-audio/{retained[0].name}"
    assert not Path(record["audio_file"]).is_absolute()


def test_openai_style_asr_and_verbose_response(tmp_path: Path) -> None:
    client, _tts, asr = fixture(tmp_path)
    response = client.post(
        "/v1/audio/transcriptions",
        headers=auth(),
        files={"file": ("sample.wav", wav_file(tmp_path / "sample.wav").read_bytes(), "audio/wav")},
        data={"model": "fake-asr/test", "response_format": "verbose_json", "language": "zh"},
    )
    assert response.status_code == 200
    assert response.json()["text"] == "本地识别成功"
    assert response.json()["provider"] == "fake-asr"
    assert response.json()["segments"][0]["end"] == 1.25
    assert asr.requests[0].language == "zh"


def test_tts_and_asr_records_are_written_by_date_and_queryable(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)
    speech = client.post(
        "/v1/audio/speech",
        json={
            "model": "fake-tts/voice-model",
            "input": "星海回复",
            "voice": "XinghaiBuilder",
            "session_id": "meeting-one",
            "route_id": "XinghaiBuilder-main",
        },
    )
    assert speech.status_code == 200
    transcription = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("sample.wav", wav_file(tmp_path / "record.wav").read_bytes(), "audio/wav")},
        data={
            "model": "fake-asr/test",
            "response_format": "verbose_json",
            "session_id": "meeting-one",
            "route_id": "XinghaiBuilder-main",
        },
    )
    assert transcription.status_code == 200
    records = client.get("/v1/records", params={"session_id": "meeting-one"}).json()["data"]
    assert {item["kind"] for item in records} == {"tts", "asr"}
    tts_record = next(item for item in records if item["kind"] == "tts")
    asr_record = next(item for item in records if item["kind"] == "asr")
    assert tts_record["audio_file"].endswith(".wav")
    assert tts_record["audio_file"].startswith("output/tts-audio/")
    assert tts_record["audio_expires_at"] > tts_record["time"]
    assert not Path(tts_record["audio_file"]).is_absolute()
    assert (tmp_path / "tts-audio" / Path(tts_record["audio_file"]).name).is_file()
    assert asr_record["audio_file"].startswith("output/asr-audio/")
    assert asr_record["audio_expires_at"] > asr_record["time"]
    original = client.get(f"/v1/records/{asr_record['id']}/audio")
    assert original.status_code == 200
    assert original.headers["content-type"].startswith("audio/")
    assert original.content.startswith(b"RIFF")
    assert (tmp_path / "records" / f"{datetime.now():%Y-%m-%d}.jsonl").is_file()


def test_existing_persona_tts_cache_is_cleaned_at_service_start(tmp_path: Path) -> None:
    expired: Path | None = None

    def setup(roles_root: Path) -> None:
        nonlocal expired
        cache = roles_root / "XinghaiBuilder" / "voice" / "cache" / "tts-audio"
        cache.mkdir(parents=True)
        expired = cache / "expired.wav"
        expired.write_bytes(b"RIFF-expired")
        old = time.time() - (24 * 60 * 60) - 1
        os.utime(expired, (old, old))

    client, _tts, _asr = fixture(tmp_path, setup)

    assert client.get("/health").status_code == 200
    assert expired is not None
    assert not expired.exists()


def test_health_does_not_wait_for_initial_tts_cache_cleanup(tmp_path: Path, monkeypatch) -> None:
    cleanup_started = threading.Event()
    release_cleanup = threading.Event()

    def blocked_cleanup(_registry: TtsAudioStoreRegistry, _now: float | None = None) -> list[Path]:
        cleanup_started.set()
        assert release_cleanup.wait(timeout=5)
        return []

    monkeypatch.setattr(TtsAudioStoreRegistry, "cleanup", blocked_cleanup)
    client, _tts, _asr = fixture(tmp_path)
    response_ready = threading.Event()
    responses = []

    def health_request():
        with client:
            responses.append(client.get("/health"))
            response_ready.set()

    with ThreadPoolExecutor(max_workers=1) as executor:
        request = executor.submit(health_request)
        assert cleanup_started.wait(timeout=10)
        try:
            assert response_ready.wait(timeout=0.5)
        finally:
            release_cleanup.set()
        request.result(timeout=5)

    assert responses[0].status_code == 200


def test_deadline_tts_cleanup_covers_registered_caches_and_stops_with_lifespan(tmp_path: Path) -> None:
    fallback_cache = tmp_path / "tts-audio"
    fallback_cache.mkdir(parents=True)
    fallback = fallback_cache / "fallback-near-expiry.wav"
    fallback.write_bytes(b"RIFF-fallback")

    def setup(roles_root: Path) -> None:
        persona_cache = roles_root / "XinghaiBuilder" / "voice" / "cache" / "tts-audio"
        persona_cache.mkdir(parents=True)
        (persona_cache / "persona-near-expiry.wav").write_bytes(b"RIFF-persona")

    client, _tts, _asr = fixture(
        tmp_path,
        setup,
        tts_audio_dir=fallback_cache,
        tts_audio_retention_minutes=1.0,
    )
    persona = tmp_path / "roles" / "XinghaiBuilder" / "voice" / "cache" / "tts-audio" / "persona-near-expiry.wav"
    # Keep both files just inside the retention window during initial cleanup,
    # then let the scheduled deadline remove them.
    near_expiry = time.time() - 58.0
    os.utime(fallback, (near_expiry, near_expiry))
    os.utime(persona, (near_expiry, near_expiry))
    with client:
        cached = [persona, fallback]
        assert all(path.exists() for path in cached)
        deadline = time.time() + 4
        while any(path.exists() for path in cached) and time.time() < deadline:
            time.sleep(0.01)
        assert not any(path.exists() for path in cached)

    stopped = tmp_path / "tts-audio" / "after-shutdown.wav"
    stopped.write_bytes(b"RIFF-stopped")
    expired = time.time() - (24 * 60 * 60) - 1
    os.utime(stopped, (expired, expired))
    time.sleep(0.05)
    assert stopped.exists()


def test_create_app_rejects_overlapping_fallback_and_roles_roots(tmp_path: Path) -> None:
    roles_root = tmp_path / "roles"

    with pytest.raises(ValueError, match="must not overlap"):
        fixture(tmp_path, roles_root=roles_root, tts_audio_dir=roles_root / "tts-audio")

    with pytest.raises(ValueError, match="must not overlap"):
        fixture(tmp_path, roles_root=roles_root, tts_audio_dir=tmp_path)


def test_create_app_rejects_persona_cache_symlink_to_fallback(tmp_path: Path) -> None:
    fallback = tmp_path / "fallback"
    fallback.mkdir()

    def setup(roles_root: Path) -> None:
        cache_parent = roles_root / "Rabi" / "voice" / "cache"
        cache_parent.mkdir(parents=True)
        try:
            (cache_parent / "tts-audio").symlink_to(fallback, target_is_directory=True)
        except OSError:
            pytest.skip("Directory symlinks are unavailable on this Windows host.")

    with pytest.raises(ValueError, match="TTS cache"):
        fixture(tmp_path, setup, tts_audio_dir=fallback)


def test_non_persona_voice_and_path_like_voice_use_global_tts_cache(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)

    for voice in ("provider-voice", "../outside"):
        response = client.post(
            "/v1/audio/speech",
            json={"model": "fake-tts/voice-model", "input": "全局缓存", "voice": voice},
        )
        assert response.status_code == 200

    assert len(list((tmp_path / "tts-audio").glob("*.wav"))) == 2
    assert not (tmp_path / "outside" / "voice" / "cache" / "tts-audio").exists()
    records = client.get("/v1/records", params={"kind": "tts"}).json()["data"]
    assert all(str(row["audio_file"]).startswith("output/tts-audio/") for row in records)


def test_dashscope_style_tts_and_asr_data_uri(tmp_path: Path) -> None:
    client, tts, _asr = fixture(tmp_path)
    speech = client.post(
        "/api/v1/services/audio/tts/SpeechSynthesizer",
        headers=auth(),
        json={"model": "fake-tts/local", "input": {"text": "兼容请求", "voice": "default", "format": "wav"}},
    )
    assert speech.status_code == 200
    assert tts.requests[-1].text == "兼容请求"

    audio = wav_file(tmp_path / "dash.wav").read_bytes()
    encoded = "data:audio/wav;base64," + base64.b64encode(audio).decode("ascii")
    transcription = client.post(
        "/api/v1/services/audio/asr/transcription",
        headers=auth(),
        json={"model": "fake-asr/local", "input": {"file_url": encoded}, "parameters": {"language_hints": ["zh"]}},
    )
    assert transcription.status_code == 200
    assert transcription.json()["output"]["task_status"] == "SUCCEEDED"
    assert transcription.json()["output"]["text"] == "本地识别成功"


def test_models_are_generated_from_provider_registry(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)
    response = client.get("/v1/models", headers=auth())
    assert response.status_code == 200
    rows = json.loads(response.text)["data"]
    assert {(row["capability"], row["provider"]) for row in rows} == {
        ("tts", "fake-tts"),
        ("asr", "fake-asr"),
    }
    tts = next(row for row in rows if row["capability"] == "tts")
    assert tts["request"]["required"] == ["model", "input"]
    assert tts["request"]["content_type"] == "application/json"
    detail = client.get(f"/v1/models/{tts['id']}")
    assert detail.status_code == 200
    assert detail.json()["request"]["endpoint"] == "/v1/audio/speech"


def test_public_discovery_redacts_private_paths_and_urls(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)
    health = client.get("/health").json()
    assert "config" not in health
    capabilities = client.get("/v1/capabilities").json()
    encoded = json.dumps(capabilities)
    assert "model_root" not in encoded
    assert "base_url" not in encoded
    assert capabilities["api"]["models"]["endpoint"] == "/v1/models"


def test_local_speaker_profile_api_resolves_diarization_labels_in_response_and_records(tmp_path: Path) -> None:
    client, _tts, asr = fixture(tmp_path)
    capability = client.get("/v1/capabilities").json()["speaker_identity"]
    assert capability["manual_binding"] is True
    assert capability["voiceprint"]["supported"] is False
    assert capability["stores_raw_enrollment_audio"] is False
    assert client.get("/v1/capabilities").json()["api"]["speaker_identity"]["endpoint"] == "/v1/speaker-identities"

    identified = client.put(
        "/v1/speaker-identities",
        json={
            "session_id": "meeting-one",
            "record_id": "speech-seed",
            "speaker_label": "Speaker 1",
            "display_name": "秋雨",
            "aliases": ["Qiu Yu"],
        },
    )
    assert identified.status_code == 200
    assert identified.json()["created"] is True
    assert identified.json()["binding"]["speaker_name"] == "秋雨"
    profile = identified.json()["profile"]

    reused = client.put(
        "/v1/speaker-identities",
        json={
            "session_id": "meeting-one",
            "record_id": "speech-seed",
            "speaker_label": "Speaker 1",
            "display_name": "qiu yu",
        },
    )
    assert reused.status_code == 200
    assert reused.json()["created"] is False
    assert reused.json()["profile"]["id"] == profile["id"]
    assert profile["id"].startswith("speaker-")

    asr.speaker = "Speaker 1"
    response = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("sample.wav", wav_file(tmp_path / "speaker.wav").read_bytes(), "audio/wav")},
        data={"model": "fake-asr/test", "response_format": "verbose_json", "session_id": "meeting-one"},
    )
    assert response.status_code == 200
    segment = response.json()["segments"][0]
    assert segment["speaker"] == "Speaker 1"
    assert segment["speaker_label"] == "Speaker 1"
    assert segment["speaker_id"] is None
    assert segment["speaker_name"] is None
    assert segment["speaker_decision"] == "unbound_diarization_label"

    records = client.get("/v1/records", params={"session_id": "meeting-one"}).json()["data"]
    record_id = records[0]["id"]
    binding = client.put(
        "/v1/speaker-bindings",
        json={
            "session_id": "meeting-one",
            "record_id": record_id,
            "speaker_label": "Speaker 1",
            "speaker_id": profile["id"],
        },
    )
    assert binding.status_code == 200
    assert binding.json()["record_id"] == record_id
    assert binding.json()["speaker_name"] == "秋雨"

    updated = client.patch(f"/v1/speaker-profiles/{profile['id']}", json={"display_name": "秋雨（QA）"})
    assert updated.status_code == 200
    records = client.get("/v1/records", params={"session_id": "meeting-one"}).json()["data"]
    assert records[0]["segments"][0]["speaker_name"] == "秋雨（QA）"
    listed = client.get("/v1/speaker-profiles", params={"session_id": "meeting-one"}).json()
    assert listed["bindings"][0]["speaker_name"] == "秋雨（QA）"

    removed = client.delete(f"/v1/speaker-profiles/{profile['id']}")
    assert removed.status_code == 200
    assert removed.json()["removed_bindings"] == 2


def test_agent_speaker_identity_api_requires_explicit_id_for_ambiguous_metadata(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)
    first = client.post("/v1/speaker-profiles", json={"display_name": "秋雨", "aliases": ["主持人"]}).json()
    client.post("/v1/speaker-profiles", json={"display_name": "刘云云", "aliases": ["主持人"]})

    ambiguous = client.put(
        "/v1/speaker-identities",
        json={
            "session_id": "meeting-one",
            "record_id": "speech-one",
            "speaker_label": "Speaker 1",
            "display_name": "主持人",
        },
    )
    assert ambiguous.status_code == 409

    explicit = client.put(
        "/v1/speaker-identities",
        json={
            "session_id": "meeting-one",
            "record_id": "speech-one",
            "speaker_label": "Speaker 1",
            "speaker_id": first["id"],
        },
    )
    assert explicit.status_code == 200
    assert explicit.json()["profile"]["id"] == first["id"]
