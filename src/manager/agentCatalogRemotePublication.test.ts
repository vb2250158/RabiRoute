import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginManifest } from "../plugin-kernel/types.js";
import { RemoteAgentHub, type RemoteAgentHubOptions } from "../messageEndpoints/remoteAgentManager.js";
import { mountAgentAdapterCatalogPlugin, type AgentAdapterCatalogService } from "./agentAdapterCatalog.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createRemoteAgentOperations } from "./remoteAgentRoutes.js";
import type { ApiOperationDefinition } from "./apiOperationContract.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
type Kind = "agent-adapter-catalog" | "remote-agent";
type Owner = { value: AgentAdapterCatalogService | RemoteAgentHub; stops: number; registrations: number; work?: ReturnType<typeof gate> };

async function fixture(kind: Kind) {
  const directory = path.join(root, "plugins/builtin", `io.rabiroute.manager.${kind}`, "1.0.0");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "rabi.plugin.json"), "utf8")) as PluginManifest;
  const owners: Owner[] = [];
  const rootDir = path.join(os.tmpdir(), `rabi-l4-uncreated-${randomUUID()}`);
  let pointer: Owner["value"] | undefined;
  let failPointer = false;
  let registrationFailure = false;
  let preparation: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  let nextPublication: ReturnType<typeof gate> | undefined;
  const conversationRecords: unknown[] = [];
  let runtime!: GenerationRuntime;
  const registry = new ManagerPluginRouteRegistry(() => new Set(runtime.current().records
    .filter(record => record.status === "active").map(record => record.identity.activationId)));
  const host = {
    rootDir, path, managerPort: 0, managerHost: "127.0.0.1", remoteAgentPublicHost: undefined,
    runtimes: new Map<string, { definition: { id: string } }>(), handleRemoteAgentTaskEvent: async () => {}, appendLog() {},
    appendMessageContextToDir(directory: string, record: unknown) { conversationRecords.push({ directory, record }); },
    roleDirForDefinition(definition: { id: string }) { return `fixture-role/${definition.id}`; },
    remoteAgentTaskWithGatewayDefaults: (body: unknown) => body,
    createRemoteAgentOperations,
    async mountAgentAdapterCatalogPlugin(options: Parameters<typeof mountAgentAdapterCatalogPlugin>[0]) {
      const owner: Owner = { value: undefined as unknown as AgentAdapterCatalogService, stops: 0, registrations: 0 };
      owners.push(owner);
      const mount = await mountAgentAdapterCatalogPlugin({ ...options, listManifests: async () => {
        await owner.work?.promise;
        return [];
      } });
      owner.value = mount.service;
      return { ...mount, stop(reason?: string) { owner.stops++; return mount.stop(reason); } };
    },
    RemoteAgentHub: class extends RemoteAgentHub {
      constructor(options: RemoteAgentHubOptions) { super(options); owners.push({ value: this, stops: 0, registrations: 0 }); }
      override shutdown(reason?: string) { owners.find(owner => owner.value === this)!.stops++; return super.shutdown(reason); }
    },
    managerPluginRoutes: {
      async registerOperationsAsync(instanceId: string, definitions: readonly ApiOperationDefinition[], signal: AbortSignal) {
        if (registrationFailure) throw new Error("controlled registration failure");
        const registration = await registry.registerOperationsAsync(instanceId, definitions, signal);
        const owner = owners.at(-1)!;
        return { activeOperationCount: () => registration.activeOperationCount(), dispose() {
          owner.registrations++;
          return registration.dispose();
        } };
      }
    }
  };
  Object.defineProperty(host, kind === "remote-agent" ? "remoteAgentHub" : "agentAdapterCatalogService", {
    get: () => pointer,
    set(value) {
      pointer = value;
      if (failPointer && value !== undefined) { failPointer = false; throw new Error("controlled partial publication"); }
      nextPublication?.resolve();
      nextPublication = undefined;
    }
  });
  runtime = new GenerationRuntime({ host: "manager", hostServices: [
    { capability: "manager.core@1", value: {} }, { capability: `host.manager.${kind}@1`, value: host }
  ], executor: { async prepare(candidate) {
    const module = await import(new URL(`../../plugins/builtin/io.rabiroute.manager.${kind}/1.0.0/manager.mjs`, import.meta.url).href);
    return { async activate(context) {
      await module.activate(context);
      const barrier = preparation;
      if (barrier) context.effects.add(async () => {
        barrier.entered.resolve(); await barrier.release.promise;
        return () => {};
      });
    } };
  } } });
  const candidate = (revision: string): PluginCandidate => ({ instanceId: `manager:${kind}`, revision, manifest,
    config: {}, entry: { execution: "in_process", path: path.join(directory, "manager.mjs") } });
  return { runtime, owners, host, registry, candidate, pointer: () => pointer, rootDir, conversationRecords,
    publication() { nextPublication = gate(); return nextPublication.promise; },
    hold() { const barrier = { entered: gate(), release: gate() }; preparation = barrier; return barrier; },
    failPublication() { failPointer = true; }, failRegistration() { registrationFailure = true; } };
}

