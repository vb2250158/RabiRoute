from __future__ import annotations

import asyncio
from pathlib import Path

import numpy as np

from rabispeech.contracts import TranscriptionResult
from rabispeech.microphone import MicrophoneService


class FakeStream:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self.closed = False

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True

    def close(self) -> None:
        self.closed = True


def test_resident_microphone_segments_transcribes_and_submits(tmp_path: Path) -> None:
    async def scenario() -> None:
        stream = FakeStream()
        transcribed = asyncio.Event()
        submitted: list[tuple[str, str, str]] = []

        async def transcribe(path: Path, config) -> TranscriptionResult:
            assert path.read_bytes()[:4] == b"RIFF"
            assert config.asr_model == "fake-asr/local"
            transcribed.set()
            return TranscriptionResult(text="常驻转录成功", language="zh", duration=0.3, provider="fake-asr", model="local")

        async def submit(route_id: str, text: str, session_id: str) -> None:
            submitted.append((route_id, text, session_id))

        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=transcribe,
            submitter=submit,
            playback_active=lambda: False,
            stream_factory=lambda _config, _callback: stream,
        )
        await service.start(
            {
                "sample_rate": 8000,
                "chunk_ms": 100,
                "pre_roll_ms": 0,
                "record_threshold": 0.1,
                "transcribe_threshold": 0.1,
                "adaptive_threshold": False,
                "silence_ms": 200,
                "min_utterance_ms": 100,
                "max_utterance_ms": 3000,
                "asr_model": "fake-asr/local",
                "auto_submit": True,
                "route_id": "voice-route",
                "session_id": "session-one",
            }
        )
        assert stream.started
        service.feed_for_test(np.full(800, 0.2, dtype=np.float32))
        service.feed_for_test(np.zeros(800, dtype=np.float32))
        service.feed_for_test(np.zeros(800, dtype=np.float32))
        await asyncio.wait_for(transcribed.wait(), timeout=2)
        for _ in range(50):
            if service.snapshot()["history"]:
                break
            await asyncio.sleep(0.01)
        snapshot = service.snapshot()
        assert snapshot["running"] is True
        assert snapshot["history"][0]["text"] == "常驻转录成功"
        assert snapshot["history"][0]["submitted"] is True
        assert submitted == [("voice-route", "常驻转录成功", "session-one")]
        assert (tmp_path / "microphone.json").is_file()
        await service.stop()
        assert stream.stopped and stream.closed
        assert service.snapshot()["running"] is False

    asyncio.run(scenario())


def test_resident_microphone_suppresses_capture_during_host_playback(tmp_path: Path) -> None:
    async def scenario() -> None:
        active = True
        calls = 0

        async def transcribe(_path: Path, _config) -> TranscriptionResult:
            nonlocal calls
            calls += 1
            return TranscriptionResult(text="不应出现", language="zh", duration=1, provider="fake", model="fake")

        async def submit(_route_id: str, _text: str, _session_id: str) -> None:
            raise AssertionError("must not submit playback audio")

        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=transcribe,
            submitter=submit,
            playback_active=lambda: active,
            stream_factory=lambda _config, _callback: FakeStream(),
        )
        await service.start({"sample_rate": 8000, "record_threshold": 0.01, "transcribe_threshold": 0.01})
        for _ in range(20):
            service.feed_for_test(np.full(800, 0.5, dtype=np.float32))
        assert service.snapshot()["state"] == "playback_suppressed"
        assert service.snapshot()["pending"] == 0
        active = False
        service.feed_for_test(np.zeros(800, dtype=np.float32))
        assert service.snapshot()["state"] == "listening"
        assert calls == 0
        await service.stop()

    asyncio.run(scenario())


def test_auto_submit_requires_an_explicit_route(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=lambda _path, _config: None,  # type: ignore[arg-type]
            submitter=lambda _route, _text, _session: None,  # type: ignore[arg-type]
            playback_active=lambda: False,
            stream_factory=lambda _config, _callback: FakeStream(),
        )
        try:
            await service.start({"auto_submit": True, "route_id": ""})
        except ValueError as exc:
            assert "route_id" in str(exc)
        else:
            raise AssertionError("missing route_id must fail closed")

    asyncio.run(scenario())
