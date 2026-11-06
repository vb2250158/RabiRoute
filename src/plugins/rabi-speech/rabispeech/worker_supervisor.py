from __future__ import annotations

from .timeout_settings import get_timeout_seconds


import asyncio
import os
import subprocess
import tempfile
import time
import json
from dataclasses import dataclass
from pathlib import Path

import httpx


@dataclass(frozen=True)
class WorkerLaunch:
    command: tuple[str, ...] = ()
    working_directory: Path | None = None
    exclusive_group: str = ""
    startup_timeout_seconds: float = 240.0
    environment: tuple[tuple[str, str], ...] = ()


@dataclass
class _ManagedProcess:
    key: str
    process: subprocess.Popen[bytes]
    log_handle: object
    base_url: str = ""


class WorkerSupervisor:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._groups: dict[str, _ManagedProcess] = {}
        self._processes: dict[str, _ManagedProcess] = {}
        self._closed = False

    async def open(self) -> None:
        async with self._lock:
            if self._closed and self._processes:
                raise RuntimeError("Model worker shutdown remains unconfirmed")
            self._closed = False

    async def close(self) -> None:
        async with self._lock:
            self._closed = True
            owned = list(self._processes.values())
            results = await asyncio.gather(
                *(asyncio.to_thread(self._terminate, managed) for managed in owned),
                return_exceptions=True,
            )
            failed = [(managed.key, result) for managed, result in zip(owned, results)
                      if isinstance(result, BaseException)]
            if failed:
                raise RuntimeError("Model worker shutdown remains unconfirmed: " +
                                   ", ".join(key for key, _ in failed)) from failed[0][1]

    async def ensure(self, key: str, base_url: str, launch: WorkerLaunch) -> str:
        if self._closed:
            raise RuntimeError("Model worker supervisor is stopped")
        managed_command = self._dynamic_command(launch.command)
        if not managed_command and await self._healthy(base_url):
            if self._closed:
                raise RuntimeError("Model worker supervisor is stopped")
            return base_url
        async with self._lock:
            if self._closed:
                raise RuntimeError("Model worker supervisor is stopped")
            current = self._processes.get(key)
            if current and current.process.poll() is not None:
                self._forget(current)
                current = None
            if current and current.base_url and await self._healthy(current.base_url):
                return current.base_url
            if not managed_command and await self._healthy(base_url):
                return base_url
            if not current:
                if not launch.command:
                    raise RuntimeError(f"Local model worker is offline and has no launch command: {key}")
                if launch.exclusive_group:
                    previous = self._groups.get(launch.exclusive_group)
                    if previous and previous.key != key:
                        await asyncio.to_thread(self._terminate, previous)
                endpoint_dir = tempfile.TemporaryDirectory(prefix="rabispeech-worker-") if managed_command else None
                endpoint_file = Path(endpoint_dir.name) / "endpoint.json" if endpoint_dir else None
                try:
                    started = asyncio.create_task(asyncio.to_thread(self._start, key, launch, managed_command, endpoint_file))
                    cancellation = None
                    try:
                        current = await asyncio.shield(started)
                    except asyncio.CancelledError as error:
                        cancellation = error
                        # A cancelled await cannot cancel subprocess.Popen in
                        # the thread. Adopt its exact late result before cleanup.
                        current = await self._join_owned_task(started)
                except BaseException:
                    if endpoint_dir:
                        endpoint_dir.cleanup()
                    raise
                self._processes[key] = current
                if launch.exclusive_group:
                    self._groups[launch.exclusive_group] = current
                if cancellation is not None:
                    try:
                        await self._join_owned_task(asyncio.create_task(asyncio.to_thread(self._terminate, current)))
                    finally:
                        if endpoint_dir:
                            endpoint_dir.cleanup()
                    raise cancellation

            else:
                endpoint_dir = None
                endpoint_file = None
            deadline = time.perf_counter() + get_timeout_seconds("speech.worker.start", launch.startup_timeout_seconds)
            try:
                while time.perf_counter() < deadline:
                    if current.process.poll() is not None:
                        self._forget(current)
                        raise RuntimeError(f"Local model worker exited during startup: {key}")
                    if endpoint_file and endpoint_file.is_file():
                        receipt = json.loads(endpoint_file.read_text(encoding="utf-8"))
                        port = receipt.get("port")
                        if type(port) is not int or not 1 <= port <= 65535:
                            raise RuntimeError(f"Local model worker returned an invalid endpoint: {key}")
                        current.base_url = f"http://127.0.0.1:{port}"
                    target = current.base_url or (base_url if not managed_command else "")
                    if target and await self._healthy(target) and current.process.poll() is None:
                        current.base_url = target
                        return target
                    await asyncio.sleep(0.5)
                raise TimeoutError(f"Timed out starting local model worker: {key}")
            except BaseException:
                await asyncio.to_thread(self._terminate, current)
                raise
            finally:
                if endpoint_dir:
                    endpoint_dir.cleanup()

    @staticmethod
    async def _join_owned_task(task):
        while True:
            try:
                return await asyncio.shield(task)
            except asyncio.CancelledError:
                if task.done():
                    return task.result()

    @staticmethod
    def _dynamic_command(command: tuple[str, ...]) -> tuple[str, ...]:
        if not any(Path(arg).name in {"local_tts_worker.py", "local_asr_worker.py", "local_onnx_vits_worker.py"} for arg in command):
            return ()
        result = list(command)
        for flag, value in (("--port", "0"), ("--host", "127.0.0.1")):
            index = next((i for i, arg in enumerate(result) if arg == flag or arg.startswith(flag + "=")), -1)
            if index < 0:
                result.extend((flag, value))
            elif result[index] == flag:
                if index + 1 >= len(result):
                    raise ValueError(f"Missing value for {flag} in managed worker command")
                result[index + 1] = value
            else:
                result[index] = flag + "=" + value
        return tuple(result)

    def _start(self, key: str, launch: WorkerLaunch, command: tuple[str, ...], endpoint_file: Path | None) -> _ManagedProcess:
        workdir = launch.working_directory or Path.cwd()
        log_dir = workdir / "output" / "worker-logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        safe_key = "".join(char if char.isalnum() or char in "-_" else "-" for char in key)
        log_handle = (log_dir / f"{safe_key}.log").open("ab", buffering=0)
        environment = os.environ.copy()
        # RabiSpeech itself runs from a private --target directory. Model
        # workers use isolated venvs and must not import that directory's
        # tokenizers/torch/numpy ahead of their own pinned runtime.
        environment.pop("PYTHONPATH", None)
        environment.pop("PYTHONHOME", None)
        environment.update(dict(launch.environment))
        if endpoint_file:
            environment["RABISPEECH_WORKER_ENDPOINT_FILE"] = str(endpoint_file)
        executable = Path(launch.command[0]).expanduser()
        if executable.is_absolute() and executable.is_file():
            # Some model loaders invoke `pip` for a local requirements check.
            # A venv interpreter launched by absolute path does not activate its
            # Scripts directory, so expose sibling helpers without activating a shell.
            environment["PATH"] = f"{executable.parent}{os.pathsep}{environment.get('PATH', '')}"
        try:
            process = subprocess.Popen(
                list(command or launch.command),
                cwd=str(workdir),
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except BaseException:
            log_handle.close()
            raise
        return _ManagedProcess(key=key, process=process, log_handle=log_handle)

    def _terminate(self, managed: _ManagedProcess) -> None:
        try:
            if managed.process.poll() is None:
                if os.name == "nt":
                    # Some model launchers re-exec through uv/py. Terminating
                    # only the wrapper would orphan the GPU-owning worker.
                    subprocess.run(
                        ["taskkill", "/PID", str(managed.process.pid), "/T", "/F"],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                        check=False,
                    )
                else:
                    managed.process.terminate()
                try:
                    managed.process.wait(timeout=get_timeout_seconds("speech.worker.stop", 10))
                except subprocess.TimeoutExpired:
                    managed.process.kill()
                    managed.process.wait(timeout=get_timeout_seconds("speech.worker.kill", 5))
        finally:
            # Failed termination retains both the process and its exclusive group.
            # A later cleanup must reconcile this same owner before any replacement.
            if managed.process.poll() is not None:
                self._forget(managed)

    def _forget(self, managed: _ManagedProcess) -> None:
        self._processes.pop(managed.key, None)
        for group, current in list(self._groups.items()):
            if current is managed:
                self._groups.pop(group, None)
        try:
            managed.log_handle.close()
        except Exception:
            pass

    @staticmethod
    async def _healthy(base_url: str) -> bool:
        timeout = httpx.Timeout(get_timeout_seconds("speech.worker.health", 1), connect=get_timeout_seconds("speech.worker.healthConnect", 0.5))
        async with httpx.AsyncClient(timeout=timeout) as client:
            for path in ("/health", "/status"):
                try:
                    response = await client.get(f"{base_url.rstrip('/')}{path}")
                    if response.is_success:
                        return True
                except httpx.HTTPError:
                    continue
        return False
