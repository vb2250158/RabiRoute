import base64
import io
import json
import pathlib
import unittest
import sys
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
from rabiroute_tray.companion_observation_buffer import CompanionRecorder, make_storyboard, select_frames, visual_signature

POLICY = json.loads((pathlib.Path(__file__).parents[3] / "packages/rabi-companion/observation.json").read_text())

def frame(at, color):
    out = io.BytesIO()
    Image.new("RGB", (960, 540), color).save(out, "JPEG")
    jpeg = out.getvalue()
    return (at, jpeg, visual_signature(jpeg))

class ObservationBufferTest(unittest.TestCase):
    def recorder(self):
        recorder = CompanionRecorder(lambda _: None)
        recorder.policy = POLICY
        recorder.scope = ("session", 1)
        return recorder

    def add(self, recorder, at, color, title="Example"):
        row = frame(at, color)
        recorder.append_frame(recorder.scope, {"capturedAt": at, "source": "window",
            "jpeg": base64.b64encode(row[1]).decode(), "window": {"id": "game", "title": title, "processName": "example.exe"}})

    def test_largest_changes_are_distributed_and_panels_remain_chronological(self):
        frames = [frame(i * 500, color) for i, color in enumerate(["black", "black", "white", "white", "red", "red", "blue", "blue", "green", "green", "white", "black"])]
        selected = select_frames(frames, 6, 7)
        self.assertLessEqual(len(selected), 6)
        self.assertEqual(selected[0][0], 0)
        self.assertEqual(selected[-1][0], 5500)
        self.assertEqual([f[0] for f in selected], sorted(f[0] for f in selected))
        self.assertIn(1000, [f[0] for f in selected])
        result = make_storyboard(frames, 0, POLICY)
        image = Image.open(io.BytesIO(base64.b64decode(result["jpeg"])))
        self.assertEqual(image.width, 1280)
        self.assertLessEqual(image.height, 1158)

    def test_static_scene_keeps_only_start_and_end(self):
        frames = [frame(i * 500, "red") for i in range(30)]
        self.assertEqual([f[0] for f in select_frames(frames, 6, 7)], [0, 14500])

    def test_boundary_audio_clip_and_pet_voice_exclusion(self):
        recorder = self.recorder()
        self.add(recorder, 1000, "red"); self.add(recorder, 2000, "blue"); self.add(recorder, 3000, "green")
        pcm = b"\x10\x02" * 16000
        recorder.append_audio(recorder.scope, recorder.window, 1000, 2000, pcm)
        recorder.suppressed = True
        recorder.append_audio(recorder.scope, recorder.window, 2000, 3000, pcm)
        result = recorder.snapshot({"startedAt": 1000, "observationStartedAt": 1000, "audioThrough": 1500}, 4)
        self.assertEqual(result["audio"]["startedAt"], 1500)
        data = base64.b64decode(result["audio"]["pcm"])
        self.assertEqual(len(data), 1500 * 32)
        self.assertEqual(data[:2], b"\x10\x02")
        self.assertEqual(data[500 * 32:], b"\0" * 32000)
        self.assertEqual(result["audio"]["suppressedMs"], 1000)

    def test_page_switch_and_stop_clear_old_frames_and_pcm(self):
        recorder = self.recorder()
        self.add(recorder, 1000, "red")
        recorder.append_audio(recorder.scope, recorder.window, 1000, 2000, b"\x10\x02" * 16000)
        self.add(recorder, 3000, "blue", "Other page")
        self.assertEqual(len(recorder.frames), 1)
        self.assertEqual(len(recorder.audio), 0)
        recorder.stop()
        self.assertEqual(len(recorder.frames), 0)
        self.assertEqual(len(recorder.audio), 0)
        self.assertIsNone(recorder.latest)

    def test_recording_buffer_expires_frames_and_marks_partial_coverage(self):
        recorder = self.recorder()
        recorder.policy = {**POLICY, "historySeconds": 2}
        for at in range(1000, 7001, 1000):
            self.add(recorder, at, "red")
        result = recorder.snapshot({"startedAt": 1000}, 7)
        self.assertEqual(result["interval"]["startedAt"], 1000)
        self.assertEqual(result["interval"]["coverageStartedAt"], 5000)

if __name__ == "__main__":
    unittest.main()
