from __future__ import annotations

import asyncio
import os
import subprocess
import time
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


class WorkerSupervisor:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._groups: dict[str, _ManagedProcess] = {}
        self._processes: dict[str, _ManagedProcess] = {}

    async def ensure(self, key: str, base_url: str, launch: WorkerLaunch) -> float:
        if await self._healthy(base_url):
            return 0.0
        async with self._lock:
            if await self._healthy(base_url):
                return 0.0
            current = self._processes.get(key)
            if current and current.process.poll() is not None:
                self._forget(current)
                current = None
            if not current:
                if not launch.command:
                    raise RuntimeError(f"Local model worker is offline and has no launch command: {key}")
                if launch.exclusive_group:
                    previous = self._groups.get(launch.exclusive_group)
                    if previous and previous.key != key:
                        await asyncio.to_thread(self._terminate, previous)
                current = await asyncio.to_thread(self._start, key, launch)
                self._processes[key] = current
                if launch.exclusive_group:
                    self._groups[launch.exclusive_group] = current

            started = time.perf_counter()
            deadline = started + launch.startup_timeout_seconds
            while time.perf_counter() < deadline:
                if current.process.poll() is not None:
                    self._forget(current)
                    raise RuntimeError(f"Local model worker exited during startup: {key}")
                if await self._healthy(base_url):
                    return time.perf_counter() - started
                await asyncio.sleep(0.5)
            await asyncio.to_thread(self._terminate, current)
            raise TimeoutError(f"Timed out starting local model worker: {key}")

    def _start(self, key: str, launch: WorkerLaunch) -> _ManagedProcess:
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
        executable = Path(launch.command[0]).expanduser()
        if executable.is_absolute() and executable.is_file():
            # Some model loaders invoke `pip` for a local requirements check.
            # A venv interpreter launched by absolute path does not activate its
            # Scripts directory, so expose sibling helpers without activating a shell.
            environment["PATH"] = f"{executable.parent}{os.pathsep}{environment.get('PATH', '')}"
        process = subprocess.Popen(
            list(launch.command),
            cwd=str(workdir),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
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
                    managed.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    managed.process.kill()
                    managed.process.wait(timeout=5)
        finally:
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
        timeout = httpx.Timeout(1.0, connect=0.5)
        async with httpx.AsyncClient(timeout=timeout) as client:
            for path in ("/health", "/status"):
                try:
                    response = await client.get(f"{base_url.rstrip('/')}{path}")
                    if response.is_success:
                        return True
                except httpx.HTTPError:
                    continue
        return False


worker_supervisor = WorkerSupervisor()
