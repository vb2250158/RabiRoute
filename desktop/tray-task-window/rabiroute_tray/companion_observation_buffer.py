"""Volatile interval recording. Manager supplies the consumed boundary.

Frames, assembled video clips and mono PCM expire with the activity.
"""
from __future__ import annotations

from .timeout_settings import get_timeout_seconds

import base64
import io
import struct
import threading
import time
from collections import deque
from PIL import Image, ImageChops, ImageDraw, ImageStat


def visual_signature(jpeg: bytes) -> Image.Image:
    with Image.open(io.BytesIO(jpeg)) as image:
        return image.convert("RGB").resize((32, 18))


def select_frames(frames: list, count: int, threshold: float) -> list:
    if len(frames) <= 2:
        return frames
    # First/last anchor the interval. Temporal bins distribute the largest
    # changes instead of allowing one explosion to consume every panel.
    selected = [frames[0]]
    duration = max(1, frames[-1][0] - frames[0][0])
    changes = []
    for previous, current in zip(frames, frames[1:]):
        score = sum(ImageStat.Stat(ImageChops.difference(previous[2], current[2])).mean) / 3
        changes.append((current, score))
    for slot in range(count - 2):
        low = frames[0][0] + duration * slot / (count - 2)
        high = frames[0][0] + duration * (slot + 1) / (count - 2)
        candidates = [(frame, score) for frame, score in changes if low <= frame[0] < high and frame is not frames[-1]]
        if candidates:
            frame, score = max(candidates, key=lambda item: item[1])
            if score >= threshold:
                selected.append(frame)
    selected.append(frames[-1])
    return sorted(selected, key=lambda frame: frame[0])


