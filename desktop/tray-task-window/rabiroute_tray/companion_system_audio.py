"""WASAPI default-output loopback. Never opens a microphone input device."""
from __future__ import annotations

import audioop
import time
from array import array


def record_system_audio(recorder, stopped):
    while not stopped.is_set():
        try:
            import pyaudiowpatch as audio
            with audio.PyAudio() as owner:
                device = owner.get_default_wasapi_loopback()
                if not device.get("isLoopbackDevice"):
                    raise RuntimeError("Default output has no WASAPI loopback")
                rate, channels = int(device["defaultSampleRate"]), int(device["maxInputChannels"])
                resample_state = None
                def receive(data, count, timing, flags):
                    nonlocal resample_state
                    if stopped.is_set():
                        return (None, audio.paComplete)
                    with recorder.lock:
                        scope, window = recorder.scope, recorder.window
                    if channels == 2:
                        mono = audioop.tomono(data, 2, 0.5, 0.5)
                    elif channels == 1:
                        mono = data
                    else:
                        values = array("h", data)
                        mono = array("h", (int(sum(values[i:i + channels]) / channels)
                                           for i in range(0, len(values), channels))).tobytes()
                    pcm, resample_state = audioop.ratecv(mono, 2, 1, rate, 16000, resample_state)
                    ended = int(time.time() * 1000)
                    recorder.append_audio(scope, window, ended - len(pcm) // 32, ended, pcm)
                    return (None, audio.paContinue)
                with owner.open(format=audio.paInt16, channels=channels, rate=rate, input=True,
                                input_device_index=device["index"], frames_per_buffer=1024,
                                stream_callback=receive) as stream:
                    while not stopped.wait(2):
                        if not stream.is_active():
                            raise RuntimeError("System playback capture stopped")
                        if owner.get_default_wasapi_loopback()["index"] != device["index"]:
                            break  # reopen the current default output after a device change
        except Exception as error:
            with recorder.lock:
                recorder.audio_status = "unavailable"
                recorder.audio_error = str(error)[:200]
            stopped.wait(5)
