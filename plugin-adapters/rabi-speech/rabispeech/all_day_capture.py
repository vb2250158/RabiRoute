"""Bounded snapshots and an expiring lease on the existing microphone owner."""
from __future__ import annotations

if __package__:
    from .timeout_settings import get_timeout_seconds
else:
    # Camera and snapshot workers also run directly without importing the service.
    from pathlib import Path
    import runpy
    get_timeout_seconds = runpy.run_path(str(Path(__file__).with_name("timeout_settings.py")))["get_timeout_seconds"]


import asyncio
import base64
import ctypes
import io
import json
import os
import re
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

from fastapi import HTTPException, Request

if __package__:
    from .all_day_camera import CameraOwner


def capture_screen():
    # Release and source layouts expose the same desktop-owned, Qt-free module.
    package_root = Path(__file__).resolve().parents[3]
    desktop_root = package_root / "desktop-runtime"
    if not desktop_root.is_dir():
        desktop_root = package_root / "desktop" / "tray-task-window"
    desktop_path = str(desktop_root)
    if desktop_path not in sys.path:
        sys.path.insert(0, desktop_path)
    from rabiroute_tray.desktop_capture import capture_desktop_pixels
    return capture_desktop_pixels()


def capture_sources(sources: dict, camera_index: int) -> list[dict]:
    samples = []
    for source in ("screen", "window"):
        if not sources.get(source):
            continue
        try:
            if source == "window":
                if os.name != "nt":
                    raise RuntimeError("Foreground window capture requires Windows")
                user = ctypes.windll.user32
                user.GetForegroundWindow.restype = ctypes.c_void_p
                user.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
                user.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
                handle = user.GetForegroundWindow()
                buffer = ctypes.create_unicode_buffer(min(4096, user.GetWindowTextLengthW(handle) + 1))
                user.GetWindowTextW(handle, buffer, len(buffer))
                samples.append({"source": source, "text": buffer.value})
                continue
            picture = capture_screen()
            picture.thumbnail((1920, 1080))
            output = io.BytesIO()
            picture.convert("RGB").save(output, format="JPEG", quality=82)
            samples.append({"source": source, "jpeg": base64.b64encode(output.getvalue()).decode("ascii")})
        except Exception as error:
            samples.append({"source": source, "error": str(error)[:500]})
    return samples


def bounded_capture(sources: dict, camera_index: int) -> list[dict]:
    # Screen/window snapshots use a bounded process; camera has its own lease owner.
    # Embedded Python's ._pth ignores PYTHONPATH; restore the owner's verified
    # module paths before loading imports in the snapshot worker.
    bootstrap = "import json,runpy,sys; sys.path[:0]=json.loads(sys.argv[1]); runpy.run_path(sys.argv[2],run_name='__main__')"
    result = subprocess.run(
        [sys.executable, "-B", "-c", bootstrap, json.dumps(sys.path), os.path.abspath(__file__)],
        input=json.dumps({"sources": sources, "cameraIndex": camera_index}),
        capture_output=True, text=True, encoding="utf-8", timeout=get_timeout_seconds("speech.capture.snapshot", 15),
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        env={**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)},
    )
    if result.returncode:
        raise RuntimeError("Snapshot process failed: " + result.stderr[-500:])
    return json.loads(result.stdout)


