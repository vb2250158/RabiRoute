import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbuddyDesktopBootstrap } from "./workbuddyDesktopBootstrap.js";
import { clearClosedWorkbuddyDesktopRelay, isWorkbuddyDesktopRelayReady, serveWorkbuddyDesktopRelay } from "./workbuddyDesktopRelay.js";

test("an active connector is reused and concurrent cold starts join one launch", async () => {
  let ready = false;
  let calls = 0;
  const ensure = createWorkbuddyDesktopBootstrap("package-fixture", {
    supported: true, timeoutMs: 1000,
    isReady: async () => ready,
    launch: async root => { assert.equal(root, "package-fixture"); calls++; ready = true; },
  });
  await Promise.all([ensure(), ensure(), ensure()]);
  await ensure();
  assert.equal(calls, 1);
});

test("one cancelled request leaves other waiters attached to the same desktop startup", async () => {
  let ready = false;
  let began!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { began = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ensure = createWorkbuddyDesktopBootstrap("package-fixture", {
    supported: true, timeoutMs: 1000, isReady: async () => ready,
    launch: async () => { began(); await gate; ready = true; }
  });
  const controller = new AbortController();
  const first = ensure(controller.signal);
  await entered;
  const second = ensure();
  controller.abort(new Error("Caller stopped"));
  await assert.rejects(first, /Caller stopped/);
  release();
  await second;
});

test("desktop readiness probes never send and only a disconnected relay can be reclaimed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rabi-workbuddy-bootstrap-"));
  const descriptor = path.join(dir, "desktop-relay.json");
  try {
    assert.equal(await isWorkbuddyDesktopRelayReady(descriptor), false);
    const stop = await serveWorkbuddyDesktopRelay(() => assert.fail("the readiness probe must not send"), descriptor);
    const liveDescriptor = await readFile(descriptor);
    try {
      assert.equal(await isWorkbuddyDesktopRelayReady(descriptor), true);
      await assert.rejects(clearClosedWorkbuddyDesktopRelay(descriptor), /仍在运行/);
      assert.deepEqual(await readFile(descriptor), liveDescriptor);
    } finally { await stop(); }
    await writeFile(descriptor, liveDescriptor);
    assert.equal(await isWorkbuddyDesktopRelayReady(descriptor), false);
    await clearClosedWorkbuddyDesktopRelay(descriptor);
    await assert.rejects(readFile(descriptor), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
