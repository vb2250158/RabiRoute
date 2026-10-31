import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { fixtureApiContract } from "../manager/apiOperationContractFixtures.js";
import { GenerationRuntime } from "./generationRuntime.js";
import { EffectScope } from "./effectScope.js";
import type { PluginCandidate, PluginContext, PluginModule } from "./types.js";

function fixture() {
  const modules = new WeakMap<PluginCandidate, PluginModule>();
  const runtime = new GenerationRuntime({ host: "manager", executor: {
    async prepare(candidate) { return modules.get(candidate)!; }
  } });
  function revision(name: string, activate: (context: PluginContext) => void, instanceId = "worker", shutdownTimeoutMs = 1000, requires: readonly string[] = []) {
    const candidate: PluginCandidate = {
      instanceId, revision: name, config: {}, entry: { execution: "in_process", path: "fixture.mjs" },
      manifest: { schemaVersion: 2, id: `io.test.${instanceId}`, version: "1.0.0",
        entries: { manager: { execution: "in_process", module: "fixture.mjs" } },
        provides: [`test.${instanceId}@1`], requires, optional: [], permissions: [] },
      policy: { restart: { mode: "never", maxAttempts: 0, windowMs: 1, initialBackoffMs: 1, maximumBackoffMs: 1 },
        resources: { maxChildProcesses: 0, shutdownTimeoutMs } }
    };
    modules.set(candidate, { activate(context) {
      context.services.provide(`test.${instanceId}@1`, name);
      context.contributions.register({ kind: "test", id: instanceId, value: name });
      activate(context);
    } });
    return candidate;
  }
  return { runtime, revision };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const change of ["revoked", "identity-changed"] as const) {
  test(`beforePublish rejects ${change} invocation after asynchronous candidate preparation without touching the old graph`, async () => {
    const { runtime, revision } = fixture();
    const entered = gate(), release = gate();
    const source = { enabled: true, identity: "source-one" };
    let owner = "old", persistentWrites = 0, candidateRetires = 0, privateDisposals = 0, oldStops = 0, fenceCalls = 0;
    await runtime.switch([revision("old", context => {
      context.effects.adopt(() => { oldStops++; });
    })]);
    const previous = runtime.current();
    const candidate = revision("new", context => {
      context.effects.add(async () => {
        entered.resolve(); await release.promise;
        return () => { privateDisposals++; };
      });
      context.publication.add({ publish() { owner = "new"; }, rollback() { owner = "old"; },
        afterPublish() { persistentWrites++; }, retire() { candidateRetires++; } });
    });
    try {
      const switching = runtime.switch([candidate], { beforePublish() {
        fenceCalls++;
        if (!source.enabled || source.identity !== "source-one") throw new Error(`source ${change}`);
      } });
      await entered.promise;
      assert.equal(fenceCalls, 0);
      if (change === "revoked") source.enabled = false;
      else source.identity = "source-two";
      release.resolve();
      await assert.rejects(switching, new RegExp(`source ${change}`));
      assert.equal(runtime.current(), previous);
      assert.equal(runtime.current().services.services.get("test.worker@1")?.value, "old");
      assert.equal(runtime.current().contributions.contributions[0]?.value, "old");
      assert.equal(owner, "old");
      assert.equal(persistentWrites, 0);
      assert.equal(candidateRetires, 0);
      assert.equal(privateDisposals, 1);
      assert.equal(oldStops, 0);
      assert.equal(fenceCalls, 1);
    } finally { release.resolve(); await runtime.dispose(); }
  });
}