def register_all_day_capture(api, microphone, require_loopback):
    camera = CameraOwner()
    gate = asyncio.Lock()
    lease = {"id": "", "deadline": None, "config": None, "owned": False, "audio_session": ""}

    def authorize(request):
        require_loopback(request)
        if request.headers.get("x-rabilink-tunnel-local"):
            raise HTTPException(403, "Computer capture cannot be started through a device tunnel")

    async def release(session_id):
        async with gate:
            if lease["id"] != session_id:
                return
            if lease["owned"] and microphone.config.session_id == session_id:
                await microphone.stop(persist=False)
                if lease["config"] is not None:
                    microphone.config = replace(microphone.config, session_id=lease["config"].session_id)
            lease["id"] = ""
            if lease["deadline"] is not None:
                lease["deadline"].cancel()
            lease["deadline"] = None

    def renew(session_id, seconds):
        if lease["deadline"] is not None:
            lease["deadline"].cancel()
        def expire():
            task = asyncio.create_task(release(session_id))
            task.add_done_callback(lambda completed: completed.exception() if not completed.cancelled() else None)
        lease["deadline"] = asyncio.get_running_loop().call_later(seconds, expire)

    @api.post("/v1/all-day/microphone/start")
    async def start(request: Request, body: dict):
        authorize(request)
        session_id = body.get("sessionId", "")
        if not isinstance(session_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", session_id):
            raise HTTPException(422, "Invalid recording session")
        async with gate:
            if lease["id"] == session_id:
                state = microphone.snapshot()
                if state.get("audio_stream", {}).get("source") == "remote" or microphone.config.session_id != lease["audio_session"]:
                    raise HTTPException(409, "麦克风输入来源已改变")
                if not state.get("stream_active", state.get("running", False)):
                    await microphone.stop(persist=False)
                    await microphone.start({"session_id": lease["audio_session"]}, persist=False)
                renew(session_id, 90)
                return {"ok": True, "audioSessionId": lease["audio_session"], "shared": not lease["owned"]}
            if lease["id"]:
                raise HTTPException(409, "另一项全天记录正在使用麦克风")
            state = microphone.snapshot()
            if state.get("audio_stream", {}).get("source") == "remote":
                raise HTTPException(409, "当前语音输入来自远端设备，请先在语音服务中切换到电脑麦克风")
            lease["owned"] = not state.get("running", False)
            lease["config"] = replace(microphone.config) if lease["owned"] else None
            if lease["owned"]:
                await microphone.start({"session_id": session_id}, persist=False)
            lease["audio_session"] = microphone.config.session_id
            lease["id"] = session_id
            renew(session_id, 90)
        return {"ok": True, "audioSessionId": lease["audio_session"], "shared": not lease["owned"]}

    @api.post("/v1/all-day/microphone/renew")
    async def renew_microphone(request: Request, body: dict):
        authorize(request)
        async with gate:
            state = microphone.snapshot()
            if (not lease["id"] or lease["id"] != body.get("sessionId")
                    or microphone.config.session_id != lease["audio_session"]
                    or not state.get("running")
                    or state.get("audio_stream", {}).get("source") == "remote"):
                raise HTTPException(409, "Microphone recording lease is no longer active")
            renew(lease["id"], 90)
        return {"ok": True}

    @api.post("/v1/all-day/microphone/stop")
    async def stop(request: Request, body: dict):
        authorize(request)
        await release(body.get("sessionId", ""))
        return {"ok": True}

    @api.post("/v1/all-day/capture/renew")
    async def renew_camera(request: Request, body: dict):
        authorize(request)
        session_id = body.get("sessionId", "")
        if not isinstance(session_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", session_id):
            raise HTTPException(422, "Invalid recording session")
        await asyncio.to_thread(camera.renew, session_id)
        return {"ok": True}

    @api.post("/v1/all-day/capture/stop")
    async def stop_camera(request: Request, body: dict):
        authorize(request)
        session_id = body.get("sessionId", "")
        if not isinstance(session_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", session_id):
            raise HTTPException(422, "Invalid recording session")
        await asyncio.to_thread(camera.stop, session_id)
        return {"ok": True}

    @api.post("/v1/all-day/capture")
    async def capture(request: Request, body: dict):
        authorize(request)
        sources = body.get("sources", {})
        index = body.get("cameraIndex", 0)
        interval = body.get("intervalSeconds", 60)
        if not isinstance(sources, dict) or any(type(value) is not bool for value in sources.values()) or type(index) is not int or not 0 <= index <= 16 or type(interval) is not int or not 10 <= interval <= 3600:
            raise HTTPException(422, "Invalid capture settings")
        session_id = body.get("sessionId", "")
        if sources.get("camera") and (not isinstance(session_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", session_id)):
            raise HTTPException(422, "Invalid recording session")
        async with gate:
            if sources.get("microphone"):
                if lease["id"] != session_id or microphone.config.session_id != lease["audio_session"] or not microphone.snapshot().get("running") or microphone.snapshot().get("audio_stream", {}).get("source") == "remote":
                    raise HTTPException(409, "麦克风监听已停止或输入来源已改变，请重新开始全天记录")
                renew(session_id, interval + 45)
        async def one(source):
            try:
                if source == "camera":
                    return [await asyncio.to_thread(camera.snapshot, session_id, index)]
                return await asyncio.to_thread(bounded_capture, {source: True}, index)
            except Exception as error:
                return [{"source": source, "error": "Snapshot timed out" if isinstance(error, subprocess.TimeoutExpired) else str(error)[:500]}]
        groups = await asyncio.gather(*(one(source) for source in ("screen", "window", "camera") if sources.get(source)))
        return {"samples": [sample for group in groups for sample in group]}

    async def shutdown():
        await asyncio.to_thread(camera.stop)
        await release(lease["id"])
    return shutdown


if __name__ == "__main__":
    command = json.load(sys.stdin)
    print(json.dumps(capture_sources(command["sources"], command["cameraIndex"]), ensure_ascii=True))
