import assert from "node:assert/strict";
import test from "node:test";
import { NapcatSupervisorService } from "./napcatSupervisorService.js";
import { napcatGuardianDepsFor } from "../messageEndpoints/napcatGuardian.js";

test("startup plugin waits for bound Route readiness before consuming its one automatic login run", async () => {
  const pluginUrl = new URL("../../plugins/builtin/io.rabiroute.manager.napcat-supervisor/1.0.0/manager.mjs", import.meta.url).href;
  const plugin = await import(pluginUrl);
  let runs = 0;
  const runtime = {
    NapcatSupervisorService, napcatGuardianDepsFor, managerReadOnly: false, managerShouldAutostart: true,
    managerListenerReady: true, routeCatalogReady: false, activeNapcatControlContext: {},
    startActiveNapcatSupervisor: () => {}, stopActiveNapcatSupervisor: async () => {},
    autoLoginNapcatInstancesOnRabiStart: async () => { runs++; },
    runNapcatGuardianLoop: async (_deps: unknown, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  };
  const starters: Array<() => Promise<() => Promise<void>>> = [];
  await plugin.activate({ identity: { instanceId: "supervisor-test" },
    services: { require: () => runtime, provide: () => {} },
    contributions: { register: () => {} }, effects: { add: (start: typeof starters[number]) => { starters.push(start); } }
  });
  const dispose = await starters[0]!();
  try {
    runtime.startActiveNapcatSupervisor();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs, 0);
    runtime.routeCatalogReady = true;
    runtime.startActiveNapcatSupervisor();
    runtime.startActiveNapcatSupervisor();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs, 1);
  } finally { await dispose(); }
});

test("startup plugin enters guardian even when startup login throws and never repeats startup on watcher recovery", async () => {
  const plugin = await import(new URL("../../plugins/builtin/io.rabiroute.manager.napcat-supervisor/1.0.0/manager.mjs", import.meta.url).href);
  let logins = 0; let guardians = 0; let configuredDelay: number | undefined;
  const runtime = {
    NapcatSupervisorService: class extends NapcatSupervisorService {
      constructor(options: ConstructorParameters<typeof NapcatSupervisorService>[0]) {
        configuredDelay = options.restartDelayMs;
        super({ ...options, waitBeforeRestart: async () => {} });
      }
    }, napcatGuardianDepsFor, managerReadOnly: false, managerShouldAutostart: true,
    managerListenerReady: true, routeCatalogReady: true, activeNapcatControlContext: {},
    startActiveNapcatSupervisor: () => {}, stopActiveNapcatSupervisor: async () => {},
    autoLoginNapcatInstancesOnRabiStart: async () => { logins++; throw new Error("fixture-startup-failure"); },
    runNapcatGuardianLoop: async (_deps: unknown, signal: AbortSignal) => {
      if (++guardians === 1) throw new Error("fixture-watcher-failure");
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  };
  const starters: Array<() => Promise<() => Promise<void>>> = [];
  await plugin.activate({ identity: { instanceId: "fixture" }, services: { require: () => runtime, provide: () => {} },
    contributions: { register: () => {} }, effects: { add: (start: typeof starters[number]) => starters.push(start) } });
  const dispose = await starters[0]!();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(configuredDelay, 30_000); assert.equal(logins, 1); assert.equal(guardians, 2);
  } finally { await dispose(); }
});

