from __future__ import annotations

import json
import threading
import time
import wave
from pathlib import Path

import numpy as np
import pytest

from rabispeech.playback import PlaybackCoordinator, PlaybackSettingsStore, _apply_volume


def wav(path: Path) -> Path:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * 160)
    return path


def wait_until(predicate, timeout: float = 2.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline and not predicate():
        time.sleep(0.01)
    assert predicate()


def test_playback_is_one_fifo_and_snapshots_host_volume_at_play_start(tmp_path: Path) -> None:
    played: list[tuple[str, int]] = []
    first_started = threading.Event()
    release_first = threading.Event()

    def player(path: Path, volume: int, _cancel: threading.Event) -> None:
        played.append((path.name, volume))
        if len(played) == 1:
            first_started.set()
            assert release_first.wait(2)

    coordinator = PlaybackCoordinator(tmp_path / "queue", player=player, stopper=lambda: None)
    source = wav(tmp_path / "speech.wav")
    coordinator.set_volume(25)
    first = coordinator.enqueue(
        source,
        provider="local-tts",
        model="gpt-sovits",
        voice="Rabi",
        session_id="a",
        route_id="one",
    )
    assert first_started.wait(2)
    coordinator.set_volume(70)
    second = coordinator.enqueue(
        source,
        provider="local-tts",
        model="qwen3-tts",
        voice="Ilias",
        session_id="b",
        route_id="two",
    )
    release_first.set()
    wait_until(lambda: all(job["status"] in {"done", "error"} for job in coordinator.snapshot()["jobs"]))

    snapshot = coordinator.snapshot()
    assert [job["id"] for job in snapshot["jobs"]] == [first["id"], second["id"]]
    assert [job["voice"] for job in snapshot["jobs"]] == ["Rabi", "Ilias"]
    assert [job["route_id"] for job in snapshot["jobs"]] == ["one", "two"]
    assert [job["volume"] for job in snapshot["jobs"]] == [25, 70]
    assert [volume for _name, volume in played] == [25, 70]
    assert snapshot["volume"] == 70
    assert snapshot["current"] is None


def test_playback_volume_is_validated_and_persisted_host_wide(tmp_path: Path) -> None:
    state_path = tmp_path / "playback-settings.json"
    settings = PlaybackSettingsStore(state_path)

    assert settings.volume == 100
    assert json.loads(state_path.read_text(encoding="utf-8")) == {"version": 1, "volume": 100}
    assert settings.set_volume(37) == 37
    assert PlaybackSettingsStore(state_path).volume == 37

    for invalid in (-1, 101, 1.5, True, "50"):
        with pytest.raises(ValueError, match="0 to 100"):
            settings.set_volume(invalid)


def test_invalid_playback_settings_file_recovers_to_default(tmp_path: Path) -> None:
    state_path = tmp_path / "playback-settings.json"
    state_path.write_text('{"volume": 200}', encoding="utf-8")

    settings = PlaybackSettingsStore(state_path)

    assert settings.volume == 100
    assert json.loads(state_path.read_text(encoding="utf-8"))["volume"] == 100


def test_sample_gain_scales_wav_samples_without_changing_shape() -> None:
    audio = np.array([[-1.0, 0.5], [0.25, 1.0]], dtype="float32")

    assert np.array_equal(_apply_volume(audio, 100), audio)
    assert np.allclose(_apply_volume(audio, 50), audio * 0.5)
    assert np.array_equal(_apply_volume(audio, 0), np.zeros_like(audio))


def test_stop_cancels_current_and_pending_jobs_without_rewriting_done(tmp_path: Path) -> None:
    started = threading.Event()
    stopper_called = threading.Event()
    played: list[str] = []

    def player(path: Path, _volume: int, cancel: threading.Event) -> None:
        played.append(path.name)
        started.set()
        assert cancel.wait(2)

    coordinator = PlaybackCoordinator(
        tmp_path / "queue",
        player=player,
        stopper=stopper_called.set,
    )
    source = wav(tmp_path / "speech.wav")
    first = coordinator.enqueue(source, provider="local-tts", model="one", voice="Rabi")
    assert started.wait(2)
    second = coordinator.enqueue(source, provider="local-tts", model="two", voice="Rabi")

    coordinator.stop(clear_pending=True)
    wait_until(lambda: coordinator.snapshot()["current"] is None)

    jobs = {job["id"]: job for job in coordinator.snapshot()["jobs"]}
    assert stopper_called.is_set()
    assert jobs[first["id"]]["status"] == "cancelled"
    assert jobs[second["id"]]["status"] == "cancelled"
    assert len(played) == 1
