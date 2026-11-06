import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { XiaomiHomeArtifactStore } from "../../plugins/io.rabiroute.manager.xiaomi-home/src/integrations/xiaomiHome/artifactStore.js";
import { XiaomiHomeClipCaptureWorker } from "../../plugins/io.rabiroute.manager.xiaomi-home/src/integrations/xiaomiHome/clipCapture.js";

const ffmpegPath = process.env.XIAOMI_TEST_FFMPEG;
const ffprobePath = process.env.XIAOMI_TEST_FFPROBE;

function run(executable: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`media fixture command failed: ${code}`)));
  });
}

for (const restricted of [false, true]) {
  test(`captures redirected HTTP HLS with real ffmpeg and ${restricted ? "configured" : "unrestricted"} hosts`, {
    skip: !ffmpegPath || !ffprobePath,
    timeout: 30000
  }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomi-clip-e2e-"));
    const fixtureDir = path.join(root, "fixture");
    fs.mkdirSync(fixtureDir, { recursive: true });
    try {
      await run(ffmpegPath!, [
        "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10",
        "-t", "2.4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-f", "hls", "-hls_time", "1", "-hls_list_size", "0",
        "-hls_segment_filename", "segment-%03d.ts", "source.m3u8"
      ], fixtureDir);
      const fakeFetch: typeof fetch = async input => {
        const url = new URL(String(input));
        if (url.hostname === "media.example") return new Response(null, { status: 302, headers: { location: "http://cdn.example/event.m3u8" } });
        const fileName = path.basename(url.pathname);
        const filePath = fileName === "event.m3u8" ? path.join(fixtureDir, "source.m3u8") : path.join(fixtureDir, fileName);
        if (!fs.existsSync(filePath)) return new Response("missing", { status: 404 });
        return new Response(fs.readFileSync(filePath), { status: 200 });
      };
      const artifacts = new XiaomiHomeArtifactStore(path.join(root, "runtime"));
      const roleDirectory = path.join(root, "roles", "CameraOwner");
      fs.mkdirSync(roleDirectory, { recursive: true });
      const worker = new XiaomiHomeClipCaptureWorker({
        cameraClipCaptureEnabled: true,
        cameraClipAllowedHosts: restricted ? ["media.example", "cdn.example"] : [],
        ffmpegPath,
        ffprobePath
      }, artifacts, fakeFetch, () => roleDirectory, "CameraOwner");
      const occurredAt = "2026-08-29T10:00:00.000Z";
      const artifact = await worker.capture({
        sourceEventId: "clip-e2e-1",
        cameraId: "camera-1",
        resourceId: "home:ha:camera.front_door",
        resourceName: "门口摄像头",
        occurredAt,
        eventType: "PeopleMotion",
        playlistUrl: "https://media.example/event.m3u8"
      });
      assert.equal(artifact.mediaKind, "video/mp4");
      assert.ok(artifact.byteLength > 0);
      assert.ok((artifact.durationMs ?? 0) >= 1500);
      const expected = path.join(roleDirectory, "camera", "camera-1", "2026-08-29", "clip-e2e-1.mp4");
      assert.equal(fs.existsSync(expected), true);
      assert.equal(artifacts.contentDescriptor(artifact.artifactId)?.localPath, expected);
      const zeroPath = path.join(roleDirectory, "camera", "camera-1", "2026-08-29", "clip-e2e-zero-inode.mp4");
      const zeroInterruptedPath = path.join(roleDirectory, "camera", "camera-1", "2026-08-29", "clip-e2e-zero-interrupted.mp4");
      const isZeroPath = (value: unknown) => String(value) === zeroPath || String(value) === zeroInterruptedPath;
      const originalOpen = fs.promises.open.bind(fs.promises);
      const originalLstat = fs.promises.lstat.bind(fs.promises);
      t.mock.method(fs.promises, "open", (async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await originalOpen(...args);
        if (isZeroPath(args[0])) {
          const originalStat = handle.stat.bind(handle);
          handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
            const result = await originalStat(...statArgs);
            Object.defineProperty(result, "ino", { value: typeof result.ino === "bigint" ? 0n : 0 });
            return result;
          }) as typeof handle.stat;
        }
        return handle;
      }) as typeof fs.promises.open);
      t.mock.method(fs.promises, "lstat", (async (...args: Parameters<typeof fs.promises.lstat>) => {
        const result = await originalLstat(...args);
        if (isZeroPath(args[0])) Object.defineProperty(result, "ino", { value: typeof result.ino === "bigint" ? 0n : 0 });
        return result;
      }) as typeof fs.promises.lstat);
      try {
        const zero = await worker.capture({ sourceEventId: "clip-e2e-zero-inode", cameraId: "camera-1", resourceId: "home:ha:camera.front_door", resourceName: "门口摄像头", occurredAt, eventType: "PeopleMotion", playlistUrl: "https://media.example/event.m3u8" });
        assert.ok(zero.byteLength > 0);
        assert.equal(artifacts.contentDescriptor(zero.artifactId)?.localPath, zeroPath);
        assert.ok(fs.statSync(zeroPath).size > 0);
        const zeroInterrupted = { sourceEventId: "clip-e2e-zero-interrupted", cameraId: "camera-1", resourceId: "home:ha:camera.front_door", resourceName: "门口摄像头", occurredAt, eventType: "PeopleMotion", playlistUrl: "https://media.example/event.m3u8" };
        const originalRegister = artifacts.register.bind(artifacts);
        artifacts.register = () => { throw new Error("simulated registration interruption"); };
        await assert.rejects(worker.capture(zeroInterrupted), /simulated registration interruption/);
        artifacts.register = originalRegister;
        const saved = fs.readFileSync(zeroInterruptedPath);
        assert.ok(saved.length > 0);
        await assert.rejects(worker.capture(zeroInterrupted), /journal does not match/);
        assert.deepEqual(fs.readFileSync(zeroInterruptedPath), saved);
      } finally { t.mock.restoreAll(); }
      const replay = { sourceEventId: "clip-e2e-recovery", cameraId: "camera-1", resourceId: "home:ha:camera.front_door", resourceName: "门口摄像头", occurredAt, eventType: "PeopleMotion", playlistUrl: "https://media.example/event.m3u8" };
      const register = artifacts.register.bind(artifacts);
      let failOnce = true;
      artifacts.register = input => { if (failOnce) { failOnce = false; throw new Error("simulated registration interruption"); } return register(input); };
      await assert.rejects(worker.capture(replay), /simulated registration interruption/);
      const existing = path.join(roleDirectory, "camera", "camera-1", "2026-08-29", "clip-e2e-recovery.mp4");
      const priorBytes = fs.readFileSync(existing);
      const reopened = new XiaomiHomeArtifactStore(path.join(root, "runtime"));
      const restartedWorker = new XiaomiHomeClipCaptureWorker({ cameraClipCaptureEnabled: true,
        cameraClipAllowedHosts: restricted ? ["media.example", "cdn.example"] : [], ffmpegPath, ffprobePath
      }, reopened, fakeFetch, () => roleDirectory, "CameraOwner");
      const recovered = await restartedWorker.capture(replay);
      assert.deepEqual(fs.readFileSync(existing), priorBytes);
      assert.equal(reopened.contentDescriptor(recovered.artifactId)?.localPath, existing);
      const foreign = { ...replay, sourceEventId: "clip-e2e-foreign" };
      const foreignPath = path.join(roleDirectory, "camera", "camera-1", "2026-08-29", "clip-e2e-foreign.mp4");
      fs.writeFileSync(foreignPath, priorBytes);
      await assert.rejects(restartedWorker.capture(foreign));
      assert.deepEqual(fs.readFileSync(foreignPath), priorBytes);
      const replaced = { ...replay, sourceEventId: "clip-e2e-replaced" };
      failOnce = true;
      await assert.rejects(worker.capture(replaced), /simulated registration interruption/);
      const replacedPath = path.join(roleDirectory, "camera", "camera-1", "2026-08-29", "clip-e2e-replaced.mp4");
      const replacedBytes = fs.readFileSync(replacedPath);
      fs.renameSync(replacedPath, `${replacedPath}.original`);
      fs.writeFileSync(replacedPath, replacedBytes);
      await assert.rejects(restartedWorker.capture(replaced), /not the journaled complete file/);
      assert.deepEqual(fs.readFileSync(replacedPath), replacedBytes);
      const damaged = { ...replay, sourceEventId: "clip-e2e-damaged" };
      failOnce = true;
      await assert.rejects(worker.capture(damaged), /simulated registration interruption/);
      const damagedPath = path.join(roleDirectory, "camera", "camera-1", "2026-08-29", "clip-e2e-damaged.mp4");
      const damagedBytes = fs.readFileSync(damagedPath);
      damagedBytes[damagedBytes.length - 1] ^= 1;
      fs.writeFileSync(damagedPath, damagedBytes);
      await assert.rejects(restartedWorker.capture(damaged), /content does not match/);
      assert.deepEqual(fs.readFileSync(damagedPath), damagedBytes);
      const partial = { ...replay, sourceEventId: "clip-e2e-partial" };
      failOnce = true;
      await assert.rejects(worker.capture(partial), /simulated registration interruption/);
      const partialPath = path.join(roleDirectory, "camera", "camera-1", "2026-08-29", "clip-e2e-partial.mp4");
      fs.truncateSync(partialPath, 16);
      const partialBytes = fs.readFileSync(partialPath);
      await assert.rejects(restartedWorker.capture(partial), /not the journaled complete file/);
      assert.deepEqual(fs.readFileSync(partialPath), partialBytes);
      const conflict = { ...replay, sourceEventId: "clip-e2e-conflict" };
      failOnce = true;
      await assert.rejects(worker.capture(conflict), /simulated registration interruption/);
      const conflictPath = path.join(roleDirectory, "camera", "camera-1", "2026-08-29", "clip-e2e-conflict.mp4");
      const conflictBytes = fs.readFileSync(conflictPath);
      await assert.rejects(restartedWorker.capture({ ...conflict, resourceId: "home:ha:camera.other" }), /journal does not match/);
      assert.deepEqual(fs.readFileSync(conflictPath), conflictBytes);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

}