test("startup plugin keeps supervising after the one-shot login pass", async () => {
  // Regression: the plugin used to run only autoLoginNapcatInstancesOnRabiStart once, so an
  // instance that exited mid-run (napcat-1 at 12:44 on 2026-09-18) was never brought back.
  const pluginUrl = new URL("../../plugins/builtin/io.rabiroute.manager.napcat-supervisor/1.0.0/manager.mjs", import.meta.url).href;
  const plugin = await import(pluginUrl);
  let guardianRuns = 0;
  let observedSignal: AbortSignal | undefined;
  let guardianInstances: unknown[] = [];
  const logs: string[] = [];
  const runtime = {
    NapcatSupervisorService, napcatGuardianDepsFor, managerReadOnly: false, managerShouldAutostart: true,
    managerListenerReady: true, routeCatalogReady: true,
    activeNapcatControlContext: { marker: "ctx", getRuntimes: () => [{ definition: { id: "route-1" } }], appendLog: (_runtime: unknown, line: string) => { logs.push(line); } },
    startActiveNapcatSupervisor: () => {}, stopActiveNapcatSupervisor: async () => {},
    autoLoginNapcatInstancesOnRabiStart: async () => {},
    napcatGuardianInstances: (context: unknown) => {
      assert.equal(context, runtime.activeNapcatControlContext);
      return [{ gatewayId: "route-1", instanceId: "napcat-1" }];
    },
    observeNapcatGuardianInstance: async () => ({ state: "ready", healthy: true }),
    relaunchNapcatGuardianInstance: async () => ({ ok: true }),
    runNapcatGuardianLoop: async (deps: { listInstances: () => unknown[]; log: (message: string) => void }, signal: AbortSignal) => {
      deps.log("guardian mock recovery result");
      guardianRuns += 1;
      observedSignal = signal;
      guardianInstances = deps.listInstances();
      // Stand in for a long-lived supervisor that keeps watching until it is aborted.
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return 1;
    }
  };
  const starters: Array<() => Promise<() => Promise<void>>> = [];
  await plugin.activate({ identity: { instanceId: "supervisor-guardian-test" },
    services: { require: () => runtime, provide: () => {} },
    contributions: { register: () => {} }, effects: { add: (start: typeof starters[number]) => { starters.push(start); } }
  });
  const dispose = await starters[0]!();
  try {
    runtime.startActiveNapcatSupervisor();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(guardianRuns, 1, "the guardian loop must run after the startup pass");
    assert.equal(observedSignal?.aborted, false, "the guardian must stay active, not exit after one pass");
    assert.deepEqual(guardianInstances, [{ gatewayId: "route-1", instanceId: "napcat-1" }]);
    assert.deepEqual(logs, ["guardian mock recovery result"]);
  } finally {
    await dispose();
  }
  assert.equal(observedSignal?.aborted, true, "disposal must abort the guardian loop");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("NapCat supervisor deduplicates one activation run", async () => {
  const pending = deferred<string>();
  let runs = 0;
  const results: string[] = [];
  const service = new NapcatSupervisorService({
    run: () => {
      runs += 1;
      return pending.promise;
    },
    onResult: result => results.push(result)
  });

  const first = service.start();
  const second = service.start();
  assert.strictEqual(first, second);
  assert.equal(runs, 0);
  await Promise.resolve();
  assert.equal(runs, 1);

  pending.resolve("ready");
  await first;
  assert.deepEqual(results, ["ready"]);
});

test("NapCat supervisor stop aborts the active run, waits for it, and suppresses stale callbacks", async () => {
  const pending = deferred<string>();
  const results: string[] = [];
  const errors: string[] = [];
  let signal: AbortSignal | undefined;
  const service = new NapcatSupervisorService({
    run: currentSignal => {
      signal = currentSignal;
      return pending.promise;
    },
    onResult: result => results.push(result),
    onError: error => errors.push(String(error))
  });

  void service.start();
  await Promise.resolve();
  assert.equal(signal?.aborted, false);

  let stopped = false;
  const stop = service.stop().then(() => { stopped = true; });
  assert.equal(signal?.aborted, true);
  await Promise.resolve();
  assert.equal(stopped, false);

  pending.resolve("late");
  await stop;
  assert.equal(stopped, true);
  assert.deepEqual(results, []);
  assert.deepEqual(errors, []);
  assert.equal(service.isActive(), false);
});

test("NapCat supervisor can start a fresh generation after stop", async () => {
  const pending = [deferred<number>(), deferred<number>()];
  const results: number[] = [];
  const signals: AbortSignal[] = [];
  let runs = 0;
  const service = new NapcatSupervisorService({
    run: signal => {
      signals.push(signal);
      return pending[runs++]!.promise;
    },
    onResult: result => results.push(result)
  });

  const first = service.start();
  await Promise.resolve();
  pending[0]!.resolve(1);
  await first;
  await service.stop();

  const second = service.start();
  await Promise.resolve();
  pending[1]!.resolve(2);
  await second;

  assert.equal(runs, 2);
  assert.notStrictEqual(signals[0], signals[1]);
  assert.deepEqual(results, [1, 2]);
});

test("NapCat supervisor recovers failed loops after abortable backoff without another owner", async () => {
  let runs = 0;
  let releaseBackoff!: () => void;
  let releaseRun!: () => void;
  const errors: string[] = [];
  const service = new NapcatSupervisorService({
    restartDelayMs: 30_000,
    waitBeforeRestart: (_ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
      releaseBackoff = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
    run: async signal => {
      if (++runs === 1) throw new Error("fixture-loop-failure");
      await new Promise<void>(resolve => { releaseRun = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
    },
    onError: error => { errors.push((error as Error).message); }
  });
  const flight = service.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 1); assert.equal(service.isActive(), true);
  assert.strictEqual(service.start(), flight);
  assert.deepEqual(errors, ["fixture-loop-failure"]);
  releaseBackoff();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 2);
  await service.stop();
  releaseRun(); await flight;
  assert.equal(service.isActive(), false);
});

test("NapCat supervisor stop cancels pending restart instead of reviving disposed plugin", async () => {
  let runs = 0;
  const service = new NapcatSupervisorService({ restartDelayMs: 30_000,
    run: async () => { runs++; throw new Error("fixture"); } });
  const flight = service.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.isActive(), true);
  await service.stop(); await flight;
  assert.equal(runs, 1); assert.equal(service.isActive(), false);
});

test("NapCat supervisor reports active-generation failures", async () => {
  const errors: string[] = [];
  const service = new NapcatSupervisorService({
    run: async () => { throw new Error("login failed"); },
    onError: error => errors.push(error instanceof Error ? error.message : String(error))
  });

  await service.start();
  assert.deepEqual(errors, ["login failed"]);
  assert.equal(service.isActive(), false);
  await service.start();
  assert.deepEqual(errors, ["login failed", "login failed"]);
});