def make_storyboard(frames: list, started_at: int, policy: dict) -> dict:
    selected = select_frames(frames, int(policy["storyboardFrames"]), float(policy["changeThreshold"]))
    width = int(policy["tileWidth"])
    height, label = width * 9 // 16, 26
    columns = min(2, len(selected))
    sheet = Image.new("RGB", (width * columns, (height + label) * ((len(selected) + columns - 1) // columns)), "#171a20")
    draw = ImageDraw.Draw(sheet)
    for index, (at, jpeg, _) in enumerate(selected):
        x, y = (index % columns) * width, (index // columns) * (height + label)
        with Image.open(io.BytesIO(jpeg)) as image:
            image = image.convert("RGB")
            image.thumbnail((width, height), Image.Resampling.LANCZOS)
            sheet.paste(image, (x + (width - image.width) // 2, y + label + (height - image.height) // 2))
        seconds = max(0, (at - started_at) / 1000)
        draw.text((x + 9, y + 7), f"{index + 1}  +{seconds:06.1f}s", fill="#f1f5f9")
    out = io.BytesIO()
    sheet.save(out, "JPEG", quality=82)
    return {"startedAt": started_at, "endedAt": frames[-1][0], "frameTimes": [f[0] for f in selected],
            "sampleCount": len(frames), "coverageStartedAt": frames[0][0],
            "jpeg": base64.b64encode(out.getvalue()).decode("ascii")}


def make_clip(frames: list, seconds_per_frame: float) -> dict | None:
    """Mux recent captured window frames into a playable Motion JPEG AVI."""
    limit = 768 * 1024
    # A resize or acquisition gap marks the end of the previous continuous segment.
    with Image.open(io.BytesIO(frames[-1][1])) as latest:
        width, height = latest.size
    selected, size = [], 256
    later_at = frames[-1][0]
    for at, jpeg, _ in reversed(frames):
        if later_at - at > seconds_per_frame * 3000 or frames[-1][0] - at > 10_000:
            break
        if size + len(jpeg) + 25 > limit:
            break
        with Image.open(io.BytesIO(jpeg)) as image:
            if image.size != (width, height):
                break
        selected.append((at, jpeg))
        size += len(jpeg) + 25
        later_at = at
    if len(selected) < 2:
        return None
    selected.reverse()
    microseconds = max(1, round((selected[-1][0] - selected[0][0]) * 1000 / (len(selected) - 1)))

    def chunk(tag, data):
        return tag + struct.pack("<I", len(data)) + data + b"\0" * (len(data) % 2)

    frame_size = max(len(jpeg) for _, jpeg in selected)
    avih = struct.pack("<14I", microseconds, 0, 0, 0x10, len(selected), 0, 1, frame_size, width, height, 0, 0, 0, 0)
    strh = struct.pack("<4s4sIHH8I4h", b"vids", b"MJPG", 0, 0, 0, 0, microseconds, 1_000_000, 0,
                       len(selected), frame_size, 0xFFFFFFFF, 0, 0, 0, width, height)
    strf = struct.pack("<IiiHH4sIiiII", 40, width, height, 1, 24, b"MJPG", width * height * 3, 0, 0, 0, 0)
    stream = chunk(b"LIST", b"strl" + chunk(b"strh", strh) + chunk(b"strf", strf))
    header = chunk(b"LIST", b"hdrl" + chunk(b"avih", avih) + stream)
    movi, index, offset = [], [], 4
    for _, jpeg in selected:
        item = chunk(b"00dc", jpeg)
        index.append(struct.pack("<4sIII", b"00dc", 0x10, offset, len(jpeg)))
        movi.append(item)
        offset += len(item)
    data = chunk(b"RIFF", b"AVI " + header + chunk(b"LIST", b"movi" + b"".join(movi)) + chunk(b"idx1", b"".join(index)))
    return {"startedAt": selected[0][0], "endedAt": selected[-1][0], "avi": base64.b64encode(data).decode("ascii")}


class CompanionRecorder:
    def __init__(self, capture):
        self.capture = capture
        self.lock = threading.RLock()
        self.frames = deque()
        self.audio = deque()
        self.frame_bytes = 0
        self.scope = None
        self.window = None
        self.policy = None
        self.latest = None
        self.audio_status = "starting"
        self.audio_error = ""
        self.suppressed = False
        self.stop_event = threading.Event()
        self.worker = None
        self.audio_worker = None

    def configure(self, scope, policy):
        with self.lock:
            if scope != self.scope:
                self.frames.clear(); self.audio.clear(); self.frame_bytes = 0
                self.latest = None; self.window = None
            self.scope, self.policy = scope, dict(policy)
        if (self.worker is None or not self.worker.is_alive()) and (self.audio_worker is None or not self.audio_worker.is_alive()):
            self.stop_event = threading.Event()
            self.worker = threading.Thread(target=self._record, args=(self.stop_event,), daemon=True, name="companion-frames")
            self.worker.start()
            from .companion_system_audio import record_system_audio
            self.audio_worker = threading.Thread(target=record_system_audio, args=(self, self.stop_event), daemon=True,
                                                 name="companion-playback-audio")
            self.audio_worker.start()

    def _record(self, stopped):
        while not stopped.is_set():
            began = time.monotonic()
            try:
                with self.lock:
                    scope = self.scope
                observation = self.capture(0)
                if observation:
                    self.append_frame(scope, observation)
            except Exception:
                # A lost screen remains lost; the Manager liveness lease pauses it.
                pass
            stopped.wait(max(0.01, self.policy["captureSeconds"] - (time.monotonic() - began)))

    def append_frame(self, scope, observation):
        jpeg = base64.b64decode(observation["jpeg"])
        signature = visual_signature(jpeg)
        window = observation.get("window") or {}
        key = (window.get("id"), window.get("title"))
        at = observation["capturedAt"]
        with self.lock:
            if scope != self.scope or self.stop_event.is_set():
                return
            if self.window is not None and self.window != key:
                self.frames.clear(); self.audio.clear(); self.frame_bytes = 0
            self.window = key
            self.latest = dict(observation)
            self.frames.append((at, jpeg, signature)); self.frame_bytes += len(jpeg)
            cutoff = at - self.policy["historySeconds"] * 1000
            while len(self.frames) > 1 and (self.frames[0][0] < cutoff or self.frame_bytes > self.policy["maxFrameBytes"]):
                self.frame_bytes -= len(self.frames.popleft()[1])

    def append_audio(self, scope, window, started, ended, pcm):
        with self.lock:
            if scope != self.scope or window != self.window or self.stop_event.is_set():
                return
            self.audio_status, self.audio_error = "ready", ""
            self.audio.append((started, ended, b"\0" * len(pcm) if self.suppressed else pcm, self.suppressed))
            cutoff = ended - self.policy["historySeconds"] * 1000
            while self.audio and self.audio[0][1] < cutoff:
                self.audio.popleft()

    def snapshot(self, session, sequence):
        with self.lock:
            if not self.latest:
                return None
            observation = dict(self.latest)
            through = observation["capturedAt"]
            boundary = int(session.get("observationStartedAt") or session.get("startedAt") or through)
            # A first frame for a new foreground window cannot contain its predecessor.
            if session.get("window") and session["window"] != observation.get("window"):
                boundary = through
            frames = [f for f in self.frames if boundary <= f[0] <= through]
            if not frames:
                frames = [self.frames[-1]]
            start = max(boundary, int(session.get("audioThrough") or boundary), through - int(self.policy["audioUploadSeconds"] * 1000))
            parts = list(self.audio)
            status, error = self.audio_status, self.audio_error
            policy = self.policy
        observation["sequence"] = sequence
        observation["interval"] = make_storyboard(frames, boundary, policy)
        clip = make_clip(frames, policy["captureSeconds"])
        if clip:
            observation["video"] = clip
        if through > start:
            pcm = bytearray((through - start) * 32)  # PCM16 mono, 16 kHz
            covered, suppressed = 0, 0
            for began, ended, data, muted in parts:
                left, right = max(start, began), min(through, ended)
                if right <= left:
                    continue
                offset = (left - start) * 32
                source = max(0, (left - began) * 32)
                count = min((right - left) * 32, len(data) - source, len(pcm) - offset)
                if count > 0:
                    pcm[offset:offset + count] = data[source:source + count]
                    covered += count // 32
                    if muted:
                        suppressed += count // 32
            observation["audio"] = {"startedAt": start, "endedAt": through, "pcm": base64.b64encode(pcm).decode("ascii"),
                                    "status": status, "missingMs": max(0, through - start - covered),
                                    "suppressedMs": suppressed, **({"error": error} if error else {})}
        return observation

    def stop(self):
        self.stop_event.set()
        # Release the native streams before a subsequent configure can start a new owner.
        for worker in (self.worker, self.audio_worker):
            if worker and worker is not threading.current_thread():
                worker.join(timeout=get_timeout_seconds("desktop.observation.stop", 0.1))
        with self.lock:
            self.scope = None; self.latest = None; self.window = None
            self.frames.clear(); self.audio.clear(); self.frame_bytes = 0
