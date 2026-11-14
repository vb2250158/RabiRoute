from __future__ import annotations

import importlib
from functools import partial
import json
import os
import socket
import sys
import time
from pathlib import Path
from typing import MutableMapping, MutableSequence, Sequence


_RUNTIME_DIRECTORY = "runtime"
_TRANSIENT_NETWORK_RETRY_COUNT = 5
_TRANSIENT_NETWORK_RETRY_SECONDS = 2.0
# WHATWG Fetch's restricted ports must never be published to Manager/WebGUI.
_FETCH_BLOCKED_PORTS = frozenset((
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
    79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
    135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530,
    531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
    1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
    6666, 6667, 6668, 6669, 6679, 6697, 10080,
))


def resolve_service_root(
    *,
    executable: str | Path | None = None,
    script_path: str | Path | None = None,
    environment: MutableMapping[str, str] | None = None,
    frozen: bool | None = None,
) -> Path:
    env = environment if environment is not None else os.environ
    configured = str(env.get("RABISPEECH_ROOT") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve()

    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else bool(frozen)
    if is_frozen:
        host = Path(executable or sys.executable).expanduser().resolve()
        return host.parent.parent if host.parent.name.lower() == _RUNTIME_DIRECTORY else host.parent

    source = Path(script_path or __file__).expanduser().resolve()
    return source.parents[1]


def resolve_runtime_data_root(
    service_root: str | Path,
    *,
    environment: MutableMapping[str, str] | None = None,
) -> Path:
    env = environment if environment is not None else os.environ
    configured = str(env.get("RABISPEECH_DATA_ROOT") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = str(env.get("LOCALAPPDATA") or "").strip()
    if local_app_data:
        return (Path(local_app_data).expanduser() / "RabiPC" / "RabiSpeech").resolve()
    return Path(service_root).expanduser().resolve()


def resolve_runtime_config(
    service_root: str | Path,
    *,
    environment: MutableMapping[str, str] | None = None,
) -> Path:
    root = Path(service_root).expanduser().resolve()
    env = environment if environment is not None else os.environ
    configured = str(env.get("RABISPEECH_CONFIG") or "").strip()
    config = Path(configured).expanduser().resolve() if configured else resolve_runtime_data_root(root, environment=env) / "config.json"
    if config.is_file():
        return config
    source = root / "config.json"
    if not source.is_file():
        source = root / "config.example.json"
    if not source.is_file():
        raise RuntimeError(f"RabiSpeech configuration is missing: {config}")
    config.parent.mkdir(parents=True, exist_ok=True)
    temporary = config.with_suffix(config.suffix + ".tmp")
    temporary.write_bytes(source.read_bytes())
    temporary.replace(config)
    return config.resolve()


def configure_runtime(
    service_root: str | Path,
    *,
    environment: MutableMapping[str, str] | None = None,
    module_paths: MutableSequence[str] | None = None,
) -> dict[str, str]:
    root = Path(service_root).expanduser().resolve()
    env = environment if environment is not None else os.environ
    dependencies = Path(env.get("RABISPEECH_DEPS_ROOT") or root / ".deps").expanduser().resolve()
    if not dependencies.is_dir():
        raise RuntimeError(f"RabiSpeech dependencies are missing: {dependencies}")

    env = environment if environment is not None else os.environ
    config = resolve_runtime_config(root, environment=env)
    paths = module_paths if module_paths is not None else sys.path
    for item in (str(root), str(dependencies)):
        if item not in paths:
            paths.insert(0, item)

    existing_python_path = str(env.get("PYTHONPATH") or "").strip()
    env["PYTHONPATH"] = os.pathsep.join(
        item for item in (str(dependencies), str(root), existing_python_path) if item
    )
    env["RABISPEECH_ROOT"] = str(root)
    env["RABISPEECH_DATA_ROOT"] = str(config.parent)
    env["RABISPEECH_CONFIG"] = str(config)

    # Both native packaged startup and the source PowerShell launcher use these
    # defaults. Explicit model paths and configured relative Whisper roots win.
    model_root = str(env.get("RABISPEECH_MODEL_ROOT") or "").strip()
    if not model_root:
        model_root = str(config.parent.parent / "models" / "rabispeech")
    env["RABISPEECH_MODEL_ROOT"] = model_root
    if not str(env.get("RABISPEECH_WHISPER_MODEL_ROOT") or "").strip():
        settings = json.loads(config.read_text(encoding="utf-8-sig"))
        configured = settings
        for key in ("providers", "asr", "faster_whisper", "model_root"):
            configured = configured.get(key) if isinstance(configured, dict) else None
        whisper_root = Path(configured).expanduser() if isinstance(configured, str) and configured.strip() else Path(model_root) / "asr" / "faster-whisper-cache"
        if not whisper_root.is_absolute():
            whisper_root = config.parent / whisper_root
        env["RABISPEECH_WHISPER_MODEL_ROOT"] = str(whisper_root.resolve())
    if not str(env.get("RABISPEECH_SPEAKER_MODEL_PATH") or "").strip():
        env["RABISPEECH_SPEAKER_MODEL_PATH"] = str(Path(model_root) / "speaker" / "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx")

    nvidia_root = dependencies / "nvidia"
    nvidia_bins = sorted(
        str(candidate)
        for candidate in nvidia_root.glob("*/bin")
        if candidate.is_dir()
    )
    if nvidia_bins:
        env["PATH"] = os.pathsep.join([*nvidia_bins, str(env.get("PATH") or "")])

    return {
        "service_root": str(root),
        "dependencies": str(dependencies),
        "config": str(config),
    }


def is_transient_network_filesystem_error(error: BaseException) -> bool:
    current: BaseException | None = error
    visited: set[int] = set()
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        if isinstance(current, OSError) and getattr(current, "winerror", None) == 59:
            return True
        current = current.__cause__ or current.__context__
    return False


def _run_managed_application(*, sockets: list[socket.socket], stop_event=None) -> None:
    """Run inside the existing native process or Uvicorn reload child/Job."""
    uvicorn = importlib.import_module("uvicorn")
    settings = importlib.import_module("rabispeech.config").load_settings()
    nonce = os.environ.get("RABISPEECH_ENDPOINT_NONCE", "")

    class ReadyServer(uvicorn.Server):
        async def on_tick(self, counter):
            if stop_event is not None and stop_event.is_set():
                self.should_exit = True
            return await super().on_tick(counter)

        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            if not self.started or self.should_exit:
                return
            address = sockets[0].getsockname()
            print("RABISPEECH_READY:" + json.dumps({
                "schemaVersion": 1, "pid": os.getpid(), "nonce": nonce,
                "host": address[0], "port": address[1],
            }), flush=True)

    # Preserve Uvicorn's subprocess event-loop policy on Windows. A Proactor
    # loop cannot safely inherit the listening socket across reload workers.
    config = uvicorn.Config("rabispeech.app:create_app", factory=True,
                            host=settings.server.host, port=0, log_level="info", ws="auto",
                            reload=stop_event is not None,
                            reload_dirs=[str(resolve_service_root() / "rabispeech")] if stop_event is not None else None)
    server = ReadyServer(config)
    server.run(sockets=sockets)
    if not server.started:
        raise RuntimeError("RabiSpeech ASGI startup did not complete.")


def _bind_automatic_socket(host: str) -> socket.socket:
    for _attempt in range(128):
        listener = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)
        try:
            if os.name == "nt":
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            listener.bind((host, 0))
            listener.set_inheritable(True)
            if listener.getsockname()[1] not in _FETCH_BLOCKED_PORTS:
                return listener
        except BaseException:
            listener.close()
            raise
        listener.close()
    raise RuntimeError("Could not allocate a browser-compatible RabiSpeech port.")


def _run_managed_server(uvicorn, settings, *, reload: bool) -> None:
    host = settings.server.host
    if os.environ.get("RABISPEECH_ENDPOINT_NONCE") and host not in ("127.0.0.1", "::1"):
        raise RuntimeError("Managed Speech requires an explicit loopback bind address.")
    # Bind once and keep the socket held across ASGI startup and reload. The
    # owner receives the actual endpoint only after Uvicorn reports started.
    listener = _bind_automatic_socket(host)
    try:
        if reload:
            config = uvicorn.Config("rabispeech.app:create_app", factory=True, host=host, port=0,
                                    reload=True, reload_dirs=[str(resolve_service_root() / "rabispeech")])
            # A module-level target is required by Windows multiprocessing spawn.
            change_reload = importlib.import_module("uvicorn.supervisors").ChangeReload
            stop_event = importlib.import_module("multiprocessing").get_context("spawn").Event()
            target = partial(_run_managed_application, stop_event=stop_event)

            class ManagedReload(change_reload):
                def stop_worker(self):
                    stop_event.set()
                    self.process.join(timeout=10)
                    if self.process.is_alive():
                        importlib.import_module("logging").getLogger("uvicorn.error").error(
                            "Speech reload retirement remains unconfirmed; retaining the original worker and starting no replacement.")
                        self.should_exit.set()
                        # Keep the original supervisor/process handle while
                        # application shutdown remains pending. The Host may
                        # still terminate its owned tree, but no new worker
                        # may acquire the shared listener before actual exit.
                        self.process.join()

                def restart(self):
                    # Hidden Windows processes have no console Ctrl+C channel.
                    # Request normal ASGI shutdown through inherited IPC instead.
                    self.stop_worker()
                    if self.should_exit.is_set():
                        return
                    # StatReload clears its observed mtimes before restart;
                    # WatchFilesReload has no such cache to reset.
                    if hasattr(self, "mtimes"):
                        self.mtimes.clear()
                    stop_event.clear()
                    get_subprocess = importlib.import_module("uvicorn._subprocess").get_subprocess
                    self.process = get_subprocess(config=self.config, target=self.target, sockets=self.sockets)
                    self.process.start()

                def shutdown(self):
                    self.stop_worker()
                    super().shutdown()

            ManagedReload(config, target=target, sockets=[listener]).run()
        else:
            _run_managed_application(sockets=[listener])
    finally:
        listener.close()


def run_server(*, reload: bool = False) -> None:
    uvicorn = importlib.import_module("uvicorn")
    config_module = importlib.import_module("rabispeech.config")
    settings = config_module.load_settings()
    if os.environ.get("RABISPEECH_ENDPOINT_NONCE") or settings.server.port == 0:
        _run_managed_server(uvicorn, settings, reload=reload)
        return
    if reload:
        service_root = resolve_service_root()
        uvicorn.run(
            "rabispeech.app:create_app",
            factory=True,
            host=settings.server.host,
            port=settings.server.port,
            log_level="info",
            ws="auto",
            reload=True,
            reload_dirs=[str(service_root / "rabispeech")],
        )
        return

    app_module = importlib.import_module("rabispeech.app")
    uvicorn.run(
        app_module.create_app(settings),
        host=settings.server.host,
        port=settings.server.port,
        log_level="info",
        ws="auto",
    )


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(argv if argv is not None else sys.argv[1:])
    root = resolve_service_root()
    runtime = configure_runtime(root)
    if "--probe" in arguments:
        print(
            json.dumps(
                {
                    **runtime,
                    "executable": str(Path(sys.executable).resolve()),
                    "frozen": bool(getattr(sys, "frozen", False)),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0
    reload_enabled = "--reload" in arguments
    for attempt in range(1, _TRANSIENT_NETWORK_RETRY_COUNT + 1):
        try:
            run_server(reload=reload_enabled)
            break
        except BaseException as error:
            if (
                reload_enabled
                or attempt >= _TRANSIENT_NETWORK_RETRY_COUNT
                or not is_transient_network_filesystem_error(error)
            ):
                raise
            print(
                "RabiSpeech startup hit transient Windows network error 59; "
                f"retrying ({attempt}/{_TRANSIENT_NETWORK_RETRY_COUNT}).",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(_TRANSIENT_NETWORK_RETRY_SECONDS)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
