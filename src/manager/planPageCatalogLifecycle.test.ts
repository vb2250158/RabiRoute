import assert from "node:assert/strict";
import test from "node:test";
import { PlanPageCatalogInitializingError, PlanPageCatalogLifecycle } from "./planPageCatalogLifecycle.js";

test("ready-only requests share preparation and distinguish a real empty page", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let creates = 0, prepares = 0, stops = 0;
  const lifecycle = new PlanPageCatalogLifecycle<string, string[]>({
    maxRoles: 1, buildTimeoutMs: 10000,
    create: () => { creates++; return {
      prepare: async () => { prepares++; await barrier; },
      query: async () => [], stop: async () => { stops++; }
    }; }
  });
  try {
    await Promise.all(Array.from({ length: 20 }, () => assert.rejects(
      lifecycle.query("synthetic-role", "page", undefined, true), PlanPageCatalogInitializingError)));
    assert.equal(creates, 1);
    assert.equal(prepares, 1);
    assert.equal(stops, 0);
    await assert.rejects(lifecycle.query("other-role", "page", undefined, true), /PLAN_CATALOG_CAPACITY/);
    const controller = new AbortController();
    const cancelled = assert.rejects(lifecycle.query("synthetic-role", "page", controller.signal), /REQUEST_ABORTED/);
    controller.abort();
    await cancelled;
    const ready = lifecycle.prepare("synthetic-role");
    release();
    await ready;
    assert.deepEqual(await lifecycle.query("synthetic-role", "page", undefined, true), []);
    assert.equal(creates, 1);
    assert.equal(stops, 0);
  } finally { release(); await lifecycle.stop(); }
});

test("failed preparation is not initializing while termination is pending", async () => {
  let rejectBuild!: (error: Error) => void;
  let releaseStop!: () => void;
  let signalStop!: () => void;
  const build = new Promise<void>((_, reject) => { rejectBuild = reject; });
  const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
  const stopping = new Promise<void>(resolve => { signalStop = resolve; });
  const lifecycle = new PlanPageCatalogLifecycle<string, string>({
    maxRoles: 1, buildTimeoutMs: 10000,
    create: () => ({ prepare: () => build, query: async x => x,
      stop: () => { signalStop(); return stopped; } })
  });
  const failure = new Error("synthetic build failure");
  const prepared = assert.rejects(lifecycle.prepare("synthetic-role"), error => error === failure);
  rejectBuild(failure);
  await stopping;
  try {
    await assert.rejects(lifecycle.query("synthetic-role", "page", undefined, true), error => error === failure);
  } finally { releaseStop(); await prepared; await lifecycle.stop(); }
});

test("request cancellation preserves shared role preparation", async () => {
  let resolvePreparation!: () => void;
  const preparation = {
    promise: new Promise<void>(resolve => { resolvePreparation = resolve; }),
    resolve: () => resolvePreparation()
  };
  let created = 0;
  let stopped = 0;
  const lifecycle = new PlanPageCatalogLifecycle<string, string>({
    maxRoles: 1, buildTimeoutMs: 10000,
    create: () => { created++; return {
      prepare: () => preparation.promise,
      query: async input => input,
      stop: async () => { stopped++; }
    }; }
  });
  const controller = new AbortController();
  const first = lifecycle.query("synthetic-role", "first", controller.signal);
  const firstRejected = assert.rejects(first, /REQUEST_ABORTED/);
  const second = lifecycle.query("synthetic-role", "second");
  controller.abort();
  await firstRejected;
  assert.equal(created, 1);
  assert.equal(stopped, 0);
  await assert.rejects(lifecycle.query("other-role", "third"), /CAPACITY/);
  preparation.resolve();
  assert.equal(await second, "second");
  await lifecycle.stop();
  await assert.rejects(lifecycle.query("synthetic-role", "fourth"), /STOPPED/);
});