for (const kind of ["agent-adapter-catalog", "remote-agent"] as const) {
  test(`${kind}: candidate preparation stays private and publication rollback preserves the old owner`, async () => {
    const f = await fixture(kind);
    await f.runtime.switch([f.candidate("old")]);
    const previous = f.runtime.current(), old = f.pointer();
    const barrier = f.hold();
    try {
      const switching = f.runtime.switch([f.candidate("candidate")], { beforePublish() { throw new Error("candidate rejected"); } });
      await barrier.entered.promise;
      assert.equal(f.pointer(), old);
      assert.equal(f.runtime.current(), previous);
      assert.equal(f.owners.length, 2);
      assert.equal(fs.existsSync(f.rootDir), false, "constructing reference owners must not create runtime data");
      barrier.release.resolve();
      await assert.rejects(switching, /candidate rejected/);
      assert.equal(f.pointer(), old);
      assert.equal(f.runtime.current(), previous);
      assert.equal(f.owners[0].stops, 0);
      assert.equal(f.owners[1].stops, 1);
      assert.equal(f.owners[1].registrations, 1);
    } finally { barrier.release.resolve(); await f.runtime.dispose(); }
  });

  test(`${kind}: a setter throwing after its write restores the retained old pointer and graph`, async () => {
    const f = await fixture(kind);
    await f.runtime.switch([f.candidate("old")]);
    const previous = f.runtime.current(), old = f.pointer();
    try {
      f.failPublication();
      await assert.rejects(f.runtime.switch([f.candidate("candidate")]), /controlled partial publication/);
      assert.equal(f.pointer(), old);
      assert.equal(f.runtime.current(), previous);
      assert.equal(f.owners[0].stops, 0);
      assert.equal(f.owners[1].stops, 1);
      assert.equal(f.owners[1].registrations, 1);
    } finally { await f.runtime.dispose(); }
  });

  test(`${kind}: late old cleanup joins its actual work without clearing or stopping the new owner`, async () => {
    const f = await fixture(kind);
    await f.runtime.switch([f.candidate("old")]);
    const old = f.pointer()!;
    const work = gate();
    let nativeWork: Promise<unknown>;
    if (kind === "agent-adapter-catalog") {
      f.owners[0].work = work;
      nativeWork = (old as AgentAdapterCatalogService).catalog();
    } else {
      nativeWork = work.promise;
      (old as unknown as { trackCallback(callback: Promise<void>): void }).trackCallback(work.promise);
    }
    let switched = false;
    try {
      const published = f.publication();
      const switching = f.runtime.switch([f.candidate("new")]).then(result => { switched = true; return result; });
      await published;
      assert.notEqual(f.pointer(), old);
      const current = f.pointer();
      await turn();
      assert.equal(switched, false);
      assert.equal(f.owners[1].stops, 0);
      work.resolve(); await nativeWork; await switching;
      assert.equal(f.pointer(), current);
      assert.equal(f.owners[0].stops, 1);
      assert.equal(f.owners[0].registrations, 1);
      assert.equal(f.owners[1].stops, 0);
      const first = f.runtime.dispose(), second = f.runtime.dispose();
      assert.equal(first, second);
      await first;
      assert.equal(f.owners[1].stops, 1);
      assert.equal(f.owners[1].registrations, 1);
      assert.equal(f.pointer(), undefined);
    } finally { work.resolve(); await f.runtime.dispose(); }
  });
}

test("a remote candidate registration failure still reclaims its private hub without touching the active hub", async () => {
  const f = await fixture("remote-agent");
  await f.runtime.switch([f.candidate("old")]);
  const old = f.pointer();
  try {
    f.failRegistration();
    const result = await f.runtime.switch([f.candidate("candidate")]);
    assert.equal(f.pointer(), old);
    assert.equal(result.generation.records[0]?.identity.revision, "old");
    assert.equal(f.owners[0].stops, 0);
    assert.equal(f.owners[1].stops, 1);
  } finally { await f.runtime.dispose(); }
});

test("remote conversation callbacks use the retained host functions and their own gateway reference", async () => {
  const f = await fixture("remote-agent");
  f.host.runtimes.set("fixture-gateway", { definition: { id: "fixture-gateway" } });
  try {
    await f.runtime.switch([f.candidate("active")]);
    const record = { gatewayId: "fixture-gateway", body: "controlled local callback" };
    (f.pointer() as unknown as { emitConversationRecord(record: unknown): void }).emitConversationRecord(record);
    await turn();
    assert.deepEqual(f.conversationRecords, [{ directory: "fixture-role/fixture-gateway", record }]);
  } finally { await f.runtime.dispose(); }
});

test("catalog mount joins its service even if route retirement fails and repeated stop shares the error", async () => {
  const mount = await mountAgentAdapterCatalogPlugin({ rootDir: root, getRuntimes: () => [], listManifests: async () => [], adopt() {},
    registerOperations: async () => ({ activeOperationCount: () => 0, async dispose() { throw new Error("controlled route retirement failure"); } }) });
  const first = mount.stop(), second = mount.stop();
  assert.equal(first, second);
  await assert.rejects(first, AggregateError);
  assert.equal(mount.service.workerStatus().state, "stopped");
  await assert.rejects(second, AggregateError);
});

test("native RemoteAgentHub repeated shutdown and forced termination wait for actual socket close", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  class Socket extends EventEmitter {
    readyState: number = WebSocket.CLOSING;
    terminations = 0;
    terminate() { this.terminations++; }
  }
  const socket = new Socket();
  const hub = new RemoteAgentHub({ managerPort: 0, passwordStorePath: path.join(os.tmpdir(), "unused-fixture.json"),
    getDefaultGatewayId: () => "fixture-gateway" });
  (hub as unknown as { devices: Map<string, unknown> }).devices.set("fixture", { socket });
  let finished = false;
  const first = hub.shutdown(), second = hub.shutdown();
  assert.equal(first, second);
  const joining = first.then(() => { finished = true; });
  t.mock.timers.tick(2000);
  await turn();
  assert.equal(socket.terminations, 1);
  assert.equal(finished, false);
  socket.readyState = WebSocket.CLOSED;
  socket.emit("close");
  await joining;
  assert.equal(finished, true);
});
