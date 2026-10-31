import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cameraClipPath, cameraEventId, type CameraEvent } from "./cameraEvents.js";

test("camera identity is stable and clips use only the resolved persona directory", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "camera-events-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cameraId = "device-1";
  const occurredAt = "2026-10-29T18:00:00Z";
  const eventId = cameraEventId("xiaomi-miot", cameraId, occurredAt, "motion");
  const event: CameraEvent = { eventId, cameraId, adapterId: "xiaomi-miot", occurredAt, kind: "motion", resourceId: "home:ha:camera.test" };
  assert.equal(eventId, cameraEventId("xiaomi-miot", cameraId, "2026-10-29T18:00:00.000Z", "motion"));
  assert.equal(cameraClipPath(root, event), path.join(root, "camera", cameraId, "2026-10-29", `${eventId}.mp4`));
  assert.throws(() => cameraClipPath(root, { ...event, cameraId: ".." }), /Invalid/);
  assert.throws(() => cameraClipPath(root, { ...event, occurredAt: "unknown" }), /Invalid/);
  assert.throws(() => cameraClipPath("relative", event), /absolute/);
});

test("camera storage rejects directory junctions", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "camera-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside");
  const role = path.join(root, "role");
  fs.mkdirSync(outside);
  fs.mkdirSync(role);
  fs.symlinkSync(outside, path.join(role, "camera"), "junction");
  assert.throws(() => cameraClipPath(role, { eventId: "event", cameraId: "device", occurredAt: "2026-10-29Z", adapterId: "test", kind: "motion", resourceId: "home:test" }), /Unsafe/);
});