test("beforePublish also fences no-op switches and rejects asynchronous assertions", async () => {
  const { runtime, revision } = fixture();
  const old = revision("old", () => {});
  await runtime.switch([old]);
  const previous = runtime.current();
  let assertions = 0;
  try {
    const unchanged = await runtime.switch([old], { beforePublish() { assertions++; } });
    assert.equal(unchanged.changed, false);
    assert.equal(assertions, 1);
    await assert.rejects(runtime.switch([old], { beforePublish() { throw new Error("no-op invocation revoked"); } }), /invocation revoked/);
    let published = false;
    const candidate = revision("new", context => {
      context.publication.add({ publish() { published = true; }, rollback() { published = false; } });
    });
    await assert.rejects(runtime.switch([candidate], { beforePublish: async () => {} }), /fence must be synchronous/);
    assert.equal(published, false);
    assert.equal(runtime.current(), previous);
  } finally { await runtime.dispose(); }
});

test("publication changes pointers with the published graph and joins old owner before exclusive startup", async () => {
  const { runtime, revision } = fixture();
  let owner = "";
  let running = "";
  const draining = gate();
  const retired = gate();
  const startup = gate();
  let oldSignal: AbortSignal | undefined;
  const lifecycle: string[] = [];
  const make = (name: string) => revision(name, context => {
    assert.notEqual(owner, name, "candidate must not take ownership in prepare");
    let previous = "";
    context.publication.add({
      publish() { previous = owner; owner = name; },
      rollback() { if (owner === name) owner = previous; },
      async afterPublish({ previousRetirement, signal }) {
        assert.equal(owner, name);
        assert.equal(runtime.current().services.services.get("test.worker@1")?.value, name);
        assert.equal(runtime.current().contributions.contributions[0]?.value, name);
        startup.resolve();
        await previousRetirement;
        signal.throwIfAborted();
        assert.equal(running, "");
        running = name;
        lifecycle.push(`start:${name}`);
      },
      async retire() {
        assert.equal(context.lifecycle.signal.aborted, true);
        if (name === "old") { draining.resolve(); await retired.promise; }
        if (running === name) running = "";
        // Late old-owner cleanup cannot clear the new public pointer.
        if (owner === name) owner = "";
        lifecycle.push(`stop:${name}`);
      }
    });
    if (name === "old") oldSignal = context.lifecycle.signal;
  });
  try {
    await runtime.switch([make("old")]);
    assert.equal(running, "old");
    const previous = runtime.current();
    const switching = runtime.switch([make("new")]);
    await draining.promise;
    assert.equal(owner, "new");
    assert.equal(runtime.current().services.services.get("test.worker@1")?.value, "new");
    assert.equal(previous.services.services.get("test.worker@1")?.value, "old");
    assert.equal(oldSignal?.aborted, true);
    assert.equal(running, "old");
    retired.resolve();
    await switching;
    assert.equal(running, "new");
    assert.equal(owner, "new");
    assert.deepEqual(lifecycle, ["start:old", "stop:old", "start:new"]);
  } finally { retired.resolve(); await runtime.dispose(); }
});

test("publication failure rolls back every pointer in its dependency component including a partially throwing callback", async () => {
  const { runtime, revision } = fixture();
  let owner = "old";
  let secondary = "old";
  let retired = 0;
  let started = 0;
  await runtime.switch([revision("old", () => {}), revision("old", () => {}, "other", 1000, ["test.worker@1"])]);
  const previous = runtime.current();
  const first = revision("new", context => {
    context.publication.add({ publish() { owner = "new"; }, rollback() { owner = "old"; },
      afterPublish() { started++; }, retire() { retired++; } });
  });
  const second = revision("broken", context => {
    context.publication.add({ publish() { secondary = "broken"; throw new Error("pointer failed"); },
      rollback() { secondary = "old"; }, retire() { retired++; } });
  }, "other", 1000, ["test.worker@1"]);
  try {
    await assert.rejects(runtime.switch([first, second]), /pointer failed/);
    assert.equal(owner, "old");
    assert.equal(secondary, "old");
    assert.equal(runtime.current(), previous);
    assert.equal(retired, 0);
    assert.equal(started, 0);
  } finally { await runtime.dispose(); }
});

