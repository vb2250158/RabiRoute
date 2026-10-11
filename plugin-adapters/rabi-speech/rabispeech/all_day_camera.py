"""One bounded camera process per recording lease; frames stay in memory."""
from __future__ import annotations

import base64
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time


CAMERA_LEASE_SECONDS = 120
CAMERA_WARMUP_SECONDS = 2.0
CAMERA_WARMUP_FRAMES = 15


class CameraOwner:
    def __init__(self, *, snapshot_timeout=15):
        self._gate = threading.RLock()
        self._process = None
        self._session = ""
        self._index = None
        self._replies = None
        self._snapshot_timeout = snapshot_timeout

    def _send(self, command):
        self._process.stdin.write(json.dumps(command) + "\n")
        self._process.stdin.flush()

    def _close(self):
        process = self._process
        self._process = None
        self._session = ""
        self._index = None
        self._replies = None
        if process is None:
            return
        try:
            if process.poll() is None:
                try:
                    process.stdin.write('{"command":"stop"}\n')
                    process.stdin.flush()
                    process.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired):
                    process.kill()
                    process.wait(timeout=2)
        finally:
            process.stdin.close()
            # The sole reader closes stdout after EOF; don't close a blocked
            # TextIOWrapper from another thread when a driver has hung.

    def stop(self, session_id=None):
        with self._gate:
            if session_id is None or self._session == session_id:
                self._close()

    def renew(self, session_id):
        with self._gate:
            if self._session == session_id and self._process is not None:
                if self._process.poll() is not None:
                    self._close()
                else:
                    try:
                        self._send({"command": "renew"})
                    except OSError:
                        self._close()

    def snapshot(self, session_id, index):
        with self._gate:
            if self._process is not None and self._process.poll() is not None:
                self._close()
            if self._session and self._session != session_id:
                raise RuntimeError("另一项全天记录正在使用摄像头")
            if self._process is not None and self._index != index:
                self._close()
            if self._process is None:
                bootstrap = "import json,runpy,sys; sys.path[:0]=json.loads(sys.argv[1]); runpy.run_path(sys.argv[2],run_name='__main__')"
                process = subprocess.Popen(
                    [sys.executable, "-B", "-u", "-c", bootstrap, json.dumps(sys.path), str(Path(__file__).resolve()), str(index)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, encoding="utf-8", bufsize=1,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
                replies = queue.Queue(maxsize=2)

                def read_replies():
                    try:
                        while True:
                            line = process.stdout.readline(4 * 1024 * 1024 + 1)
                            if not line:
                                break
                            if len(line) > 4 * 1024 * 1024:
                                raise RuntimeError("Camera response exceeded size limit")
                            replies.put_nowait(json.loads(line))
                    except Exception:
                        pass
                    finally:
                        process.stdout.close()
                        try:
                            replies.put_nowait({"error": "Camera worker stopped"})
                        except queue.Full:
                            pass

                threading.Thread(target=read_replies, name="all-day-camera-replies", daemon=True).start()
                self._process, self._session, self._index, self._replies = process, session_id, index, replies
            try:
                self._send({"command": "snapshot"})
                reply = self._replies.get(timeout=self._snapshot_timeout)
                if reply.get("error"):
                    raise RuntimeError(reply["error"])
                if not isinstance(reply.get("jpeg"), str):
                    raise RuntimeError("Camera returned no frame")
                return {"source": "camera", "jpeg": reply["jpeg"]}
            except queue.Empty:
                self._close()
                raise RuntimeError("Camera snapshot timed out") from None
            except Exception:
                self._close()
                raise


def camera_worker(index, *, warmup_seconds=CAMERA_WARMUP_SECONDS, warmup_frames=CAMERA_WARMUP_FRAMES):
    commands = queue.Queue(maxsize=8)
    stopped = threading.Event()
    deadline = [time.monotonic() + CAMERA_LEASE_SECONDS]

    def receive():
        try:
            for line in sys.stdin:
                command = json.loads(line)
                if command.get("command") == "stop":
                    stopped.set()
                    return
                deadline[0] = time.monotonic() + CAMERA_LEASE_SECONDS
                if command.get("command") == "snapshot":
                    commands.put_nowait(command)
        finally:
            # Also handles a crashed parent. The watchdog can terminate even
            # if VideoCapture.read() is blocked inside the driver.
            stopped.set()

    def watchdog():
        while True:
            if stopped.wait(1) or time.monotonic() >= deadline[0]:
                stopped.set()
                # Give a healthy reader time to reach finally/release().
                time.sleep(0.5)
                os._exit(0)

    threading.Thread(target=watchdog, name="all-day-camera-lease", daemon=True).start()
    camera = None
    try:
        import cv2
        from PIL import Image
        threading.Thread(target=receive, name="all-day-camera-commands", daemon=True).start()
        camera = cv2.VideoCapture(index, cv2.CAP_DSHOW if os.name == "nt" else cv2.CAP_ANY)
        if not camera.isOpened():
            raise RuntimeError("Camera unavailable or permission denied")
        opened_at = time.monotonic()
        frames = 0
        pending = False
        while not stopped.is_set():
            success, frame = camera.read()
            if not success:
                raise RuntimeError("Camera returned no frame")
            frames += 1
            while not commands.empty():
                commands.get_nowait()
                pending = True
            if not pending or frames < warmup_frames or time.monotonic() - opened_at < warmup_seconds:
                continue
            picture = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            picture.thumbnail((1920, 1080))
            output = io.BytesIO()
            picture.convert("RGB").save(output, format="JPEG", quality=82)
            print(json.dumps({"jpeg": base64.b64encode(output.getvalue()).decode("ascii")}), flush=True)
            pending = False
    except Exception as error:
        print(json.dumps({"error": str(error)[:500]}), flush=True)
    finally:
        if camera is not None:
            camera.release()


if __name__ == "__main__":
    camera_worker(int(sys.argv[3]))
