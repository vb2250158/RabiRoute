from __future__ import annotations

import asyncio
from pathlib import Path

import numpy as np

from rabispeech.contracts import TranscriptionResult
from rabispeech.microphone import MicrophoneConfig, MicrophoneService


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
        submitted: list[tuple[str, str, object, object]] = []
        lifecycle: list[str] = []

        async def transcribe(path: Path, config) -> TranscriptionResult:
            assert path.read_bytes()[:4] == b"RIFF"
            assert config.asr_model == "fake-asr/local"
            transcribed.set()
            return TranscriptionResult(text="常驻转录成功", language="zh", duration=0.3, provider="fake-asr", model="local")

        async def submit(result: TranscriptionResult, session_id: str, utterance, input_source) -> dict[str, object]:
            assert lifecycle == ["persisted"]
            lifecycle.append("submitted")
            submitted.append((result.text, session_id, utterance, input_source))
            return {
                "status": "delivered",
                "message_id": "speech-one",
                "deliveries": [{"routeId": "voice-route", "messageId": "route-one", "status": "delivered"}],
            }

        def persist(_result, _config, _started_at, _audio_path, _input_source) -> None:
            lifecycle.append("persisted")

        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=transcribe,
            submitter=submit,
            playback_active=lambda: False,
            record_transcription=persist,
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
        assert snapshot["history"][0]["rms"] > 0
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
        assert len(submitted) == 1
        assert lifecycle == ["persisted", "submitted"]
        assert submitted[0][:2] == ("常驻转录成功", "session-one")
        assert submitted[0][2].started_at > 0
        assert submitted[0][2].completed_at >= submitted[0][2].started_at
        assert submitted[0][2].duration > 0
        assert submitted[0][2].peak > 0
        assert submitted[0][2].rms > 0
        assert submitted[0][3].message_adapter_type == "speech"
        assert submitted[0][3].channel_type == "speech.pc_microphone"
        assert snapshot["config"]["route_id"] is None
        assert (tmp_path / "microphone.json").is_file()
        await service.stop()
        assert stream.stopped and stream.closed
        stopped = service.snapshot()
        assert stopped["running"] is False
        assert stopped["events"][0]["kind"] == "microphone_stopped"

    asyncio.run(scenario())


def test_remote_mobile_audio_uses_rabilink_message_endpoint_metadata(tmp_path: Path) -> None:
    class RemoteMobile:
        selected_client_id = "phone-one"
        selected_client_name = "Phone One"
        selected_client_kind = "mobile"
        selected_source_device_id = "phone-stable"
        selected_message_adapter_type = "rabilink"
        selected_route_profile_id = "mobile-main"
        selected_session_id = "phone-one"

        async def start_capture(self, _sample_rate: int, _chunk_ms: int) -> None:
            return None

        async def stop_capture(self) -> None:
            return None

    async def scenario() -> None:
        sources = []

        async def transcribe(_path: Path, _config) -> TranscriptionResult:
            return TranscriptionResult(text="手机语音", language="zh", duration=0.3, provider="fake-asr", model="local")

        async def submit(_result: TranscriptionResult, _session_id: str, _recorded_at: float, input_source) -> dict[str, object]:
            sources.append(input_source)
            return {"status": "recorded", "reason": "no_enabled_rabilink_routes", "deliveries": []}

        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=transcribe,
            submitter=submit,
            playback_active=lambda: False,
            remote_audio=RemoteMobile(),
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
        })
        service.feed_remote("phone-one", np.full(800, 0.2, dtype=np.float32))
        service.feed_remote("phone-one", np.zeros(800, dtype=np.float32))
        service.feed_remote("phone-one", np.zeros(800, dtype=np.float32))
        for _ in range(100):
            if sources:
                break
            await asyncio.sleep(0.01)
        await service.stop()
        assert len(sources) == 1
        assert sources[0].message_adapter_type == "rabilink"
        assert sources[0].channel_type == "rabilink.mobile_audio"
        assert sources[0].device_id == "phone-stable"
        assert sources[0].stream_id == "phone-one"
        assert sources[0].device_kind == "mobile"
        assert sources[0].audio_format == "pcm_s16le"
        assert sources[0].channels == 1
        assert sources[0].route_profile_id == "mobile-main"
        assert sources[0].session_id == "phone-one"

    asyncio.run(scenario())


