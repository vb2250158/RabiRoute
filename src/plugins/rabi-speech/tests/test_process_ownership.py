from __future__ import annotations

import asyncio
import importlib
import io
import subprocess
import sys
import types
import threading
from pathlib import Path

import pytest

# Exercise the process owners without importing the API and audio/model stack.
package = types.ModuleType("rabi_process_ownership_tests")
package.__path__ = [str(Path(__file__).resolve().parents[1] / "rabispeech")]
sys.modules[package.__name__] = package
CameraOwner = importlib.import_module(package.__name__ + ".all_day_camera").CameraOwner
worker_module = importlib.import_module(package.__name__ + ".worker_supervisor")
WorkerSupervisor, _ManagedProcess = worker_module.WorkerSupervisor, worker_module._ManagedProcess


class RefusingProcess:
    pid = 123456789

    def __init__(self):
        self.stdin = io.StringIO()
        self.exit_code = None

    def poll(self):
        return self.exit_code

    def wait(self, timeout=None):
        raise subprocess.TimeoutExpired("fixture", timeout)

    def terminate(self):
        raise PermissionError("fixture process termination denied")

    def kill(self):
        raise PermissionError("fixture process termination denied")


def test_failed_model_stop_retains_process_and_exclusive_group(monkeypatch):
    supervisor = WorkerSupervisor()
    process = RefusingProcess()
    log = io.BytesIO()
    owned = _ManagedProcess(key="fixture", process=process, log_handle=log)
    supervisor._processes[owned.key] = owned
    supervisor._groups["gpu"] = owned
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: None)
    with pytest.raises((PermissionError, subprocess.TimeoutExpired)):
        supervisor._terminate(owned)
    assert supervisor._processes[owned.key] is owned
    assert supervisor._groups["gpu"] is owned
    assert not log.closed


def test_failed_camera_stop_retains_exact_process_for_retry():
    owner = CameraOwner()
    process = RefusingProcess()
    owner._process, owner._session, owner._index = process, "fixture", 0
    with pytest.raises(PermissionError):
        owner.stop("fixture")
    assert owner._process is process
    assert owner._session == "fixture"
    assert not process.stdin.closed


def test_model_close_retains_failure_and_reconciles_same_owner(monkeypatch):
    supervisor = WorkerSupervisor()
    process = RefusingProcess()
    owned = _ManagedProcess(key="fixture", process=process, log_handle=io.BytesIO())
    supervisor._processes[owned.key] = owned
    supervisor._groups["gpu"] = owned
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: None)

    async def exercise():
        with pytest.raises(RuntimeError, match="shutdown remains unconfirmed"):
            await supervisor.close()
        with pytest.raises(RuntimeError, match="supervisor is stopped"):
            await supervisor.ensure("replacement", "http://127.0.0.1:1", worker_module.WorkerLaunch())
        with pytest.raises(RuntimeError, match="shutdown remains unconfirmed"):
            await supervisor.open()
        process.exit_code = 0
        await supervisor.close()
        assert not supervisor._processes and not supervisor._groups
        assert owned.log_handle.closed
        await supervisor.open()
    asyncio.run(exercise())


def test_real_model_workers_close_under_their_own_supervisor(tmp_path):
    first, second = WorkerSupervisor(), WorkerSupervisor()
    command = worker_module.WorkerLaunch(command=(sys.executable, "-c", "import time; time.sleep(120)"),
                                         working_directory=tmp_path)
    owners = [first._start("first", command, (), None), second._start("second", command, (), None)]
    first._processes["first"], second._processes["second"] = owners
    async def exercise():
        await first.close()
        assert owners[0].process.poll() is not None
        assert owners[1].process.poll() is None
        assert second._processes["second"] is owners[1]
        await second.close()
        assert owners[1].process.poll() is not None
    try:
        asyncio.run(exercise())
    finally:
        for owner in owners:
            if owner.process.poll() is None:
                owner.process.kill()
                owner.process.wait(timeout=5)
            owner.log_handle.close()


