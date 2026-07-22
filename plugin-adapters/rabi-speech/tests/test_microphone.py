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
        submitted: list[tuple[str, str]] = []

        async def transcribe(path: Path, config) -> TranscriptionResult:
            assert path.read_bytes()[:4] == b"RIFF"
            assert config.asr_model == "fake-asr/local"
            transcribed.set()
            return TranscriptionResult(text="常驻转录成功", language="zh", duration=0.3, provider="fake-asr", model="local")

        async def submit(text: str, session_id: str) -> dict[str, object]:
            submitted.append((text, session_id))
            return {
                "status": "delivered",
                "message_id": "speech-one",
                "deliveries": [{"routeId": "voice-route", "messageId": "route-one", "status": "delivered"}],
            }

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
        assert len(snapshot["level_history"]) == 3
        assert snapshot["level_history"][0] > 0
        assert snapshot["level_history"][-1] < snapshot["level_history"][0]
        assert snapshot["history"][0]["text"] == "常驻转录成功"
        assert snapshot["history"][0]["submitted"] is True
        assert snapshot["history"][0]["delivery_status"] == "delivered"
        assert snapshot["history"][0]["message_id"] == "speech-one"
        assert snapshot["stats"] == {
            "captured": 1,
            "recognized": 1,
            "empty": 0,
            "delivered": 1,
            "recorded": 0,
            "delivery_failed": 0,
            "submitted": 1,
            "submit_failed": 0,
            "dropped": 0,
        }
        event_kinds = [item["kind"] for item in reversed(snapshot["events"])]
        assert event_kinds == [
            "microphone_started",
            "utterance_started",
            "segment_queued",
            "transcription_started",
            "transcription_succeeded",
            "route_submission_started",
            "route_delivery_succeeded",
        ]
        assert all("text" not in item.get("details", {}) for item in snapshot["events"])
        assert submitted == [("常驻转录成功", "session-one")]
        assert snapshot["config"]["route_id"] is None
        assert (tmp_path / "microphone.json").is_file()
        await service.stop()
        assert stream.stopped and stream.closed
        stopped = service.snapshot()
        assert stopped["running"] is False
        assert stopped["events"][0]["kind"] == "microphone_stopped"

    asyncio.run(scenario())


def test_route_receipts_distinguish_recorded_and_failed(tmp_path: Path) -> None:
    async def run_case(name: str, *, fail: bool) -> dict[str, object]:
        async def transcribe(_path: Path, _config) -> TranscriptionResult:
            return TranscriptionResult(text="会议继续", language="zh", duration=0.3, provider="fake-asr", model="local")

        async def submit(_text: str, _session_id: str) -> dict[str, object]:
            if fail:
                raise RuntimeError("Desktop unavailable")
            return {
                "status": "recorded",
                "message_id": f"speech-{name}",
                "reason": "broadcast_complete",
                "deliveries": [{
                    "routeId": "voice-route",
                    "messageId": f"speech-{name}-route",
                    "status": "recorded",
                    "reason": "keyword_not_matched",
                }],
            }

        service = MicrophoneService(
            state_path=tmp_path / name / "microphone.json",
            temp_dir=tmp_path / name / "temp",
            transcriber=transcribe,
            submitter=submit,
            playback_active=lambda: False,
            stream_factory=lambda _config, _callback: FakeStream(),
        )
        await service.start({
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
            "session_id": "meeting-one",
        })
        service.feed_for_test(np.full(800, 0.2, dtype=np.float32))
        service.feed_for_test(np.zeros(800, dtype=np.float32))
        service.feed_for_test(np.zeros(800, dtype=np.float32))
        for _ in range(100):
            snapshot = service.snapshot()
            if snapshot["history"]:
                await service.stop()
                return snapshot
            await asyncio.sleep(0.01)
        raise AssertionError("microphone history was not produced")

    async def scenario() -> None:
        recorded = await run_case("recorded", fail=False)
        assert recorded["history"][0]["delivery_status"] == "recorded"
        assert recorded["history"][0]["delivery_reason"] == "broadcast_complete"
        assert recorded["stats"]["recorded"] == 1
        assert recorded["stats"]["delivered"] == 0
        assert recorded["events"][0]["kind"] == "route_recorded_only"

        failed = await run_case("failed", fail=True)
        assert failed["history"][0]["delivery_status"] == "failed"
        assert "Desktop unavailable" in failed["history"][0]["submit_error"]
        assert failed["stats"]["delivery_failed"] == 1
        assert failed["stats"]["submit_failed"] == 1
        assert failed["events"][0]["kind"] == "route_submission_failed"

    asyncio.run(scenario())