def test_route_receipts_distinguish_recorded_and_failed(tmp_path: Path) -> None:
    async def run_case(name: str, *, fail: bool) -> dict[str, object]:
        async def transcribe(_path: Path, _config) -> TranscriptionResult:
            return TranscriptionResult(text="会议继续", language="zh", duration=0.3, provider="fake-asr", model="local")

        async def submit(_result: TranscriptionResult, _session_id: str, _recorded_at: float, _input_source) -> dict[str, object]:
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

        async def submit(_result: TranscriptionResult, _session_id: str, _recorded_at: float, _input_source) -> dict[str, object]:
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

        def persist(
            _result: TranscriptionResult,
            _config,
            _started_at: float,
            _audio_path: Path,
            _input_source,
        ) -> None:
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
        persistence_event = next(item for item in snapshot["events"] if item["kind"] == "record_persistence_failed")
        assert persistence_event["stage"] == "storage"
        assert "disk full" in persistence_event["details"]["error"]
        assert all(item["kind"] != "transcription_failed" for item in snapshot["events"])
        await service.stop()

    asyncio.run(scenario())


def test_empty_transcription_returns_to_listening_without_route_submission(tmp_path: Path) -> None:
    async def scenario() -> None:
        async def transcribe(_path: Path, _config) -> TranscriptionResult:
            return TranscriptionResult(text="", language="zh", duration=0.3, provider="fake-asr", model="local")

        async def submit(_result: TranscriptionResult, _session_id: str, _recorded_at: float, _input_source) -> dict[str, object]:
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

        async def submit(_result: TranscriptionResult, _session_id: str, _recorded_at: float, _input_source) -> None:
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


def test_echo_protected_barge_in_stops_playback_then_keeps_full_asr_path(tmp_path: Path) -> None:
    async def scenario() -> None:
        playback_active = True
        stop_calls = 0
        transcribed = asyncio.Event()
        submitted: list[str] = []

        def stop_playback() -> None:
            nonlocal playback_active, stop_calls
            stop_calls += 1
            playback_active = False

        async def transcribe(_path: Path, _config) -> TranscriptionResult:
            transcribed.set()
            return TranscriptionResult(text="打断后继续", language="zh", duration=0.3, provider="fake", model="fake")

        async def submit(result: TranscriptionResult, _session_id: str, _utterance, _input_source) -> dict[str, object]:
            submitted.append(result.text)
            return {"status": "delivered", "message_id": "speech-barge-in", "deliveries": []}

        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=transcribe,
            submitter=submit,
            playback_active=lambda: playback_active,
            stop_playback=stop_playback,
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
                "min_utterance_ms": 100,
                "max_utterance_ms": 3000,
                "barge_in_mode": "echo_protected",
                "barge_in_confirm_ms": 200,
            }
        )

        service.feed_for_test(np.full(800, 0.2, dtype=np.float32))
        assert stop_calls == 0
        service.feed_for_test(np.full(800, 0.2, dtype=np.float32))
        assert stop_calls == 1
        assert service.snapshot()["state"] == "recording"
        assert service.snapshot()["utterance_active"] is True
        assert service.snapshot()["events"][0]["kind"] == "barge_in_triggered"

        service.feed_for_test(np.zeros(800, dtype=np.float32))
        service.feed_for_test(np.zeros(800, dtype=np.float32))
        await asyncio.wait_for(transcribed.wait(), timeout=2)
        for _ in range(50):
            if submitted:
                break
            await asyncio.sleep(0.01)

        snapshot = service.snapshot()
        assert submitted == ["打断后继续"]
        assert snapshot["stats"]["captured"] == 1
        assert snapshot["stats"]["recognized"] == 1
        await service.stop()

    asyncio.run(scenario())


def test_barge_in_confirmation_counts_only_voice_during_playback(tmp_path: Path) -> None:
    async def scenario() -> None:
        playback_active = False
        stop_calls = 0

        def stop_playback() -> None:
            nonlocal playback_active, stop_calls
            stop_calls += 1
            playback_active = False

        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=lambda _path, _config: None,  # type: ignore[arg-type]
            submitter=lambda _result, _session, _utterance, _source: None,  # type: ignore[arg-type]
            playback_active=lambda: playback_active,
            stop_playback=stop_playback,
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
                "barge_in_mode": "echo_protected",
                "barge_in_confirm_ms": 200,
            }
        )

        service.feed_for_test(np.full(800, 0.2, dtype=np.float32))
        service.feed_for_test(np.full(800, 0.2, dtype=np.float32))
        playback_active = True
        service.feed_for_test(np.full(800, 0.2, dtype=np.float32))
        assert stop_calls == 0
        service.feed_for_test(np.full(800, 0.2, dtype=np.float32))
        assert stop_calls == 1
        await service.stop()

    asyncio.run(scenario())


