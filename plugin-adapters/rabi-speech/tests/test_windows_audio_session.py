from __future__ import annotations

import threading
import time

from rabispeech.windows_audio_session import (
    WindowsAudioSessionIdentity,
    WindowsAudioSessionKeepalive,
    persistent_windows_audio_session_active,
)


class FakeSimpleAudioVolume:
    def __init__(self, volume: float = 0.01) -> None:
        self.volume = volume
        self.calls: list[tuple[float, object]] = []

    def SetMasterVolume(self, volume: float, event_context: object) -> None:
        self.volume = volume
        self.calls.append((volume, event_context))


class FakeSession:
    def __init__(self, process_id: int, *, with_volume: bool = False) -> None:
        self.ProcessId = process_id
        self.DisplayName = "Python"
        self.IconPath = "python.exe"
        if with_volume:
            self.SimpleAudioVolume = FakeSimpleAudioVolume()


def test_windows_audio_session_identity_labels_only_current_process(tmp_path) -> None:
    icon = tmp_path / "rabispeech.ico"
    icon.write_bytes(b"icon")
    current = FakeSession(42)
    second_current = FakeSession(42)
    other = FakeSession(43)
    initialized = threading.Event()
    uninitialized = threading.Event()

    identity = WindowsAudioSessionIdentity(
        icon_path=icon,
        process_id=42,
        poll_interval_seconds=0.005,
        enabled=True,
        backend_loader=lambda: (
            initialized.set,
            uninitialized.set,
            lambda: [current, second_current, other],
        ),
    )

    with identity.monitor():
        assert identity.wait_until_applied(1)
        assert initialized.is_set()
        assert identity.applied_sessions == 2
        assert current.DisplayName == "RabiSpeech"
        assert second_current.DisplayName == "RabiSpeech"
        assert current.IconPath == str(icon.resolve())
        assert second_current.IconPath == str(icon.resolve())
        assert other.DisplayName == "Python"
        assert other.IconPath == "python.exe"

    assert uninitialized.wait(1)
    assert identity.last_error is None


def test_windows_audio_session_identity_resets_hidden_session_attenuation_once(tmp_path) -> None:
    session = FakeSession(42, with_volume=True)
    identity = WindowsAudioSessionIdentity(
        icon_path=tmp_path / "missing.ico",
        process_id=42,
        poll_interval_seconds=0.005,
        normalize_volume=True,
        enabled=True,
        backend_loader=lambda: (lambda: None, lambda: None, lambda: [session]),
    )

    with identity.monitor():
        assert identity.wait_until_applied(1)

    volume = session.SimpleAudioVolume
    assert volume.volume == 1.0
    assert volume.calls == [(1.0, None)]
    assert identity.last_error is None


def test_windows_audio_session_keepalive_stays_active_without_rewriting_user_volume(tmp_path) -> None:
    stream_started = threading.Event()
    session = FakeSession(42, with_volume=True)

    class FakeStream:
        stopped = False
        closed = False

        def start(self) -> None:
            stream_started.set()

        def stop(self) -> None:
            self.stopped = True

        def close(self) -> None:
            self.closed = True

    stream = FakeStream()
    keepalive = WindowsAudioSessionKeepalive(
        enabled=True,
        stream_factory=lambda _callback: stream,
        identity_factory=lambda: WindowsAudioSessionIdentity(
            icon_path=tmp_path / "missing.ico",
            process_id=42,
            poll_interval_seconds=0.005,
            normalize_volume=True,
            enabled=True,
            backend_loader=lambda: (
                lambda: None,
                lambda: None,
                lambda: [session] if stream_started.is_set() else [],
            ),
        ),
    )

    assert keepalive.start(1) is True
    assert keepalive.active is True
    assert persistent_windows_audio_session_active() is True
    assert session.SimpleAudioVolume.calls == [(1.0, None)]

    session.SimpleAudioVolume.volume = 0.42
    time.sleep(0.03)
    assert session.SimpleAudioVolume.volume == 0.42
    assert session.SimpleAudioVolume.calls == [(1.0, None)]

    keepalive.stop()
    assert keepalive.active is False
    assert persistent_windows_audio_session_active() is False
    assert stream.stopped is True
    assert stream.closed is True
    assert keepalive.last_error is None


def test_windows_audio_session_identity_failure_never_escapes_playback() -> None:
    played = False

    def unavailable():
        raise RuntimeError("Core Audio unavailable")

    identity = WindowsAudioSessionIdentity(enabled=True, backend_loader=unavailable)

    with identity.monitor():
        played = True

    deadline = time.time() + 1
    while identity.last_error is None and time.time() < deadline:
        time.sleep(0.005)
    assert played is True
    assert identity.applied is False
    assert identity.last_error == "RuntimeError: Core Audio unavailable"


def test_windows_audio_session_identity_is_a_noop_off_windows() -> None:
    backend_loaded = False

    def backend():
        nonlocal backend_loaded
        backend_loaded = True
        raise AssertionError("backend must not load")

    identity = WindowsAudioSessionIdentity(enabled=False, backend_loader=backend)

    with identity.monitor():
        assert identity.applied is False

    assert backend_loaded is False
    assert identity.last_error is None


def test_missing_icon_still_applies_the_display_name(tmp_path) -> None:
    session = FakeSession(7)
    identity = WindowsAudioSessionIdentity(
        icon_path=tmp_path / "missing.ico",
        process_id=7,
        poll_interval_seconds=0.005,
        enabled=True,
        backend_loader=lambda: (lambda: None, lambda: None, lambda: [session]),
    )

    with identity.monitor():
        assert identity.wait_until_applied(1)
        assert session.DisplayName == "RabiSpeech"
        assert session.IconPath == "python.exe"

    assert identity.last_error is None
