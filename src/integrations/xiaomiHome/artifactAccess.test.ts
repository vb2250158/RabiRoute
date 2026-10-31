import assert from "node:assert/strict";
import test from "node:test";
import { parseSingleByteRange } from "./artifactAccess.js";
import { XiaomiHomeArtifactAccess } from "./artifactAccess.js";
import { XiaomiHomeArtifactStore } from "./artifactStore.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type http from "node:http";
import { markAuthenticatedConnectionRequest } from "../../manager/connectionRequestAccess.js";

test("parses bounded and suffix video byte ranges", () => {
  assert.deepEqual(parseSingleByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseSingleByteRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseSingleByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.throws(() => parseSingleByteRange("bytes=100-101", 100), /invalid/);
  assert.throws(() => parseSingleByteRange("bytes=0-1,4-5", 100), /invalid/);
});

test("native artifact content exposes original range headers and audited bytes, including cancellation before iteration", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomi-artifact-content-"));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("xiaomi-artifact-content-")); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new XiaomiHomeArtifactStore(root), bytes = Buffer.from("0123456789"), occurredAt = "2026-10-21T00:00:00.000Z";
  const file = store.allocateMediaPath("fixture-event", occurredAt, ".mp4"); fs.writeFileSync(file, bytes);
  const record = store.register({ sourceEventId: "fixture-event", resourceId: "fixture-camera", eventKind: "fixture", occurredAt, mediaKind: "video/mp4", localPath: file, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length });
  const request = { headers: { range: "bytes=2-5" }, socket: { remoteAddress: "192.0.2.1" } } as unknown as http.IncomingMessage;
  markAuthenticatedConnectionRequest(request);
  const owner = new XiaomiHomeArtifactAccess(store), content = owner.open(request, record.artifactId);
  assert.equal(content.status, 206); assert.equal(content.headers["content-range"], "bytes 2-5/10"); assert.equal(content.headers["content-length"], "4");
  const chunks: Buffer[] = []; for await (const chunk of content.frames) chunks.push(Buffer.from(chunk)); assert.equal(Buffer.concat(chunks).toString(), "2345");
  const untouched = owner.open(request, record.artifactId); await untouched.cancel(); const cancelled: Uint8Array[] = []; for await (const chunk of untouched.frames) cancelled.push(chunk); assert.deepEqual(cancelled, []);
  assert.ok(fs.readdirSync(path.join(root, "artifacts", "access")).length > 0);
  request.headers.range = "bytes=30-40"; assert.throws(() => owner.open(request, record.artifactId), /invalid/);
});
