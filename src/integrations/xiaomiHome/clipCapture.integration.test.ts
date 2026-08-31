import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { XiaomiHomeArtifactStore } from "./artifactStore.js";
import { XiaomiHomeClipCaptureWorker } from "./clipCapture.js";

const ffmpegPath = process.env.XIAOMI_TEST_FFMPEG;
const ffprobePath = process.env.XIAOMI_TEST_FFPROBE;

function run(executable: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`media fixture command failed: ${code}`)));
  });
}

test("captures a multi-segment HLS clip into a verified artifact with real ffmpeg", {
  skip: !ffmpegPath || !ffprobePath,
  timeout: 30000
}, async () => {
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
    const playlist = fs.readFileSync(path.join(fixtureDir, "source.m3u8"), "utf8");
    const fakeFetch: typeof fetch = async input => {
      const url = new URL(String(input));
      const fileName = path.basename(url.pathname);
      const filePath = fileName === "event.m3u8" ? path.join(fixtureDir, "source.m3u8") : path.join(fixtureDir, fileName);
      if (!fs.existsSync(filePath)) return new Response("missing", { status: 404 });
      return new Response(fs.readFileSync(filePath), { status: 200 });
    };
    const artifacts = new XiaomiHomeArtifactStore(path.join(root, "runtime"));
    const worker = new XiaomiHomeClipCaptureWorker({
      cameraClipCaptureEnabled: true,
      cameraClipAllowedHosts: ["media.example"],
      ffmpegPath,
      ffprobePath
    }, artifacts, fakeFetch);
    const occurredAt = "2026-08-29T10:00:00.000Z";
    const artifact = await worker.capture({
      sourceEventId: "clip-e2e-1",
      resourceId: "home:ha:camera.front_door",
      resourceName: "门口摄像头",
      occurredAt,
      eventType: "PeopleMotion",
      playlistUrl: "https://media.example/event.m3u8"
    });
    assert.equal(artifact.mediaKind, "video/mp4");
    assert.ok(artifact.byteLength > 0);
    assert.ok((artifact.durationMs ?? 0) >= 1500);
    assert.equal(fs.existsSync(artifacts.allocateMediaPath("clip-e2e-1", occurredAt, ".mp4")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