for (const failAt of [1, 3]) {
  test(`retirement adoption failure ${failAt} rolls back all candidate pointers and staged retirements`, async () => {
    const { runtime, revision } = fixture();
    const pointers = { a: "old-a", b: "old-b", extra: "old-extra" };
    let retired = 0, started = 0, rolledBack = 0, oldStops = 0;
    const old = (id: string) => revision(`old-${id}`, context => {
      context.effects.adopt(() => { oldStops++; });
    }, id, 1000, id === "b" ? ["test.a@1"] : []);
    await runtime.switch([old("a"), old("b")]);
    const previous = runtime.current();
    const a = revision("new-a", context => {
      context.publication.add({ publish() { pointers.a = "new-a"; }, rollback() { pointers.a = "old-a"; rolledBack++; },
        afterPublish() { started++; }, retire() { retired++; } }, "a");
    }, "a");
    const b = revision("new-b", context => {
      context.publication.add({ publish() { pointers.b = "new-b"; }, rollback() { pointers.b = "old-b"; rolledBack++; },
        afterPublish() { started++; }, retire() { retired++; } }, "b");
      context.publication.add({ publish() { pointers.extra = "new-extra"; }, rollback() { pointers.extra = "old-extra"; rolledBack++; },
        afterPublish() { started++; }, retire() { retired++; } }, "extra");
    }, "b", 1000, ["test.a@1"]);
    const originalAdopt = EffectScope.prototype.adopt;
    let adoptions = 0;
    EffectScope.prototype.adopt = function(disposer, label) {
      if (++adoptions === failAt) throw new Error("controlled retirement adoption failure");
      return originalAdopt.call(this, disposer, label);
    };
    try {
      await assert.rejects(runtime.switch([a, b]), /controlled retirement adoption failure/);
      assert.deepEqual(pointers, { a: "old-a", b: "old-b", extra: "old-extra" });
      assert.equal(runtime.current(), previous);
      assert.equal(runtime.current().services.services.get("test.a@1")?.value, "old-a");
      assert.equal(runtime.current().services.services.get("test.b@1")?.value, "old-b");
      assert.deepEqual(runtime.current().records.map(record => record.identity.revision), ["old-a", "old-b"]);
      assert.equal(rolledBack, 3);
      assert.equal(started, 0);
      assert.equal(retired, 0);
      assert.equal(oldStops, 0);
    } finally {
      EffectScope.prototype.adopt = originalAdopt;
      await runtime.dispose();
    }
  });
}

test("effect preparation failure never publishes or retires the candidate and keeps old supervisor alive", async () => {
  const { runtime, revision } = fixture();
  let owner = "old";
  let oldStops = 0;
  let candidateRetires = 0;
  await runtime.switch([revision("old", context => {
    context.effects.adopt(() => { oldStops++; });
  })]);
  try {
    const result = await runtime.switch([revision("bad", context => {
      context.publication.add({ publish() { owner = "bad"; }, rollback() { owner = "old"; },
        retire() { candidateRetires++; } });
      context.effects.add(() => { throw new Error("candidate preparation failed"); });
    })]);
    assert.equal(result.generation.records[0]?.error?.code, "update_failed_using_previous_revision");
    assert.equal(owner, "old");
    assert.equal(oldStops, 0);
    assert.equal(candidateRetires, 0);
  } finally { await runtime.dispose(); }
});

test("post-publication failure removes the new owner without resurrecting old state or undoing I/O", async () => {
  const { runtime, revision } = fixture();
  let writes = 0;
  let rollbacks = 0;
  let retired = 0;
  try {
    const result = await runtime.switch([revision("new", context => {
      context.publication.add({ publish() {}, rollback() { rollbacks++; },
        afterPublish() { writes++; throw new Error("start failed after I/O"); },
        retire() { retired++; } });
    })]);
    assert.equal(result.generation.records[0]?.status, "failed");
    assert.equal(result.generation.records[0]?.error?.code, "runtime_failed");
    assert.equal(result.generation.services.services.has("test.worker@1"), false);
    assert.equal(result.generation.contributions.contributions.length, 0);
    assert.equal(writes, 1);
    assert.equal(rollbacks, 0);
    assert.equal(retired, 1);
  } finally { await runtime.dispose(); }
});

