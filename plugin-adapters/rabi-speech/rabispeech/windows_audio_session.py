from __future__ import annotations

import logging
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, Sequence


_DEFAULT_DISPLAY_NAME = "RabiSpeech"
_DEFAULT_POLL_INTERVAL_SECONDS = 0.05
_DEFAULT_JOIN_TIMEOUT_SECONDS = 0.5

CoreAudioBackend = tuple[
    Callable[[], None],
    Callable[[], None],
    Callable[[], Sequence[Any]],
]
CoreAudioBackendLoader = Callable[[], CoreAudioBackend]
SilentStreamFactory = Callable[[Callable[..., None]], Any]


_persistent_session_active = threading.Event()


def default_audio_session_icon() -> Path:
    """Return the repository icon used for the host RabiSpeech render session."""

    return Path(__file__).resolve().parents[3] / "assets" / "rabiroute-icon.ico"


def _load_core_audio_backend() -> CoreAudioBackend:
    from comtypes import CoInitialize, CoUninitialize
    from pycaw.pycaw import AudioUtilities

    return CoInitialize, CoUninitialize, AudioUtilities.GetAllSessions


class WindowsAudioSessionIdentity:
    """Apply best-effort Core Audio metadata to this process's render session.

    Legacy playback APIs create the session only after playback starts. ``monitor``
    therefore labels it from a small COM-initialized helper thread while the
    caller keeps its existing synchronous playback semantics.
    """

    def __init__(
        self,
        display_name: str = _DEFAULT_DISPLAY_NAME,
        icon_path: str | Path | None = None,
        *,
        process_id: int | None = None,
        poll_interval_seconds: float = _DEFAULT_POLL_INTERVAL_SECONDS,
        join_timeout_seconds: float = _DEFAULT_JOIN_TIMEOUT_SECONDS,
        normalize_volume: bool = False,
        enabled: bool | None = None,
        backend_loader: CoreAudioBackendLoader | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self.display_name = str(display_name or _DEFAULT_DISPLAY_NAME).strip() or _DEFAULT_DISPLAY_NAME
        self.icon_path = Path(icon_path or default_audio_session_icon()).expanduser().resolve()
        self.process_id = int(process_id if process_id is not None else os.getpid())
        self.poll_interval_seconds = max(0.005, float(poll_interval_seconds))
        self.join_timeout_seconds = max(0.05, float(join_timeout_seconds))
        self.normalize_volume = bool(normalize_volume)
        self.enabled = os.name == "nt" if enabled is None else bool(enabled)
        self._backend_loader = backend_loader or _load_core_audio_backend
        self._logger = logger or logging.getLogger("rabispeech.windows_audio_session")
        self._state_lock = threading.Lock()
        self._applied = threading.Event()
        self._applied_sessions = 0
        self._last_error: str | None = None

    @property
    def applied(self) -> bool:
        return self._applied.is_set()

    @property
    def applied_sessions(self) -> int:
        with self._state_lock:
            return self._applied_sessions

    @property
    def last_error(self) -> str | None:
        with self._state_lock:
            return self._last_error

    def wait_until_applied(self, timeout: float | None = None) -> bool:
        return self._applied.wait(timeout)

    @contextmanager
    def monitor(self) -> Iterator["WindowsAudioSessionIdentity"]:
        """Label sessions created inside the context without affecting playback."""

        self._reset_result()
        if not self.enabled:
            yield self
            return

        stop = threading.Event()
        worker = threading.Thread(
            target=self._run,
            args=(stop,),
            name="rabispeech-audio-session-identity",
            daemon=True,
        )
        started = False
        try:
            try:
                worker.start()
                started = True
            except Exception as exc:
                self._record_error(exc)
            yield self
        finally:
            stop.set()
            if started:
                worker.join(timeout=self.join_timeout_seconds)

    def _run(self, stop: threading.Event) -> None:
        co_initialized = False
        held_sessions: list[Any] = []
        try:
            co_initialize, co_uninitialize, sessions = self._backend_loader()
            co_initialize()
            co_initialized = True
            while not stop.is_set():
                applied: list[Any] = []
                try:
                    candidates = tuple(sessions())
                except Exception as exc:
                    self._record_error(exc)
                    stop.wait(self.poll_interval_seconds)
                    continue
                for session in candidates:
                    try:
                        if int(session.ProcessId) != self.process_id:
                            continue
                        session.DisplayName = self.display_name
                        simple_volume = getattr(session, "SimpleAudioVolume", None)
                        if self.normalize_volume and simple_volume is not None:
                            # Windows persists a per-executable session multiplier. A stale
                            # 1% value would silently attenuate RabiSpeech's own host-volume
                            # setting. Reset it once when the render session is created; this
                            # monitor stops after applying, so the user can still move the
                            # Windows mixer slider during active playback.
                            simple_volume.SetMasterVolume(1.0, None)
                        try:
                            if self.icon_path.is_file():
                                session.IconPath = str(self.icon_path)
                        except Exception as exc:
                            self._record_error(exc)
                        applied.append(session)
                    except Exception as exc:
                        self._record_error(exc)
                if applied:
                    held_sessions = applied
                    with self._state_lock:
                        self._applied_sessions = len(applied)
                    self._applied.set()
                    stop.wait()
                    break
                stop.wait(self.poll_interval_seconds)
        except Exception as exc:
            self._record_error(exc)
        finally:
            held_sessions.clear()
            if co_initialized:
                try:
                    co_uninitialize()
                except Exception as exc:
                    self._record_error(exc)

    def _reset_result(self) -> None:
        self._applied.clear()
        with self._state_lock:
            self._applied_sessions = 0
            self._last_error = None

    def _record_error(self, error: Exception) -> None:
        message = f"{type(error).__name__}: {error}"
        with self._state_lock:
            first_error = self._last_error is None
            self._last_error = message
        if first_error:
            try:
                self._logger.warning("Windows audio session identity was not fully applied: %s", message)
            except Exception:
                # Session decoration must never become a playback failure path.
                pass


@contextmanager
def windows_audio_session_identity(
    display_name: str = _DEFAULT_DISPLAY_NAME,
    icon_path: str | Path | None = None,
    *,
    normalize_volume: bool | None = None,
) -> Iterator[WindowsAudioSessionIdentity]:
    """Convenience context for one synchronous Windows playback operation."""

    should_normalize = not _persistent_session_active.is_set() if normalize_volume is None else bool(normalize_volume)
    identity = WindowsAudioSessionIdentity(
        display_name=display_name,
        icon_path=icon_path,
        normalize_volume=should_normalize,
    )
    with identity.monitor():
        yield identity


def persistent_windows_audio_session_active() -> bool:
    return _persistent_session_active.is_set()


class WindowsAudioSessionKeepalive:
    """Keep one silent shared-mode render session alive for the Windows mixer.

    The stream emits only zeros. Its Core Audio multiplier is normalized once at
    startup, then left entirely under Windows/user control while the service runs.
    Failure is best-effort and never prevents RabiSpeech from serving TTS/ASR.
    """

    def __init__(
        self,
        *,
        enabled: bool | None = None,
        stream_factory: SilentStreamFactory | None = None,
        identity_factory: Callable[[], WindowsAudioSessionIdentity] | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self.enabled = os.name == "nt" if enabled is None else bool(enabled)
        self._stream_factory = stream_factory or _sounddevice_silent_stream
        self._identity_factory = identity_factory or (
            lambda: WindowsAudioSessionIdentity(normalize_volume=True)
        )
        self._logger = logger or logging.getLogger("rabispeech.windows_audio_session")
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._active = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_error: str | None = None

    @property
    def active(self) -> bool:
        return self._active.is_set()

    @property
    def last_error(self) -> str | None:
        with self._lock:
            return self._last_error

    def start(self, timeout: float = 2.5) -> bool:
        if not self.enabled:
            return False
        with self._lock:
            if self._thread and self._thread.is_alive():
                return self.active
            self._stop.clear()
            self._ready.clear()
            self._active.clear()
            self._last_error = None
            self._thread = threading.Thread(
                target=self._run,
                name="rabispeech-windows-mixer-session",
                daemon=True,
            )
            self._thread.start()
        self._ready.wait(max(0.1, float(timeout)))
        return self.active

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        with self._lock:
            thread = self._thread
        if thread and thread.is_alive():
            thread.join(max(0.1, float(timeout)))

    def _run(self) -> None:
        stream: Any = None
        owns_persistent_flag = False
        try:
            identity = self._identity_factory()
            with identity.monitor():
                stream = self._stream_factory(_fill_silence)
                stream.start()
                if identity.wait_until_applied(2.0):
                    _persistent_session_active.set()
                    owns_persistent_flag = True
                    self._active.set()
                elif identity.last_error:
                    raise RuntimeError(identity.last_error)
                else:
                    raise RuntimeError("Windows audio session did not become available.")
                self._ready.set()
                self._stop.wait()
        except Exception as exc:
            self._record_error(exc)
        finally:
            self._ready.set()
            self._active.clear()
            if owns_persistent_flag:
                _persistent_session_active.clear()
            if stream is not None:
                try:
                    stream.stop()
                except Exception as exc:
                    self._record_error(exc)
                try:
                    stream.close()
                except Exception as exc:
                    self._record_error(exc)

    def _record_error(self, error: Exception) -> None:
        message = f"{type(error).__name__}: {error}"
        with self._lock:
            first_error = self._last_error is None
            self._last_error = message
        if first_error:
            try:
                self._logger.warning("Windows mixer keepalive is unavailable: %s", message)
            except Exception:
                pass


def _fill_silence(outdata: Any, _frames: int, _time_info: Any, _status: Any) -> None:
    outdata.fill(0)


def _sounddevice_silent_stream(callback: Callable[..., None]) -> Any:
    import sounddevice as sd

    device = sd.query_devices(kind="output")
    channels = min(2, max(1, int(device.get("max_output_channels") or 0)))
    sample_rate = float(device.get("default_samplerate") or 48_000)
    return sd.OutputStream(
        channels=channels,
        samplerate=sample_rate,
        dtype="float32",
        callback=callback,
    )
