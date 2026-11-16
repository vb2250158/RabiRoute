"""Window-scoped microphone capture; RabiSpeech owns transcription."""
from __future__ import annotations

import math
import threading
from array import array
from collections import deque
from PySide6.QtCore import QObject, Signal
from .manager_client import ManagerClient
from .qt_async import start_qt_task


class ScreenshotVoiceInput(QObject):
    text_ready = Signal(int, str)
    failed = Signal(str)
    state_changed = Signal(int, str)

    def __init__(self, manager: ManagerClient, parent: QObject) -> None:
        super().__init__(parent)
        self._manager = manager
        self._stop = threading.Event()
        self._task = None
        self._revision = 0

    def start(self, settings: dict) -> None:
        if self._task is not None:
            raise ValueError("上一段语音仍在停止，请稍后重试。")
        self._stop = threading.Event()
        stopped = self._stop
        self._revision += 1
        revision = self._revision
        model, config = settings["model"], settings["config"]

        def record() -> None:
            import pyaudiowpatch as audio
            with audio.PyAudio() as owner:
                requested = config.get("device")
                if isinstance(requested, int):
                    device = owner.get_device_info_by_index(requested)
                elif isinstance(requested, str) and requested:
                    device = next((owner.get_device_info_by_index(index) for index in range(owner.get_device_count())
                                   if owner.get_device_info_by_index(index).get("name") == requested
                                   and owner.get_device_info_by_index(index).get("maxInputChannels", 0) > 0), None)
                    if device is None:
                        raise ValueError("配置的麦克风不可用，请在语音设置中重新选择。")
                else:
                    device = owner.get_default_input_device_info()
                if device.get("isLoopbackDevice"):
                    raise ValueError("请选择麦克风输入设备。")
                rate = int(device["defaultSampleRate"])
                chunk_ms = max(20, min(200, int(config["chunkMs"])))
                chunk_size = max(1, rate * chunk_ms // 1000)
                silence_chunks = max(1, math.ceil(float(config["silenceMs"]) / chunk_ms))
                maximum_chunks = max(1, math.ceil(min(120000, float(config["maxUtteranceMs"])) / chunk_ms))
                minimum_chunks = max(1, math.ceil(float(config["minUtteranceMs"]) / chunk_ms))
                threshold = float(config["recordThreshold"]) * 32768
                chunks: list[bytes] = []
                preroll: deque[bytes] = deque(maxlen=max(1, math.ceil(min(1000, float(config["preRollMs"])) / chunk_ms)))
                silence = 0
                with owner.open(format=audio.paInt16, channels=1, rate=rate, input=True,
                                input_device_index=device["index"], frames_per_buffer=chunk_size) as stream:
                    self.state_changed.emit(revision, "正在听写，停顿后转成文字")
                    while not stopped.is_set():
                        block = stream.read(chunk_size, exception_on_overflow=False)
                        samples = array("h", block)
                        rms = math.sqrt(sum(value * value for value in samples) / max(1, len(samples)))
                        if rms >= threshold:
                            if not chunks:
                                chunks.extend(preroll)
                            silence = 0
                            chunks.append(block)
                        elif chunks:
                            chunks.append(block)
                            silence += 1
                        preroll.append(block)
                        if chunks and (silence >= silence_chunks or len(chunks) >= maximum_chunks):
                            speech_chunks = len(chunks) - silence
                            pcm = b"".join(chunks)
                            chunks.clear()
                            preroll.clear()
                            silence = 0
                            if speech_chunks < minimum_chunks:
                                continue
                            # Pause capture during the request, so no unbounded audio queue can accumulate.
                            stream.stop_stream()
                            if stopped.is_set():
                                break
                            self.state_changed.emit(revision, "正在转录…")
                            text = self._manager.transcribe_screenshot_audio(pcm, model, rate)
                            if stopped.is_set():
                                break
                            if text:
                                self.text_ready.emit(revision, text)
                            self.state_changed.emit(revision, "正在听写，停顿后转成文字")
                            stream.start_stream()

        def completed(task, result) -> None:
            if self._task is task:
                self._task = None
            if revision == self._revision and isinstance(result, Exception) and not stopped.is_set():
                self.failed.emit(str(result))

        self._task = start_qt_task(record, completed)

    def stop(self) -> None:
        self._revision += 1
        self._stop.set()

    def is_current(self, revision: int) -> bool:
        return revision == self._revision and not self._stop.is_set()