test("a retirement timeout rejects the startup barrier instead of claiming the previous owner joined", async () => {
  const { runtime, revision } = fixture();
  const pending = gate();
  let starts = 0;
  await runtime.switch([revision("old", context => {
    context.effects.adopt(() => pending.promise, "old worker join");
  }, "worker", 20)]);
  try {
    const result = await runtime.switch([revision("new", context => {
      context.publication.add({ publish() {}, rollback() {}, async afterPublish({ previousRetirement }) {
        await previousRetirement;
        starts++;
      } });
    })]);
    assert.equal(starts, 0);
    assert.equal(result.generation.records[0]?.error?.code, "runtime_failed");
    assert.match(result.generation.records[0]?.error?.message ?? "", /did not retire/);
    assert.match(result.generation.cleanupDiagnostics[0]?.message ?? "", /timed out: old worker join/);
  } finally {
    pending.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    await runtime.dispose();
  }
});

test("retry after a retirement timeout cannot start an exclusive replacement while the old owner is unconfirmed", async () => {
  const { runtime, revision } = fixture();
  const pending = gate();
  let starts = 0;
  await runtime.switch([revision("old", context => {
    context.effects.adopt(() => pending.promise, "unconfirmed old worker");
  }, "worker", 20)]);
  const replacement = (name: string) => revision(name, context => {
    context.publication.add({ publish() {}, rollback() {}, async afterPublish({ previousRetirement }) {
      await previousRetirement;
      starts++;
    } });
  });
  try {
    await runtime.switch([replacement("first")]);
    const retried = await runtime.switch([replacement("retry")]);
    assert.equal(starts, 0);
    assert.equal(retried.generation.records[0]?.error?.code, "activation_failed");
    assert.match(retried.generation.records[0]?.error?.message ?? "", /retirement is unconfirmed/);
    pending.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    const recovered = await runtime.switch([replacement("confirmed")]);
    assert.equal(starts, 1);
    assert.equal(recovered.generation.records[0]?.status, "active");
  } finally { pending.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); await runtime.dispose(); }
});

test("shutdown rejects an unconfirmed removed owner and every disposal caller observes the same failure", async () => {
  const { runtime, revision } = fixture();
  const pending = gate();
  let finished = false;
  await runtime.switch([revision("old", context => {
    context.effects.adopt(async () => { await pending.promise; finished = true; }, "removed native worker");
  }, "worker", 20)]);
  try {
    const removal = await runtime.switch([]);
    assert.equal(removal.generation.records.length, 0);
    assert.equal(removal.generation.cleanupDiagnostics.length, 1);
    assert.equal(finished, false);
    const shutdown = runtime.dispose();
    const repeated = runtime.dispose();
    await assert.rejects(shutdown, AggregateError);
    assert.equal(shutdown, repeated);
    await assert.rejects(repeated, AggregateError);
    await assert.rejects(runtime.dispose(), AggregateError);
    assert.equal(finished, false);
    assert.equal(runtime.current().cleanupDiagnostics.at(-1)?.phase, "shutdown");
  } finally {
    pending.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
});

test("shutdown succeeds when a timed-out removed owner has actually completed before shutdown", async () => {
  const { runtime, revision } = fixture();
  const pending = gate();
  let finished = false;
  await runtime.switch([revision("old", context => {
    context.effects.adopt(async () => { await pending.promise; finished = true; }, "eventually retired worker");
  }, "worker", 20)]);
  try {
    const removal = await runtime.switch([]);
    assert.equal(removal.generation.cleanupDiagnostics.length, 1);
    pending.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, true);
    await runtime.dispose();
  } finally { pending.resolve(); }
});