@pytest.mark.parametrize("refuse_cleanup", [False, True])
def test_cancelled_start_adopts_the_late_native_process_before_releasing_owner(tmp_path, monkeypatch, refuse_cleanup):
    supervisor = WorkerSupervisor()
    entered, resume = threading.Event(), threading.Event()
    processes = []
    terminate = supervisor._terminate
    def delayed_start(key, *_args):
        entered.set()
        assert resume.wait(timeout=5)
        process = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(120)"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        processes.append(process)
        return _ManagedProcess(key=key, process=process, log_handle=io.BytesIO())
    monkeypatch.setattr(supervisor, "_start", delayed_start)
    if refuse_cleanup:
        def deny(_owner):
            raise PermissionError("fixture native termination denied")
        monkeypatch.setattr(supervisor, "_terminate", deny)
    async def exercise():
        task = asyncio.create_task(supervisor.ensure("late", "http://127.0.0.1:1",
            worker_module.WorkerLaunch(command=(sys.executable, "local_tts_worker.py"), exclusive_group="gpu")))
        await asyncio.to_thread(entered.wait)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done(), "cancelled to_thread must retain the pending native start"
        resume.set()
        with pytest.raises(PermissionError if refuse_cleanup else asyncio.CancelledError):
            await task
        if refuse_cleanup:
            assert supervisor._processes["late"].process is processes[0]
            assert supervisor._groups["gpu"] is supervisor._processes["late"]
            with pytest.raises(RuntimeError, match="unconfirmed"):
                await supervisor.close()
            monkeypatch.setattr(supervisor, "_terminate", terminate)
        await supervisor.close()
        assert processes[0].poll() is not None
        assert not supervisor._processes and not supervisor._groups
    try:
        asyncio.run(exercise())
    finally:
        resume.set()
        for process in processes:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)


def test_external_health_probe_cannot_admit_a_request_after_close():
    async def exercise():
        supervisor = WorkerSupervisor()
        entered, resume = asyncio.Event(), asyncio.Event()
        async def healthy(_url):
            entered.set()
            await resume.wait()
            return True
        supervisor._healthy = healthy
        task = asyncio.create_task(supervisor.ensure("external", "http://127.0.0.1:1", worker_module.WorkerLaunch()))
        await entered.wait()
        await supervisor.close()
        resume.set()
        with pytest.raises(RuntimeError, match="stopped"):
            await task
        assert not supervisor._processes
    asyncio.run(exercise())


def test_registry_closes_standalone_provider_owners_without_stopping_another_registry(tmp_path):
    config = importlib.import_module(package.__name__ + ".config")
    registry_class = importlib.import_module(package.__name__ + ".registry").ProviderRegistry
    provider_class = importlib.import_module(package.__name__ + ".providers.local_tts").LocalTtsProvider
    first, second = registry_class("local-tts", "unused"), registry_class("local-tts", "unused")
    settings = config.LocalTtsSettings(True, "http://127.0.0.1:1", "default", 10, (), "fixture", ())
    providers = [provider_class(settings), provider_class(settings)]
    first.register_tts(providers[0]); second.register_tts(providers[1])
    launch = worker_module.WorkerLaunch(command=(sys.executable, "-c", "import time;time.sleep(120)"), working_directory=tmp_path)
    owned = [provider.worker_supervisor._start(str(index), launch, (), None) for index, provider in enumerate(providers)]
    for index, provider in enumerate(providers):
        provider.worker_supervisor._processes[str(index)] = owned[index]
    async def exercise():
        await first.close()
        assert owned[0].process.poll() is not None
        assert owned[1].process.poll() is None
        await first.open()
        assert not providers[0].worker_supervisor._closed
        await second.close()
        assert owned[1].process.poll() is not None
    try:
        asyncio.run(exercise())
    finally:
        for owner in owned:
            if owner.process.poll() is None:
                owner.process.kill(); owner.process.wait(timeout=5)
            owner.log_handle.close()


def test_exited_camera_broken_stdin_cleanup_preserves_original_worker_error():
    import queue
    process = RefusingProcess()
    class BrokenPipe:
        def write(self, _value): process.exit_code = 0
        def flush(self): pass
        def close(self): raise OSError(22, "already-exited child pipe")
    process.stdin = BrokenPipe()
    owner = CameraOwner()
    owner._process, owner._session, owner._index = process, "fixture", 0
    owner._replies = queue.Queue()
    owner._replies.put({"error": "original worker startup/lease failure"})
    with pytest.raises(RuntimeError, match="original worker startup/lease failure"):
        owner.snapshot("fixture", 0)
    assert owner._process is None and owner._session == "" and owner._index is None
