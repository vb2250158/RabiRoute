import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { GenerationRuntime } from "./generationRuntime.js";
import type { PluginCandidate } from "./types.js";

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(options: { failedStop?: boolean; lateFactory?: ReturnType<typeof gate>; lateClose?: ReturnType<typeof gate>; closeEntered?: ReturnType<typeof gate> } = {}) {
  const entry = path.resolve("plugins/builtin/io.rabiroute.manager.rabilink-relay/1.0.0/manager.mjs");
  const module = await import(pathToFileURL(entry).href);
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(entry), "rabi.plugin.json"), "utf8"));
  const counts = { video: 0, videoStopped: 0, peer: 0, peerStopped: 0, registered: 0 };
  let registrationFails = options.failedStop;
  const host = {
    managerListenerReady: false, syncActiveRabiLinkRelay: async () => {},
    peerLanServer: { async stop() {} }, rabiLinkRelayRuntime: { async stop() {} },
    createDirectVideoReceiver() { counts.video++; return { async stop() { counts.videoStopped++; if (options.failedStop) throw new Error("fixture video stop failed"); } }; },
    async createPeerRuntime() {
      const index = counts.peer++;
      if (index === 0) await options.lateFactory?.promise;
      return { upgradeOperation: {}, httpOperations: [], operations: [], stopAccepting() {}, publish() {}, rollback() {}, start() {},
        async stop() { counts.peerStopped++; if (index === 0) { options.closeEntered?.resolve(); await options.lateClose?.promise; } } };
    },
    createDirectVideoOperations: () => [], createRabiLinkAgentDeviceOperations: () => [],
    createRabiLinkMobileOperations: () => [], createDeviceAgentOperations: () => [],
    managerPluginRoutes: {
      async registerOperationsAsync(_instance: string, _definitions: unknown, signal: AbortSignal) {
        counts.registered++; signal.throwIfAborted();
        if (registrationFails) throw new Error("fixture registration failed");
        return { async dispose() {} };
      }, registerUpgrades: () => ({ stopAccepting() {}, async dispose() {} }), registerHttpProxies: () => ({ async dispose() {} })
    }
  };
  const kernel = new GenerationRuntime({ host: "manager", activationTimeoutMs: 150,
    executor: { async prepare() { return module; } }, hostServices: [
      { capability: "manager.core@1", value: {} }, { capability: "manager.persona@1", value: {} },
      { capability: "host.manager.rabilink-relay@1", value: host }
    ] });
  const candidate = (revision: string): PluginCandidate => ({ instanceId: "manager:rabilink-relay", revision, config: {}, manifest,
    entry: { execution: "in_process", path: entry }, policy: { resources: { maxChildProcesses: 0, shutdownTimeoutMs: 20 },
      restart: { mode: "never", maxAttempts: 0, windowMs: 1000, initialBackoffMs: 1, maximumBackoffMs: 1 } } });
  return { kernel, counts, candidate, allowRegistration() { registrationFails = false; } };
}

test("failed Relay registration and failed real cleanup retain the owner fence through shutdown", async () => {
  const f = await fixture({ failedStop: true });
  const first = await f.kernel.switch([f.candidate("one")]);
  assert.ok(first.generation.cleanupDiagnostics.some(row => /video stop failed/.test(row.message)));
  await f.kernel.switch([f.candidate("two")]);
  assert.equal(f.counts.video, 1); assert.equal(f.counts.videoStopped, 1); assert.equal(f.counts.peerStopped, 1);
  await assert.rejects(f.kernel.dispose(), /Plugin cleanup failed/);
});

test("Relay joins a late factory and its late disposer before permitting another owner", async () => {
  const factory = gate(), close = gate(), closeEntered = gate();
  const f = await fixture({ lateFactory: factory, lateClose: close, closeEntered });
  try {
    const first = await f.kernel.switch([f.candidate("one")]);
    assert.ok(first.generation.cleanupDiagnostics.some(row => /timed out/.test(row.message)));
    await f.kernel.switch([f.candidate("two")]);
    assert.equal(f.counts.video, 1); assert.equal(f.counts.peerStopped, 0);
    factory.resolve(); await closeEntered.promise;
    await f.kernel.switch([f.candidate("three")]);
    assert.equal(f.counts.video, 1); assert.equal(f.counts.peerStopped, 1); assert.equal(f.counts.registered, 0);
    close.resolve(); for (let i = 0; i < 10; i++) await tick();
    f.allowRegistration();
    const recovered = await f.kernel.switch([f.candidate("four")]);
    assert.equal(recovered.generation.records[0]!.status, "active");
    assert.equal(f.counts.video, 2); assert.equal(f.counts.videoStopped, 1);
  } finally { factory.resolve(); close.resolve(); await f.kernel.dispose(); }
  assert.equal(f.counts.videoStopped, 2); assert.equal(f.counts.peerStopped, 2);
});