def test_barge_in_remains_fail_closed_without_echo_protection(tmp_path: Path) -> None:
    assert MicrophoneConfig.from_mapping(
        {"barge_in_mode": "unsupported"},
        MicrophoneConfig(barge_in_mode="echo_protected"),
    ).barge_in_mode == "off"

    async def scenario() -> None:
        stop_calls = 0

        def stop_playback() -> None:
            nonlocal stop_calls
            stop_calls += 1

        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=lambda _path, _config: None,  # type: ignore[arg-type]
            submitter=lambda _result, _session, _utterance, _source: None,  # type: ignore[arg-type]
            playback_active=lambda: True,
            stop_playback=stop_playback,
            stream_factory=lambda _config, _callback: FakeStream(),
        )
        await service.start(
            {
                "sample_rate": 8000,
                "record_threshold": 0.01,
                "transcribe_threshold": 0.01,
                "barge_in_mode": "unsupported",
            }
        )
        service.feed_for_test(np.full(800, 0.5, dtype=np.float32))

        snapshot = service.snapshot()
        assert snapshot["config"]["barge_in_mode"] == "off"
        assert snapshot["state"] == "playback_suppressed"
        assert stop_calls == 0
        await service.stop()

    asyncio.run(scenario())


def test_barge_in_stop_failure_restores_playback_suppression(tmp_path: Path) -> None:
    async def scenario() -> None:
        def stop_playback() -> None:
            raise RuntimeError("fake stop failure")

        service = MicrophoneService(
            state_path=tmp_path / "microphone.json",
            temp_dir=tmp_path / "temp",
            transcriber=lambda _path, _config: None,  # type: ignore[arg-type]
            submitter=lambda _result, _session, _utterance, _source: None,  # type: ignore[arg-type]
            playback_active=lambda: True,
            stop_playback=stop_playback,
            stream_factory=lambda _config, _callback: FakeStream(),
        )
        await service.start(
            {
                "sample_rate": 8000,
                "pre_roll_ms": 0,
                "record_threshold": 0.1,
                "transcribe_threshold": 0.1,
                "adaptive_threshold": False,
                "barge_in_mode": "echo_protected",
                "barge_in_confirm_ms": 100,
            }
        )
        service.feed_for_test(np.full(800, 0.2, dtype=np.float32))

        snapshot = service.snapshot()
        assert snapshot["state"] == "playback_suppressed"
        assert snapshot["utterance_active"] is False
        assert snapshot["pending"] == 0
        assert snapshot["events"][0]["kind"] == "barge_in_failed"
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
            submitter=lambda _result, _session, _recorded_at: None,  # type: ignore[arg-type]
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
            submitter=lambda _result, _session, _recorded_at: None,  # type: ignore[arg-type]
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


def test_asr_streaming_switch_stops_capture_and_persists_preference(tmp_path: Path) -> None:
    async def scenario() -> None:
        streams: list[FakeStream] = []

        def stream_factory(_config, _callback) -> FakeStream:
            stream = FakeStream()
            streams.append(stream)
            return stream

        state_path = tmp_path / "microphone.json"
        service = MicrophoneService(
            state_path=state_path,
            temp_dir=tmp_path / "temp",
            transcriber=lambda _path, _config: None,  # type: ignore[arg-type]
            submitter=lambda _result, _session, _utterance, _source: None,  # type: ignore[arg-type]
            playback_active=lambda: False,
            stream_factory=stream_factory,
        )

        started = await service.start({"streaming_enabled": True})
        assert started["running"] is True
        assert started["config"]["streaming_enabled"] is True

        disabled = await service.update_settings({"streaming_enabled": False})
        assert disabled["running"] is False
        assert disabled["config"]["enabled"] is False
        assert disabled["config"]["streaming_enabled"] is False
        assert streams[0].stopped and streams[0].closed

        enabled = await service.update_settings({"streaming_enabled": True})
        assert enabled["running"] is False
        assert enabled["config"]["streaming_enabled"] is True

        restored = MicrophoneService(
            state_path=state_path,
            temp_dir=tmp_path / "restored-temp",
            transcriber=lambda _path, _config: None,  # type: ignore[arg-type]
            submitter=lambda _result, _session, _utterance, _source: None,  # type: ignore[arg-type]
            playback_active=lambda: False,
            stream_factory=stream_factory,
        )
        assert restored.config.enabled is False
        assert restored.config.streaming_enabled is True

    asyncio.run(scenario())
