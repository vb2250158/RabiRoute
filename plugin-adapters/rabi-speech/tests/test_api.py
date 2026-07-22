from __future__ import annotations

import base64
import json
import os
import time
import wave
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Callable

import pytest
from fastapi.testclient import TestClient

from rabispeech.app import create_app
from rabispeech.config import load_settings
from rabispeech.contracts import (
    SpeechAudioArtifact,
    SpeechSynthesisRequest,
    TranscriptSegment,
    TranscriptionRequest,
    TranscriptionResult,
)
from rabispeech.registry import ProviderRegistry
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
    tts_cleanup_interval_seconds: float = 60.0,
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
            tts_audio_retention_minutes=1440,
            ffmpeg="",
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
        tts_cleanup_interval_seconds=tts_cleanup_interval_seconds,
    )), tts, asr


def auth() -> dict[str, str]:
    return {}


def test_loopback_microphone_status_and_contract_are_discoverable(tmp_path: Path) -> None:
    client, _tts, _asr = fixture(tmp_path)
    status = client.get("/v1/microphone/status")
    assert status.status_code == 200
    assert status.json()["mode"] == "host_resident"
    assert status.json()["running"] is False
    models = client.get("/v1/models").json()
    assert models["api"]["microphone_start"]["scope"] == "loopback-only"
    assert models["api"]["microphone_settings"]["endpoint"] == "/v1/microphone/settings"
    updated = client.put("/v1/microphone/settings", json={"record_threshold": 0.02, "route_id": "legacy-route"})
    assert updated.status_code == 200
    assert updated.json()["config"]["record_threshold"] == 0.02
    assert updated.json()["config"]["auto_submit"] is True
    assert updated.json()["config"]["route_id"] is None


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
    assert tts_record["audio_file"].endswith(".wav")
    assert tts_record["audio_file"].startswith("output/tts-audio/")
    assert tts_record["audio_expires_at"] > tts_record["time"]
    assert not Path(tts_record["audio_file"]).is_absolute()
    assert (tmp_path / "tts-audio" / Path(tts_record["audio_file"]).name).is_file()
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


def test_periodic_tts_cleanup_covers_registered_caches_and_stops_with_lifespan(tmp_path: Path) -> None:
    def setup(roles_root: Path) -> None:
        (roles_root / "XinghaiBuilder").mkdir(parents=True)

    client, _tts, _asr = fixture(
        tmp_path,
        setup,
        tts_cleanup_interval_seconds=0.01,
    )
    with client:
        assert client.post(
            "/v1/audio/speech",
            json={"model": "fake-tts/voice-model", "input": "人格缓存", "voice": "XinghaiBuilder"},
        ).status_code == 200
        assert client.post(
            "/v1/audio/speech",
            json={"model": "fake-tts/voice-model", "input": "全局缓存", "voice": "provider-voice"},
        ).status_code == 200
        cached = [
            *list((tmp_path / "roles" / "XinghaiBuilder" / "voice" / "cache" / "tts-audio").glob("*.wav")),
            *list((tmp_path / "tts-audio").glob("*.wav")),
        ]
        assert len(cached) == 2
        expired = time.time() - (24 * 60 * 60) - 1
        for path in cached:
            os.utime(path, (expired, expired))
        deadline = time.time() + 1
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
