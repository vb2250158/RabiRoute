"""Offline transcription worker. Audio arrives on stdin and stays in memory."""
import base64
import io
import json
import sys
from faster_whisper import WhisperModel

try:
    request = json.loads(sys.stdin.read())
    audio = base64.b64decode(request["audio"], validate=True)
    model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8",
                         cpu_threads=4, local_files_only=True)
    segments, _ = model.transcribe(
        io.BytesIO(audio), language="zh", beam_size=5,
        condition_on_previous_text=False, vad_filter=True,
        vad_parameters={"min_speech_duration_ms": 180, "min_silence_duration_ms": 300},
    )
    text = "".join(part.text for part in segments
                   if part.compression_ratio <= 2.4
                   and not (part.no_speech_prob > 0.6 and part.avg_logprob < -0.7))
    print(json.dumps({"text": text}, ensure_ascii=False))
except Exception:
    print(json.dumps({"error": "LOCAL_ASR_FAILED"}))
    sys.exit(1)