test("an active disposer failure remains rejected on repeated runtime shutdown without repeating disposal", async () => {
  const { runtime, revision } = fixture();
  let disposals = 0;
  await runtime.switch([revision("active", context => {
    context.effects.adopt(() => { disposals++; throw new Error("controlled active shutdown failure"); });
  })]);
  const first = runtime.dispose();
  await assert.rejects(first, AggregateError);
  const second = runtime.dispose();
  assert.equal(second, first);
  await assert.rejects(second, AggregateError);
  assert.equal(disposals, 1);
});

for (const transport of ["json", "sse"] as const) {
  test(`publication retains actual old ${transport} owner drain while new requests use the new revision`, { timeout: 10000 }, async () => {
    const { runtime, revision } = fixture();
    const registry = new ManagerPluginRouteRegistry(() => new Set(runtime.current().records
      .filter(record => record.status === "active").map(record => record.identity.activationId)));
    const entered = gate(), release = gate(), published = gate();
    let newStarted = false;
    const server = http.createServer((request, response) => {
      if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) {
        response.statusCode = 404; response.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/api/fixture/publication`;
    const schema = { type: "object", additionalProperties: false, required: ["revision"],
      properties: { revision: { type: "string" } } } as const;
    const contract = fixtureApiContract({ operationId: "test.publication.read", method: "GET",
      pathTemplate: "/api/fixture/publication", transport: transport === "sse" ? "sse" : "http",
      request: { path: { type: "object", properties: {}, additionalProperties: false },
        query: { type: "object", properties: {}, additionalProperties: false }, headers: { type: "object" }, body: { kind: "none" } },
      responses: transport === "json" ? { "200": { mediaType: "application/json", schema } }
        : { "200": { mediaType: "text/event-stream", stream: { framing: "sse-json", maxFrameBytes: 1024,
          frameSchema: { type: "object", additionalProperties: false, required: ["event", "data"],
            properties: { event: { type: "string" }, data: schema } },
          completion: "Owner reaches EOF after cleanup.", cancellation: "Join owner cleanup." } } } });
    const make = (name: string) => revision(name, context => {
      context.effects.add(() => {
        const registration = registry.registerOperations(context.identity.instanceId, [{ contract,
          async handler() {
            if (transport === "json") {
              if (name === "old") { entered.resolve(); await release.promise; }
              return { status: 200, body: { revision: name } };
            }
            return { status: 200, stream: {
              frames: (async function* () {
                try { yield { event: "revision", data: { revision: name } }; }
                finally { if (name === "old") { entered.resolve(); await release.promise; } }
              })(), cancel() {}
            } };
          }
        }]);
        return () => registration.dispose();
      });
      context.publication.add({ publish() {}, rollback() {}, async afterPublish({ previousRetirement }) {
        if (name !== "old") {
          published.resolve(); await previousRetirement; newStarted = true;
        }
      } });
    }, "worker", 2000);
    try {
      await runtime.switch([make("old")]);
      const oldRequest = fetch(url).then(async response => ({ status: response.status, body: await response.text() }));
      // Observe client cancellation without releasing the business-owner promise.
      void oldRequest.catch(() => {});
      await entered.promise;
      const switching = runtime.switch([make("new")]);
      await published.promise;
      assert.equal(newStarted, false);
      const fresh = await fetch(url);
      assert.equal(fresh.status, 200);
      assert.match(await fresh.text(), /new/);
      assert.equal(newStarted, false);
      release.resolve();
      if (transport === "json") assert.match((await oldRequest).body, /old/);
      else await oldRequest.catch(() => undefined); // Retiring an SSE response closes its socket, but must still join owner cleanup.
      await switching;
      assert.equal(newStarted, true);
    } finally {
      release.resolve(); await runtime.dispose(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
