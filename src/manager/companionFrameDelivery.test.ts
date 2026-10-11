import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CompanionFrameDelivery } from "./companionFrameDelivery.js";
test("native frame becomes an actual bounded attachment and switching discards its lease", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-frame-test-"));
  const frames = new CompanionFrameDelivery(root);
  try {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const first = await frames.stage(randomUUID(), bytes, Date.now() + 180_000);
    assert.deepEqual(await fs.readFile(first), bytes);
    const next = await frames.stage(randomUUID(), bytes, Date.now() + 180_000);
    await assert.rejects(fs.access(first)); assert.deepEqual(await fs.readFile(next), bytes);
    await frames.retain(); await assert.rejects(fs.access(next));
    await assert.rejects(frames.stage("../outside", bytes, Date.now() + 1000), /Invalid/);
  } finally { await frames.dispose(); await fs.rmdir(root); }
});
