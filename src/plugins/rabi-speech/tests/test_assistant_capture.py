from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from rabispeech.assistant_capture import AssistantCaptureWindow
from rabispeech import assistant_wake
from rabispeech.microphone import MicrophoneConfig, MicrophoneService, _sounddevice_stream
from test_microphone import FakeStream


@pytest.mark.parametrize(("last_token_seconds", "expected_offset"), [(0.05, 1440), (0.09, 1599)])
def test_wake_replay_skips_keyword_tail_without_advancing_beyond_capture(monkeypatch, tmp_path: Path, last_token_seconds, expected_offset):
    class Spotter:
        def create_stream(self):
            return object()

        def accept(self, *_args):
            pass

        def detect(self, _stream):
            return SimpleNamespace(alias_index=0, first_token_seconds=0.02, last_token_seconds=last_token_seconds)

    monkeypatch.setattr(assistant_wake, "_model_paths", lambda _: dict.fromkeys(assistant_wake.MODEL_FILES, "fixture"))
    monkeypatch.setattr(assistant_wake, "_encode_aliases", lambda *_: "fixture")
    monkeypatch.setattr(assistant_wake, "SherpaWake", lambda *_: Spotter())
    spotter = assistant_wake.AssistantWakeSpotter(tmp_path, ["夜雨"], 16000, start_sample=24000)
    voiced = np.full(1600, 12000, dtype="<i2")
    hit = spotter.feed(voiced.tobytes(), 0.01)

    assert hit is not None
    assert hit.keyword_start_sample == 24320
    assert hit.observed_through_sample == 25600
    assert hit.replay_from_sample == 24000 + expected_offset


@pytest.mark.parametrize(("starts_quiet", "expected_start", "last_token_seconds"), [
    (True, 2400, 0.55),
    (False, 0, 0.85),
])
def test_wake_retains_quiet_keyword_audio(monkeypatch, tmp_path: Path, starts_quiet, expected_start, last_token_seconds):
    streams = []

    class Spotter:
        def create_stream(self):
            stream = []
            streams.append(stream)
            return stream

        def accept(self, stream, _rate, frame):
            stream.append(frame)

        def detect(self, stream):
            needed = 9 if starts_quiet else 10
            if len(stream) < needed:
                return None
            return SimpleNamespace(alias_index=0, first_token_seconds=0.15, last_token_seconds=last_token_seconds)

    monkeypatch.setattr(assistant_wake, "_model_paths", lambda _: dict.fromkeys(assistant_wake.MODEL_FILES, "fixture"))
    monkeypatch.setattr(assistant_wake, "_encode_aliases", lambda *_: "fixture")
    monkeypatch.setattr(assistant_wake, "SherpaWake", lambda *_: Spotter())
    spotter = assistant_wake.AssistantWakeSpotter(tmp_path, ["小拉比"], 16000)
    soft = np.full(1600, 128, dtype="<i2").tobytes()
    voiced = np.full(1600, 12000, dtype="<i2").tobytes()

    if not starts_quiet:
        assert spotter.feed(voiced, 0.01) is None
    for _ in range(8):
        assert spotter.feed(soft, 0.01) is None
    assert len(streams) == (0 if starts_quiet else 1)
    hit = spotter.feed(voiced, 0.01)

    assert hit is not None
    assert hit.utterance_start_sample == expected_start
    assert hit.replay_from_sample == round(last_token_seconds * 16000) + 640
    assert spotter.feed(voiced, 0.01) is None
    assert len(streams) == 1


