"""Exercise real worker IPC with a simulated camera, never physical hardware."""
import base64
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from PIL import Image, ImageStat

spec = importlib.util.spec_from_file_location("camera_tests", Path(__file__).parents[1] / "rabispeech" / "all_day_camera.py")
camera = importlib.util.module_from_spec(spec)
spec.loader.exec_module(camera)


class CameraWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rabi-camera-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.events = self.root / "device.jsonl"
        self.session = "11111111-1111-1111-1111-111111111111"
        self.owner = camera.CameraOwner()
        self.addCleanup(self.owner.stop)
        self._fake_camera()
        original = subprocess.Popen

        def launch(args, **kwargs):
            args = list(args)
            args[5] = json.dumps([str(self.root), *json.loads(args[5])])
            return original(args, **kwargs)

        self.patcher = patch.object(camera.subprocess, "Popen", side_effect=launch)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def _fake_camera(self, hang=False):
        (self.root / "cv2.py").write_text('''
import time, os, numpy as np
CAP_DSHOW=700
CAP_ANY=0
COLOR_BGR2RGB=4
def event(kind, **fields):
    import json
    with open(EVENTS, 'a', encoding='utf-8') as stream:
        stream.write(json.dumps(dict(kind=kind,pid=os.getpid(),**fields))+'\\n')
class VideoCapture:
    def __init__(self,index,backend):
        self.frames=0
        event('open',index=index)
    def isOpened(self): return True
    def read(self):
        time.sleep(30 if HANG else .02)
        self.frames+=1
        event('read',frame=self.frames)
        return True,np.full((8,8,3),min(10+self.frames,220),dtype=np.uint8)
    def release(self): event('release')
def cvtColor(frame, mode): return frame
'''.replace('EVENTS',repr(str(self.events))).replace('HANG',repr(hang)), encoding="utf-8")

    def records(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()]

    def test_warmup_then_same_camera_and_fresh_frames_across_snapshots(self):
        started = time.monotonic()
        first = self.owner.snapshot(self.session, 0)
        self.assertGreaterEqual(time.monotonic()-started, 2)
        before = self.records()
        self.assertGreaterEqual(len([x for x in before if x['kind']=='read']),15)
        pid = self.owner._process.pid
        time.sleep(.1)
        self.owner.renew(self.session)
        second = self.owner.snapshot(self.session, 0)
        self.assertEqual(self.owner._process.pid, pid)
        after = self.records()
        self.assertEqual(len([x for x in after if x['kind']=='open']),1)
        self.assertGreater(len(after),len(before))
        self.assertGreater(ImageStat.Stat(Image.open(io.BytesIO(base64.b64decode(first['jpeg'])))).mean[0],25)
        self.assertIn('jpeg',second)
        self.owner.stop('wrong-session')
        self.assertIsNotNone(self.owner._process)
        self.owner.stop(self.session)
        self.assertIsNone(self.owner._process)
        self.assertEqual(len([x for x in self.records() if x['kind']=='release']),1)

    def test_index_change_releases_previous_device_and_warms_new_one(self):
        self.owner.snapshot(self.session, 0)
        with self.assertRaisesRegex(RuntimeError,'另一项'):
            self.owner.snapshot('another-session',1)
        self.owner.snapshot(self.session, 1)
        self.owner.stop(self.session)
        rows = self.records()
        self.assertEqual([x['index'] for x in rows if x['kind']=='open'],[0,1])
        self.assertEqual(len([x for x in rows if x['kind']=='release']),2)

    def test_blocked_driver_times_out_and_leaves_no_worker(self):
        self._fake_camera(hang=True)
        self.owner._snapshot_timeout=.25
        started=time.monotonic()
        with self.assertRaisesRegex(RuntimeError,'timed out'):
            self.owner.snapshot(self.session,0)
        self.assertLess(time.monotonic()-started,5)
        self.assertIsNone(self.owner._process)

    def test_parent_pipe_disconnect_releases_camera(self):
        self.owner.snapshot(self.session,0)
        process=self.owner._process
        process.stdin.close()
        process.wait(timeout=5)
        self.assertEqual(process.returncode,0)
        self.assertEqual(len([x for x in self.records() if x['kind']=='release']),1)
        self.owner._process=None

    def test_expired_lease_exits_without_opening_a_second_camera(self):
        original=subprocess.Popen
        def short_lease(args,**kwargs):
            args=list(args)
            args[4]="import json,runpy,sys; sys.path[:0]=json.loads(sys.argv[1]); m=runpy.run_path(sys.argv[2]); m['camera_worker'].__globals__['CAMERA_LEASE_SECONDS']=1; m['camera_worker'](int(sys.argv[3]),warmup_seconds=0,warmup_frames=1)"
            args[5]=json.dumps([str(self.root),*json.loads(args[5])])
            return original(args,**kwargs)
        with patch.object(camera.subprocess,'Popen',side_effect=short_lease):
            self.owner.snapshot(self.session,0)
            self.owner._process.wait(timeout=5)
            self.assertEqual(len([x for x in self.records() if x['kind']=='open']),1)


if __name__ == "__main__":
    unittest.main()