def test_record_persistence_failure_preserves_terminal_route_receipt(tmp_path: Path) -> None:
    async def scenario() -> None:
        async def transcribe(_path: Path, _config) -> TranscriptionResult:
            return TranscriptionResult(text="会议继续", language="zh", duration=0.3, provider="fake-asr", model="local")

        async def submit(_text: str, _session_id: str) -> dict[str, object]:
            return {
                "status": "recorded",
                "message_id": "speech-recorded",
                "reason": "broadcast_complete",
                "deliveries": [{
                    "routeId": "voice-route",
                    "messageId": "speech-recorded-route",
                    "status": "recorded",
                    "reason": "keyword_not_matched",
                }],
            }

        def persist(_result: TranscriptionResult, _config, _started_at: float) -> None:
            raise OSError("disk full")

        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=transcribe,
            submitter=submit,
            playback_active=lambda: False,
            record_transcription=persist,
            stream_factory=lambda _config, _callback: FakeStream(),
        )
        await service.start({
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
            "session_id": "meeting-one",
        })
        service.feed_for_test(np.full(800, 0.2, dtype=np.float32))
        service.feed_for_test(np.zeros(800, dtype=np.float32))
        service.feed_for_test(np.zeros(800, dtype=np.float32))
        for _ in range(100):
            snapshot = service.snapshot()
            if snapshot["history"]:
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("microphone history was not produced")

        assert snapshot["state"] == "listening"
        assert snapshot["history"][0]["delivery_status"] == "recorded"
        assert snapshot["history"][0]["delivery_reason"] == "broadcast_complete"
        assert snapshot["history"][0]["deliveries"][0]["reason"] == "keyword_not_matched"
        assert snapshot["stats"]["recorded"] == 1
        assert snapshot["stats"]["delivery_failed"] == 0
        assert snapshot["events"][0]["kind"] == "record_persistence_failed"
        assert snapshot["events"][0]["stage"] == "storage"
        assert "disk full" in snapshot["events"][0]["details"]["error"]
        assert all(item["kind"] != "transcription_failed" for item in snapshot["events"])
        await service.stop()

    asyncio.run(scenario())


def test_empty_transcription_returns_to_listening_without_route_submission(tmp_path: Path) -> None:
    async def scenario() -> None:
        async def transcribe(_path: Path, _config) -> TranscriptionResult:
            return TranscriptionResult(text="", language="zh", duration=0.3, provider="fake-asr", model="local")

        async def submit(_text: str, _session_id: str) -> dict[str, object]:
            raise AssertionError("empty transcription must not be submitted")

        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=transcribe,
            submitter=submit,
            playback_active=lambda: False,
            stream_factory=lambda _config, _callback: FakeStream(),
        )
        await service.start({
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
            "session_id": "meeting-one",
        })
        service.feed_for_test(np.full(800, 0.2, dtype=np.float32))
        service.feed_for_test(np.zeros(800, dtype=np.float32))
        service.feed_for_test(np.zeros(800, dtype=np.float32))
        for _ in range(100):
            snapshot = service.snapshot()
            if snapshot["stats"]["empty"] == 1:
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("empty transcription was not observed")

        assert snapshot["state"] == "listening"
        assert snapshot["error"] == ""
        assert snapshot["history"] == []
        assert snapshot["stats"]["recognized"] == 0
        assert snapshot["stats"]["empty"] == 1
        assert snapshot["stats"]["submitted"] == 0
        assert snapshot["events"][0]["kind"] == "transcription_empty"
        await service.stop()

    asyncio.run(scenario())


def test_resident_microphone_suppresses_capture_during_host_playback(tmp_path: Path) -> None:
    async def scenario() -> None:
        active = True
        calls = 0

        async def transcribe(_path: Path, _config) -> TranscriptionResult:
            nonlocal calls
            calls += 1
            return TranscriptionResult(text="不应出现", language="zh", duration=1, provider="fake", model="fake")

        async def submit(_text: str, _session_id: str) -> None:
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


def test_short_false_trigger_returns_to_listening_after_silence(tmp_path: Path) -> None:
    async def scenario() -> None:
        calls = 0

        async def transcribe(_path: Path, _config) -> TranscriptionResult:
            nonlocal calls
            calls += 1
            return TranscriptionResult(text="不应识别", language="zh", duration=0.1, provider="fake", model="fake")

        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=transcribe,
            submitter=lambda _text, _session: None,  # type: ignore[arg-type]
            playback_active=lambda: False,
            stream_factory=lambda _config, _callback: FakeStream(),
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
                "min_utterance_ms": 1000,
                "max_utterance_ms": 60000,
            }
        )
        service.feed_for_test(np.full(800, 0.2, dtype=np.float32))
        service.feed_for_test(np.zeros(800, dtype=np.float32))
        service.feed_for_test(np.zeros(800, dtype=np.float32))

        snapshot = service.snapshot()
        assert snapshot["state"] == "listening"
        assert snapshot["utterance_active"] is False
        assert snapshot["pending"] == 0
        assert snapshot["events"][0]["kind"] == "segment_discarded"
        assert calls == 0
        await service.stop()

    asyncio.run(scenario())


def test_legacy_single_route_config_migrates_to_broadcast_mode(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=lambda _path, _config: None,  # type: ignore[arg-type]
            submitter=lambda _text, _session: None,  # type: ignore[arg-type]
            playback_active=lambda: False,
            stream_factory=lambda _config, _callback: FakeStream(),
        )
        snapshot = await service.start({
            "auto_submit": False,
            "route_id": "legacy-route",
            "session_id": "speech-legacy-route",
        })
        assert snapshot["config"]["auto_submit"] is True
        assert snapshot["config"]["route_id"] is None
        assert snapshot["config"]["session_id"] == "rabispeech-microphone"
        await service.stop()

    asyncio.run(scenario())
