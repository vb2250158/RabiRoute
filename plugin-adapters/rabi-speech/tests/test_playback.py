from __future__ import annotations

import time
import wave
from pathlib import Path

from rabispeech.playback import PlaybackCoordinator


def wav(path: Path) -> Path:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * 160)
    return path


def test_playback_is_one_fifo_with_immutable_voice_snapshots(tmp_path: Path) -> None:
    played: list[str] = []

    def player(path: Path) -> None:
        played.append(path.name)

    coordinator = PlaybackCoordinator(tmp_path / "queue", player=player)
    source = wav(tmp_path / "speech.wav")
    first = coordinator.enqueue(source, provider="local-tts", model="gpt-sovits", voice="Rabi", session_id="a", route_id="one")
    second = coordinator.enqueue(source, provider="local-tts", model="qwen3-tts", voice="Ilias", session_id="b", route_id="two")
    deadline = time.time() + 2
    while time.time() < deadline and any(job["status"] not in {"done", "error"} for job in coordinator.snapshot()["jobs"]):
        time.sleep(0.01)

    snapshot = coordinator.snapshot()
    assert [job["id"] for job in snapshot["jobs"]] == [first["id"], second["id"]]
    assert [job["voice"] for job in snapshot["jobs"]] == ["Rabi", "Ilias"]
    assert [job["route_id"] for job in snapshot["jobs"]] == ["one", "two"]
    assert len(played) == 2
    assert snapshot["current"] is None