def test_wake_trims_only_the_part_of_a_frame_before_the_pre_roll_window(monkeypatch, tmp_path: Path):
    rate = 16_000
    frames = []

    class Spotter:
        def create_stream(self):
            return frames

        def accept(self, stream, _rate, frame):
            stream.append(frame)

        def detect(self, stream):
            audio = np.concatenate(stream)
            if len(audio) == 16_800 and audio[400] == 650 / 32768:
                return SimpleNamespace(alias_index=0, first_token_seconds=400 / rate, last_token_seconds=3600 / rate)
            return None

    monkeypatch.setattr(assistant_wake, "_model_paths", lambda _: dict.fromkeys(assistant_wake.MODEL_FILES, "fixture"))
    monkeypatch.setattr(assistant_wake, "_encode_aliases", lambda *_: "fixture")
    monkeypatch.setattr(assistant_wake, "SherpaWake", lambda *_: Spotter())
    spotter = assistant_wake.AssistantWakeSpotter(tmp_path, ["小拉比"], rate)
    quiet = np.full(rate, 128, dtype="<i2")
    quiet[500] = 700
    quiet[1200] = 650
    for offset in range(0, rate, 1600):
        assert spotter.feed(quiet[offset:offset + 1600].tobytes(), 0.01) is None
    gate_frame = np.full(1600, 12000, dtype="<i2")
    hit = spotter.feed(gate_frame.tobytes(), 0.01)

    assert hit is not None
    assert hit.utterance_start_sample == 1200
    assert hit.replay_from_sample == 5040
    decoded = np.concatenate(frames)
    assert len(decoded) == 16_800
    assert not np.any(decoded == 700 / 32768)


def test_resident_microphone_stream_and_replay_share_exact_sample_positions(tmp_path: Path):
    async def exercise():
        async def unused(*_args):
            raise AssertionError("A quiet capture must not run ASR")

        playing = False
        stream = FakeStream()
        service = MicrophoneService(
            state_path=tmp_path / "mic.json", temp_dir=tmp_path, transcriber=unused,
            submitter=unused, playback_active=lambda: playing, stream_factory=lambda *_args: stream,
        )
        with pytest.raises(ValueError, match="LOCAL_MICROPHONE_REQUIRED"):
            service.assistant_audio(None, None)
        await service.start({"record_threshold": 0.5}, persist=False)
        live = service.assistant_audio(None, None)
        service.feed_for_test(np.array([0.01, 0.02], dtype=np.float32))
        first = await asyncio.wait_for(anext(live.chunks), timeout=2)
        assert live.start_sample == 0 and live.sample_rate == 16000
        assert len(first) == 4 and first != bytes(4)

        replay = service.assistant_audio(live.capture_id, 1)
        assert replay.start_sample == 1
        assert await asyncio.wait_for(anext(replay.chunks), timeout=2) == first[2:]
        with pytest.raises(ValueError, match="CAPTURE_UNAVAILABLE"):
            service.assistant_audio(None, None)

        playing = True
        service.feed_for_test(np.ones(2, dtype=np.float32))
        assert await asyncio.wait_for(anext(live.chunks), timeout=2) == bytes(4)
        assert await asyncio.wait_for(anext(replay.chunks), timeout=2) == bytes(4)

        await replay.chunks.aclose()
        await service.stop(persist=False)
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(anext(live.chunks), timeout=2)
        assert stream.closed
        await service.start({}, persist=False)
        try:
            with pytest.raises(ValueError, match="CURSOR_EXPIRED"):
                service.assistant_audio(live.capture_id, 4)
        finally:
            await service.stop(persist=False)

    asyncio.run(exercise())


@pytest.mark.parametrize("active_channel", [0, 1])
def test_resident_capture_keeps_voice_on_either_hardware_channel(tmp_path: Path, active_channel: int):
    async def exercise():
        async def unused(*_args):
            pytest.fail("This fixture tests the capture stream without requesting ASR")

        callbacks = []

        def stream_factory(_config, callback):
            callbacks.append(callback)
            return FakeStream()

        service = MicrophoneService(
            state_path=tmp_path / "mic.json", temp_dir=tmp_path, transcriber=unused,
            submitter=unused, playback_active=lambda: False, stream_factory=stream_factory,
        )
        await service.start({"record_threshold": 0.5}, persist=False)
        capture = service.assistant_audio(None, None)
        try:
            frames = np.zeros((3, 2), dtype=np.float32)
            frames[:, active_channel] = [0.0625, -0.0625, 0.125]
            callbacks[0](frames, len(frames), None, None)
            audio = await asyncio.wait_for(anext(capture.chunks), timeout=2)
            expected = (frames[:, active_channel] * 32767).astype("<i2")
            np.testing.assert_array_equal(np.frombuffer(audio, dtype="<i2"), expected)

            replay = service.assistant_audio(capture.capture_id, 1)
            try:
                assert await asyncio.wait_for(anext(replay.chunks), timeout=2) == audio[2:]
            finally:
                await replay.chunks.aclose()
        finally:
            await capture.chunks.aclose()
            await service.stop(persist=False)

    asyncio.run(exercise())