test("cancelled running queries keep capacity until actual settlement", async () => {
  let resolveQuery!: (value: string) => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  let stops = 0;
  const lifecycle = new PlanPageCatalogLifecycle<string, string>({
    maxRoles: 1, buildTimeoutMs: 10000, maxQueriesPerRole: 1,
    create: () => ({
      prepare: async () => {},
      query: () => { started(); return new Promise<string>(resolve => { resolveQuery = resolve; }); },
      stop: async () => { stops++; }
    })
  });
  const controller = new AbortController();
  const rejected = assert.rejects(lifecycle.query("synthetic-role", "first", controller.signal), /REQUEST_ABORTED/);
  await running;
  controller.abort();
  await rejected;
  await assert.rejects(lifecycle.query("synthetic-role", "second"), /QUERY_CAPACITY/);
  resolveQuery("done");
  await new Promise<void>(resolve => setImmediate(resolve));
  const stopping = lifecycle.stop();
  assert.equal(lifecycle.stop(), stopping);
  await stopping;
  assert.equal(stops, 1);
});

test("build timeout retains role capacity until owner termination is confirmed", async () => {
  let confirmStop!: () => void;
  let signalStopping!: () => void;
  const stopping = new Promise<void>(resolve => { signalStopping = resolve; });
  const stopped = new Promise<void>(resolve => { confirmStop = resolve; });
  let creates = 0;
  let stops = 0;
  const lifecycle = new PlanPageCatalogLifecycle<string, string>({
    maxRoles: 1, buildTimeoutMs: 20,
    create: () => {
      creates++;
      return {
        prepare: () => new Promise(() => {}), query: async x => x,
        stop: () => { stops++; signalStopping(); return stopped; }
      };
    }
  });
  const rejected = assert.rejects(lifecycle.query("synthetic-role", "value"), /BUILD_TIMEOUT/);
  await stopping;
  await assert.rejects(lifecycle.query("other-role", "value"), /CAPACITY/);
  assert.equal(creates, 1);
  confirmStop();
  await rejected;
  await lifecycle.stop();
  assert.equal(stops, 1);
});

test("stop rejects a running request even when its owner query never settles", async () => {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const lifecycle = new PlanPageCatalogLifecycle<string, string>({
    maxRoles: 1, buildTimeoutMs: 10000,
    create: () => ({
      prepare: async () => {},
      query: () => { started(); return new Promise(() => {}); },
      stop: async () => {}
    })
  });
  const rejected = assert.rejects(lifecycle.query("synthetic-role", "value"), /STOPPED/);
  await running;
  await lifecycle.stop();
  await rejected;
});

test("full invalidation discards late query output and rebuilds only after stop", async () => {
  let finish!: (value: string) => void;
  let entered!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  let creates = 0;
  const lifecycle = new PlanPageCatalogLifecycle<string, string>({
    maxRoles: 1, buildTimeoutMs: 10000,
    create: () => {
      const generation = ++creates;
      return { prepare: async () => {}, stop: async () => {},
        query: async () => {
          if (generation > 1) return "new";
          entered();
          return new Promise<string>(resolve => { finish = resolve; });
        }
      };
    }
  });
  const rejected = assert.rejects(lifecycle.query("synthetic-role", "old"), /DIRTY/);
  await running;
  await lifecycle.invalidate("synthetic-role");
  finish("old");
  await rejected;
  assert.equal(await lifecycle.query("synthetic-role", "new"), "new");
  assert.equal(creates, 2);
  await lifecycle.stop();
});

test("stop settles a request whose preparation never returns", async () => {
  const lifecycle = new PlanPageCatalogLifecycle<string, string>({
    maxRoles: 1, buildTimeoutMs: 10000,
    create: () => ({ prepare: () => new Promise(() => {}), query: async x => x, stop: async () => {} })
  });
  const rejected = assert.rejects(lifecycle.query("synthetic-role", "value"), /STOPPED/);
  await lifecycle.stop();
  await rejected;
});
