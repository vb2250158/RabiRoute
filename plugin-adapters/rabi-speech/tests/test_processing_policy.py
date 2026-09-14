import asyncio
import pytest
from rabispeech.remote_audio import RemoteAudioHub, RemoteAudioServerConfig
from rabispeech.microphone import SpeechInputSource


def hub_at(path):
    return RemoteAudioHub(RemoteAudioServerConfig(enabled=False, host="127.0.0.1", port=8782,
        token="", settings_path=path / "selection.json", discovery_port=8783, service_name="test"),
        local_player=lambda *_: None, local_stopper=lambda: None)


def test_policy_and_attribution_are_frozen_across_restart(tmp_path):
    args = dict(client_id="stream", name="Phone", kind="mobile", source_device_id="phone",
        message_adapter_type="rabilink", route_profile_id="route", session_id="session",
        processing_policy="transcribe", capture_id="capture")
    hub = hub_at(tmp_path)
    hub.start_virtual_client(**args)
    assert hub.selected_processing_policy == "transcribe"
    assert hub.selected_capture_id == "capture"
    hub.start_virtual_client(**args)
    for field, value in [("processing_policy", "agent"), ("route_profile_id", "other"),
                         ("kind", "glasses"), ("source_device_id", "other"), ("capture_id", "other")]:
        with pytest.raises(ValueError, match="frozen contract"):
            hub_at(tmp_path).start_virtual_client(**{**args, field: value})


def test_chunk_cannot_be_replayed_under_agent_policy(tmp_path):
    hub = hub_at(tmp_path)
    seen = []
    hub.set_feed(lambda *args: seen.append(args))
    args = dict(name="Phone", kind="mobile", source_device_id="phone", message_adapter_type="rabilink")
    hub.start_virtual_client(client_id="a", processing_policy="transcribe", **args)
    asyncio.run(hub.start_capture(16000, 100))
    assert hub.feed_virtual_client("a", b"\0\0", sequence=1, chunk_id="chunk")
    assert hub.feed_virtual_client("a", b"\0\0", sequence=1, chunk_id="chunk")
    hub.start_virtual_client(client_id="b", processing_policy="agent", **args)
    with pytest.raises(ValueError, match="frozen contract"):
        hub.feed_virtual_client("b", b"\0\0", sequence=1, chunk_id="chunk")
    assert len(seen) == 1


def test_api_capabilities_and_validation(tmp_path):
    from test_api import fixture
    client, _, _ = fixture(tmp_path)
    caps = client.get("/v1/capabilities").json()["rabilinkAudioStream"]
    assert caps == {"version": 1, "processingPolicies": ["transcribe", "agent"], "processingPolicyFrozen": True}
    body = {"stream_id": "new-stream", "processingPolicy": "transcribe", "captureId": "capture"}
    assert client.post("/v1/audio-streams/rabilink/start", json=body).status_code == 200
    assert client.post("/v1/audio-streams/rabilink/start", json={**body, "processingPolicy": "agent"}).status_code == 422
    assert client.post("/v1/audio-streams/rabilink/start", json={**body, "processingPolicy": "local_only"}).status_code == 422
    assert client.post("/v1/audio-streams/rabilink/stop", json={"stream_id": "new-stream"}).status_code == 200


def test_vad_switch_cannot_mix_agent_and_transcribe_audio(tmp_path):
    import numpy as np
    from rabispeech.microphone import MicrophoneService
    from rabispeech.contracts import TranscriptionResult
    class Remote:
        selected_client_id = "first"
        selected_client_name = "Phone"
        selected_client_kind = "mobile"
        selected_source_device_id = "phone"
        selected_message_adapter_type = "rabilink"
        selected_route_profile_id = "route"
        selected_session_id = "session"
        selected_processing_policy = "agent"
        selected_capture_id = "capture-a"
        async def start_capture(self, *_): pass
        async def stop_capture(self): pass
    async def scenario():
        remote = Remote()
        persisted, submitted = [], []
        async def transcribe(*_):
            return TranscriptionResult(text="words", language="en", duration=0.1, provider="test", model="test")
        async def submit(_result, _session, _utterance, source):
            submitted.append(source)
            return {"status": "recorded", "deliveries": []}
        service = MicrophoneService(state_path=tmp_path / "mic.json", temp_dir=tmp_path / "temp",
            transcriber=transcribe, submitter=submit, playback_active=lambda: False,
            record_transcription=lambda *args: persisted.append(args[-1]), remote_audio=remote)
        await service.start({"sample_rate": 8000, "pre_roll_ms": 0, "adaptive_threshold": False,
            "record_threshold": 0.1, "transcribe_threshold": 0.1, "silence_ms": 200, "min_utterance_ms": 100})
        service.feed_remote("first", np.full(800, 0.2, dtype=np.float32))
        remote.selected_client_id = "second"
        remote.selected_processing_policy = "transcribe"
        remote.selected_capture_id = "capture-b"
        service.feed_remote("second", np.full(800, 0.2, dtype=np.float32))
        service.feed_remote("second", np.zeros(1600, dtype=np.float32))
        for _ in range(100):
            if len(submitted) == 2: break
            await asyncio.sleep(0.01)
        await service.stop()
        assert [s.processing_policy for s in persisted] == ["agent", "transcribe"]
        assert [s.capture_id for s in submitted] == ["capture-a", "capture-b"]
    asyncio.run(scenario())


def test_legacy_default_is_agent(tmp_path):
    hub = hub_at(tmp_path)
    hub.start_virtual_client(client_id="legacy", name="Phone", kind="mobile", message_adapter_type="rabilink")
    assert hub.selected_processing_policy == "agent"
    assert SpeechInputSource("source", "transport", "channel", "rabilink").processing_policy == "agent"