@pytest.mark.parametrize(("device_channels", "stereo_supported", "expected_channels"), [
    (1, False, 1), (2, True, 2), (2, False, 1),
])
def test_sounddevice_opens_both_channels_when_supported(monkeypatch, device_channels, stereo_supported, expected_channels):
    class UnsupportedFormat(Exception):
        pass

    def check_input_settings(**options):
        assert options["device"] == 1 and options["samplerate"] == 16000 and options["channels"] == 2
        if not stereo_supported:
            raise UnsupportedFormat("unsupported stereo format")

    sounddevice = SimpleNamespace(
        PortAudioError=UnsupportedFormat,
        query_devices=lambda device, kind: {"max_input_channels": device_channels},
        check_input_settings=check_input_settings,
        InputStream=lambda **options: options,
    )
    monkeypatch.setitem(sys.modules, "sounddevice", sounddevice)
    stream = _sounddevice_stream(MicrophoneConfig(device=1), lambda *_args: None)

    assert stream["device"] == 1 and stream["samplerate"] == 16000 and stream["channels"] == expected_channels


def test_lagging_capture_fails_without_replaying_an_audio_gap():
    async def exercise():
        window = AssistantCaptureWindow(4, history_seconds=1)
        live = window.subscribe(None, None)
        window.append(np.zeros(2, dtype=np.float32))
        assert len(await asyncio.wait_for(anext(live.chunks), timeout=2)) == 4
        for _ in range(4):
            window.append(np.zeros(2, dtype=np.float32))
        with pytest.raises(ValueError, match="CURSOR_EXPIRED"):
            window.subscribe(live.capture_id, 2)
        with pytest.raises(RuntimeError, match="CAPTURE_OVERRUN"):
            await asyncio.wait_for(anext(live.chunks), timeout=2)
        assert window.readers == 0

    asyncio.run(exercise())


def test_wake_capture_transcribes_locally_and_keeps_passive_text_out_of_agent_delivery(tmp_path: Path):
    from rabispeech.contracts import TranscriptionResult

    async def exercise():
        saved = asyncio.Event()

        async def forbidden(*_args):
            pytest.fail("wake-mode audio must not use the normal provider or Agent route")

        async def local(_audio, _config):
            return TranscriptionResult(text="后台文字", language="zh", duration=1, provider="fireredasr2", model="fireredasr2-aed")

        def persist(result, _config, _time, _audio, source):
            assert result.text == "后台文字" and source.processing_policy == "record_only"
            assert source.capture_id == capture.capture_id
            saved.set()

        service = MicrophoneService(
            state_path=tmp_path / "mic.json", temp_dir=tmp_path, transcriber=forbidden, submitter=forbidden,
            assistant_transcriber=local, record_transcription=persist, playback_active=lambda: False,
            stream_factory=lambda *_args: FakeStream(),
        )
        await service.start({"silence_ms": 200}, persist=False)
        capture = service.assistant_audio(None, None)
        try:
            def feed_sentence():
                for _ in range(5):
                    service.feed_for_test(np.full(1600, 0.08, dtype=np.float32))
                for _ in range(3):
                    service.feed_for_test(np.zeros(1600, dtype=np.float32))

            feed_sentence()
            await asyncio.wait_for(saved.wait(), timeout=2)
            assert service.snapshot()["history"][0]["delivery_status"] == "recorded"
            assert service._deliveries.empty()
            assert service.recent_assistant_speech(capture.capture_id, None) == []
            previous = service.snapshot()["history"][0]
            before = previous["started_at"] + previous["duration"] + 1
            assert service.recent_assistant_speech(capture.capture_id, before) == [{"text": "后台文字", "ageMs": 1000}]
            assert service.recent_assistant_speech(capture.capture_id, before - 1) == []
            assert service.recent_assistant_speech("old-capture", before) == []

            saved.clear()
            service.set_assistant_realtime(capture.capture_id, True)
            feed_sentence()
            assert service._phrases.empty()
            assert not saved.is_set()

            service.set_assistant_realtime(capture.capture_id, False)
            feed_sentence()
            await asyncio.wait_for(saved.wait(), timeout=2)
            assert len(service.snapshot()["history"]) == 2
        finally:
            await service.stop(persist=False)

    asyncio.run(exercise())
