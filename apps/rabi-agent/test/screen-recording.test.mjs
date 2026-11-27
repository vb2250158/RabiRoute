
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { ComputerService } from "../lib/computer-service.mjs";
import { RecordingStorage } from "../lib/screen-recording-storage.mjs";
import { ScreenRecording } from "../lib/screen-recording.mjs";

const exec = promisify(execFile);

async function waitFor(read, accept) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await delay(40);
  }
  assert.fail("Recording did not reach the expected state.");
}

test("scheduled recording pauses, resumes, completes, and serves its original result after restart", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-recording-test-"));
  const windows = [{ windowId: "a1", pid: 42 }, { windowId: "b2", pid: 43 }];
  let now = Date.now();
  let starts = 0;
  const notices = [];
  const options = { root, now: () => now, listWindows: async () => ({ windows }), authorize: () => {},
    present: async payload => { notices.push(payload); return { visible: payload.state !== "completed" }; },
    openCapture: (_exe, _target, file) => {
      starts++;
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      return { done, async stop() { await fs.writeFile(file, "fixture"); finish({}); return done; } };
    }
  };
  const service = new ScreenRecording(options);
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const recordingId = randomUUID();
  const startAt = now + 300, pauseAt = startAt + 500, resumeAt = pauseAt + 500, endAt = resumeAt + 500;
  const status = () => service.execute({ action: "recording.status", recordingId });
  assert.equal((await service.execute({ action: "recording.start", recordingId, startAt, endAt, windows,
    pauses: [{ startAt: pauseAt, endAt: resumeAt }] }, undefined, "Agent Test")).state, "scheduled");
  assert.equal(starts, 0);
  now = startAt;
  await waitFor(status, result => result.state === "recording");
  now = pauseAt;
  assert.equal((await waitFor(status, result => result.state === "paused")).files.length, 2);
  now = resumeAt;
  await waitFor(status, result => result.state === "recording");
  now = endAt;
  const finished = await waitFor(status, result => result.state === "completed");
  assert.equal(finished.files.length, 4);
  assert.equal(starts, 4);
  assert.ok(notices.some(notice => notice.state === "paused" && notice.sourceLabel === "Agent Test"));
  assert.equal(notices.at(-1).state, "completed");
  const restarted = new ScreenRecording(options);
  assert.deepEqual(await restarted.execute({ action: "recording.status" }), finished);
  assert.deepEqual(await restarted.execute({ action: "recording.status", recordingId }), finished);
  assert.deepEqual(await restarted.execute({ action: "recording.start", recordingId, endAt }), finished);
  assert.equal((await restarted.execute({ action: "recording.save", recordingId })).permanent, true);
  assert.equal((await restarted.execute({ action: "recording.status", recordingId })).permanent, true);
  const storage = await restarted.execute({ action: "recording.cache.status" });
  assert.equal(storage.cacheBytes, 0);
  assert.equal(storage.permanentBytes, 4 * Buffer.byteLength("fixture"));
  await assert.rejects(restarted.execute({ action: "recording.start", recordingId: randomUUID(),
    endAt: now + 61 * 60_000 }), /maximum duration/);
  await restarted.close();
});

test("cache expiry starts at completion and permanently saved or protected clips survive", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-recording-expiry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const finishedAt = Date.now();
  let now = finishedAt + 86_399_999;
  const policy = { cacheMaxGiB: 8, retentionDays: 1, maxDurationMinutes: 60 };
  const storage = new RecordingStorage(root, () => policy, () => now);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, recordingId] of ids.entries()) {
    const folder = path.join(root, recordingId);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "segment-1-track-1.mkv"), "test video");
    await fs.writeFile(path.join(folder, "unrelated.txt"), "keep");
    await storage.write({ recordingId, finishedAt, state: "completed", files: [], permanent: index === 1 });
  }
  assert.equal((await storage.inventory([], true)).cacheBytes, 20);
  now++;
  const result = await storage.inventory([ids[2]], true);
  assert.equal(result.cacheBytes, 10);
  assert.equal(result.permanentBytes, 10);
  assert.equal((await storage.read(ids[0])).state, "expired");
  assert.equal(await fs.readFile(path.join(root, ids[0], "unrelated.txt"), "utf8"), "keep");
  assert.equal((await storage.read(ids[1])).state, "completed");
  assert.equal((await storage.inventory([], true)).cacheBytes, 0);
  assert.equal((await storage.read(ids[2])).state, "expired");
});

test("records an owned Windows test window into an RGB FFV1 video", {
  skip: process.platform !== "win32" || !process.env.RABI_TEST_SCREEN_RECORDING, timeout: 30000
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-window-video-test-"));
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    "$form = New-Object System.Windows.Forms.Form",
    "$form.Text = 'Rabi Recording Test Fixture'",
    "$form.ShowInTaskbar = $false",
    "$form.ClientSize = New-Object System.Drawing.Size(320,200)",
    "$form.BackColor = [System.Drawing.Color]::CornflowerBlue",
    "$form.Add_Shown({ [Console]::WriteLine(('READY:{0:x}' -f $form.Handle.ToInt64())); [Console]::Out.Flush() })",
    "[System.Windows.Forms.Application]::Run($form)"
  ].join("\n");
  const helper = spawn(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  helper.stdout.setEncoding("utf8").on("data", text => { output += text; });
  const helperDone = new Promise(resolve => helper.once("close", resolve));
  let service;
  t.after(async () => { await service?.stop(); helper.kill(); await helperDone; await fs.rm(root, { recursive: true, force: true }); });
  const match = await waitFor(() => output.match(/READY:([0-9a-f]+)/), Boolean);
  const window = { windowId: match[1], pid: helper.pid };
  service = new ComputerService({ uploadHistoryRoot: path.join(root, "uploads") });
  const frame = await service.execute({ ...window, action: "screen.capture.background" });
  const recordingId = randomUUID();
  await service.execute({ action: "recording.start", recordingId, endAt: Date.now() + 4000, windows: [window] });
  const receipt = await waitFor(() => service.execute({ action: "recording.status", recordingId }), result => ["completed", "failed"].includes(result.state));
  assert.equal(receipt.state, "completed", receipt.error);
  assert.equal(receipt.files.length, 1);
  const { stdout } = await exec("ffprobe.exe", ["-v", "error", "-show_streams", "-of", "json", receipt.files[0].path], { windowsHide: true });
  const stream = JSON.parse(stdout).streams[0];
  assert.equal(stream.codec_name, "ffv1");
  assert.equal(stream.pix_fmt, "bgr0");
  assert.equal(stream.width, frame.width);
  assert.equal(stream.height, frame.height);
  const clipId = randomUUID();
  const startAt = receipt.files[0].startedAt + 700;
  const endAt = startAt + 1000;
  const requested = await service.execute({ action: "recording.clip", recordingId: clipId, sourceRecordingId: recordingId, startAt, endAt, permanent: true });
  assert.equal(requested.state, "clipping");
  const clip = await waitFor(() => service.execute({ action: "recording.status", recordingId: clipId }), result => ["completed", "failed"].includes(result.state));
  assert.equal(clip.state, "completed", clip.error);
  assert.equal(clip.permanent, true);
  assert.deepEqual([clip.files[0].startedAt, clip.files[0].endedAt], [startAt, endAt]);
  const clipProbe = await exec("ffprobe.exe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", clip.files[0].path], { windowsHide: true });
  const seconds = Number(JSON.parse(clipProbe.stdout).format.duration);
  assert.ok(seconds > 0.7 && seconds < 1.2, seconds);
});
