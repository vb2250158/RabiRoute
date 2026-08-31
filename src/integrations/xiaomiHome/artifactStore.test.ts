import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { XiaomiHomeArtifactStore } from "./artifactStore.js";

test("artifact ledger is idempotent, hides local paths, and rebuilds its index", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomi-artifacts-"));
  const mediaDir = path.join(root, "artifacts", "media", "2026", "08", "29");
  fs.mkdirSync(mediaDir, { recursive: true });
  const mediaPath = path.join(mediaDir, "event.mp4");
  const bytes = Buffer.from("test-video");
  fs.writeFileSync(mediaPath, bytes);
  const input = {
    sourceEventId: "event-1",
    resourceId: "home:ha:camera.entry",
    eventKind: "camera_motion_detected",
    occurredAt: "2026-08-29T17:00:00+08:00",
    mediaKind: "video/mp4" as const,
    localPath: mediaPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    durationMs: 5000
  };
  const firstStore = new XiaomiHomeArtifactStore(root);
  assert.match(firstStore.allocateMediaPath("event-1", input.occurredAt, ".mp4"), /artifacts[\\/]media[\\/]2026[\\/]08[\\/]29/);
  const first = firstStore.register(input);
  const repeated = firstStore.register(input);
  assert.equal(repeated.artifactId, first.artifactId);
  assert.equal("localPath" in first, false);
  const rebuilt = new XiaomiHomeArtifactStore(root);
  assert.equal(rebuilt.get(first.artifactId)?.sourceEventId, "event-1");
  assert.equal(rebuilt.getBySourceEventId("event-1")?.artifactId, first.artifactId);
  assert.equal(rebuilt.list({ resourceId: input.resourceId }).length, 1);
  assert.match(String(rebuilt.lifecycleContract().action), /no archive or deletion/);
});

test("artifact registration rejects media outside its controlled directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomi-artifacts-"));
  const outside = path.join(root, "outside.mp4");
  fs.writeFileSync(outside, "outside");
  const store = new XiaomiHomeArtifactStore(root);
  assert.throws(() => store.register({
    sourceEventId: "event-2",
    resourceId: "home:ha:camera.entry",
    eventKind: "camera_motion_detected",
    occurredAt: "2026-08-29T17:00:00+08:00",
    mediaKind: "video/mp4",
    localPath: outside,
    sha256: createHash("sha256").update("outside").digest("hex"),
    byteLength: 7
  }), /inside the Xiaomi Home artifact media directory/);
});
