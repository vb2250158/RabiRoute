import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeGatewayRouteBootSnapshot } from "../shared/gatewayRouteSnapshotBoot.js";
import { EventEmitter } from "node:events";
import {
  ManagerGatewayRuntimeService,
  type ManagerGatewayRuntimeStore
} from "./managerGatewayRuntimeService.js";

type Definition = {
  id: string;
  revision: number;
};

type Runtime = {
  definition: Definition;
  needsRestart: boolean;
};

function runtime(id: string, revision = 1, needsRestart = false): Runtime {
  return {
    definition: { id, revision },
    needsRestart
  };
}

function serviceFixture(options: {
  definitions?: readonly Definition[];
  initial?: readonly Runtime[];
  running?: readonly string[];
  actions?: Readonly<Record<string, "none" | "start" | "stop" | "restart">>;
} = {}) {
  const runtimes = new Map((options.initial ?? []).map(item => [item.definition.id, item]));
  const running = new Set(options.running ?? []);
  const events: string[] = [];
  let definitions = [...(options.definitions ?? [])];

  const store: ManagerGatewayRuntimeStore<Runtime> = {
    get: id => runtimes.get(id),
    values: () => runtimes.values(),
    keys: () => runtimes.keys(),
    set(id, item) {
      events.push(`set:${id}`);
      runtimes.set(id, item);
    },
    delete(id) {
      events.push(`delete:${id}`);
      return runtimes.delete(id);
    }
  };

  const service = new ManagerGatewayRuntimeService<Definition, Runtime>(store, {
    loadDefinitions: () => definitions,
    normalizeDefinition: definition => ({ ...definition, id: definition.id.trim() }),
    definitionFingerprint: definition => `${definition.id}:${definition.revision}`,
    createRuntime(definition) {
      events.push(`create:${definition.id}`);
      return { definition, needsRestart: false };
    },
    isRunning: item => running.has(item.definition.id),
    reconcileAction: item => options.actions?.[item.definition.id] ?? "none",
    startRuntime(item) {
      events.push(`start:${item.definition.id}`);
      running.add(item.definition.id);
      item.needsRestart = false;
    },
    stopRuntime(item) {
      events.push(`stop:${item.definition.id}`);
      running.delete(item.definition.id);
    }
  });

  return {
    service,
    runtimes,
    running,
    events,
    setDefinitions(next: readonly Definition[]) {
      definitions = [...next];
    }
  };
}

test("load updates runtimes in definition order and stops removed runtimes before deletion", () => {
  const alpha = runtime("alpha", 1);
  const beta = runtime("beta", 1);
  const removed = runtime("removed", 1, true);
  const fixture = serviceFixture({
    initial: [alpha, beta, removed],
    running: ["removed"],
    definitions: [
      { id: " alpha ", revision: 1 },
      { id: "beta", revision: 2 },
      { id: "new", revision: 1 }
    ]
  });

  fixture.service.load();

  assert.deepEqual([...fixture.runtimes.keys()], ["alpha", "beta", "new"]);
  assert.strictEqual(fixture.runtimes.get("alpha"), alpha);
  assert.strictEqual(fixture.runtimes.get("beta"), beta);
  assert.equal(beta.definition.revision, 2);
  assert.equal(beta.needsRestart, true);
  assert.deepEqual(fixture.events, [
    "create:new",
    "set:new",
    "stop:removed",
    "delete:removed"
  ]);
  assert.equal(removed.needsRestart, false);

  fixture.events.length = 0;
  fixture.service.load();
  assert.deepEqual(fixture.events, []);
});

test("loadDefinitions applies asynchronously acquired definitions without reading them again", () => {
  const fixture = serviceFixture({
    definitions: [{ id: "callback-only", revision: 1 }]
  });

  fixture.service.loadDefinitions([{ id: " async ", revision: 2 }]);

  assert.deepEqual([...fixture.runtimes.keys()], ["async"]);
  assert.equal(fixture.runtimes.get("async")?.definition.revision, 2);
});

test("reconcile performs runtime actions sequentially in store order", () => {
  const fixture = serviceFixture({
    initial: [
      runtime("restart", 1, true),
      runtime("start"),
      runtime("stop"),
      runtime("none")
    ],
    running: ["restart", "stop"],
    actions: {
      restart: "restart",
      start: "start",
      stop: "stop",
      none: "none"
    }
  });

  fixture.service.reconcile();

  assert.deepEqual(fixture.events, [
    "stop:restart",
    "start:restart",
    "start:start",
    "stop:stop"
  ]);
});

test("start and stop are idempotent and reject missing IDs", () => {
  const fixture = serviceFixture({
    initial: [runtime("running"), runtime("stopped")],
    running: ["running"]
  });

  assert.equal(fixture.service.start("running"), false);
  assert.equal(fixture.service.stop("stopped"), false);
  assert.deepEqual(fixture.events, []);

  assert.equal(fixture.service.stop("running"), true);
  assert.equal(fixture.service.start("stopped"), true);
  assert.deepEqual(fixture.events, ["stop:running", "start:stopped"]);

  assert.throws(() => fixture.service.start("missing"), /Gateway runtime not found: missing/);
  assert.throws(() => fixture.service.stop("missing"), /Gateway runtime not found: missing/);
});

test("restart stops a running runtime before starting and starts a stopped runtime directly", () => {
  const runningRuntime = runtime("running", 1, true);
  const stoppedRuntime = runtime("stopped", 1, true);
  const fixture = serviceFixture({
    initial: [runningRuntime, stoppedRuntime],
    running: ["running"]
  });

  assert.equal(fixture.service.restart("running"), true);
  assert.equal(fixture.service.restart("stopped"), true);

  assert.deepEqual(fixture.events, [
    "stop:running",
    "start:running",
    "start:stopped"
  ]);
  assert.equal(runningRuntime.needsRestart, false);
  assert.equal(stoppedRuntime.needsRestart, false);
  assert.throws(() => fixture.service.restart("missing"), /Gateway runtime not found: missing/);
});

test("stopAll stops running runtimes sequentially and clears every restart request", () => {
  const first = runtime("first", 1, true);
  const stopped = runtime("stopped", 1, true);
  const last = runtime("last", 1, true);
  const fixture = serviceFixture({
    initial: [first, stopped, last],
    running: ["first", "last"]
  });

  fixture.service.stopAll();

  assert.deepEqual(fixture.events, ["stop:first", "stop:last"]);
  assert.equal(first.needsRestart, false);
  assert.equal(stopped.needsRestart, false);
  assert.equal(last.needsRestart, false);

  fixture.events.length = 0;
  fixture.service.stopAll();
  assert.deepEqual(fixture.events, []);
});

test("restartRuntime callback takes precedence and owns needsRestart state", () => {
  const managed = runtime("managed", 1, true);
  const runtimes = new Map([[managed.definition.id, managed]]);
  const events: string[] = [];

  const service = new ManagerGatewayRuntimeService<Definition, Runtime>(runtimes, {
    loadDefinitions: () => [],
    normalizeDefinition: definition => definition,
    definitionFingerprint: definition => `${definition.id}:${definition.revision}`,
    createRuntime: definition => ({ definition, needsRestart: false }),
    isRunning: () => true,
    reconcileAction: () => "restart",
    startRuntime: () => {
      events.push("generic:start");
    },
    stopRuntime: () => {
      events.push("generic:stop");
    },
    restartRuntime(item) {
      events.push(`restart:${item.definition.id}:needsRestart=${item.needsRestart}`);
      item.needsRestart = false;
    }
  });

  service.reconcile();

  assert.deepEqual(events, ["restart:managed:needsRestart=true"]);
  assert.equal(managed.needsRestart, false);
});

test("a real EEXIST boot snapshot failure is reported for its Route while the next Route starts; explicit start still throws", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-local-start-failure-"));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("gateway-local-start-failure-")); fs.rmSync(directory, { recursive: true, force: true }); });
  const badDataDir = path.join(directory, "bad-data");
  fs.writeFileSync(badDataDir, "original private data file");
  const definitions = [
    { id: "bad", gatewayPort: 23001, dataDir: badDataDir },
    { id: "good", gatewayPort: 23002, dataDir: path.join(directory, "good-data") }
  ];
  const records = new Map(definitions.map(definition => [definition.id, { definition, needsRestart: true }]));
  const started = new Set<string>(), failures: Array<{ id: string; error: unknown; action: string }> = [];
  const service = new ManagerGatewayRuntimeService(records, {
    loadDefinitions: () => definitions, normalizeDefinition: definition => definition, definitionFingerprint: JSON.stringify,
    createRuntime: definition => ({ definition, needsRestart: false }), isRunning: item => started.has(item.definition.id),
    reconcileAction: () => "start",
    startRuntime(item) { writeGatewayRouteBootSnapshot(item.definition.dataDir, item.definition.id, item.definition); started.add(item.definition.id); },
    stopRuntime() {}, onRuntimeError: (item, error, action) => { failures.push({ id: item.definition.id, error, action }); }
  });
  assert.doesNotThrow(() => service.reconcile());
  assert.deepEqual([...started], ["good"]);
  assert.equal(failures[0]?.id, "bad"); assert.equal(failures[0]?.action, "start");
  assert.equal((failures[0]?.error as NodeJS.ErrnoException).code, "EEXIST");
  assert.equal(fs.readFileSync(badDataDir, "utf8"), "original private data file");
  assert.equal(fs.existsSync(path.join(definitions[1]!.dataDir, "good.json")), true);
  assert.equal(records.get("bad")?.needsRestart, true, "failed start must not claim acceptance");
  assert.throws(() => service.start("bad"), { code: "EEXIST" });
  assert.equal(failures.length, 1, "explicit calls keep their original error instead of hiding it in collection reporting");
});

test("a failing error observer cannot prevent later runtime actions or erase the original failure", () => {
  const records = new Map([runtime("bad"), runtime("good")].map(item => [item.definition.id, item]));
  const original = new Error("original start failure"), observer = new Error("observer failure"), started: string[] = [];
  const service = new ManagerGatewayRuntimeService(records, {
    loadDefinitions: () => [], normalizeDefinition: item => item, definitionFingerprint: JSON.stringify,
    createRuntime: definition => ({ definition, needsRestart: false }), isRunning: () => false, reconcileAction: () => "start",
    startRuntime(item) { if (item.definition.id === "bad") throw original; started.push(item.definition.id); }, stopRuntime() {},
    onRuntimeError() { throw observer; }
  });
  assert.throws(() => service.reconcile(), (error: unknown) => error instanceof AggregateError && error.errors.includes(original) && error.errors.includes(observer));
  assert.deepEqual(started, ["good"]);
});

test("a collection without an error observer still attempts later Routes before reporting its failures", () => {
  const records = new Map([runtime("bad"), runtime("good")].map(item => [item.definition.id, item]));
  const original = new Error("unreported start failure"), started: string[] = [];
  const service = new ManagerGatewayRuntimeService(records, {
    loadDefinitions: () => [], normalizeDefinition: item => item, definitionFingerprint: JSON.stringify,
    createRuntime: definition => ({ definition, needsRestart: false }), isRunning: () => false, reconcileAction: () => "start",
    startRuntime(item) { if (item.definition.id === "bad") throw original; started.push(item.definition.id); }, stopRuntime() {}
  });
  assert.throws(() => service.reconcile(), (error: unknown) => error instanceof AggregateError && error.errors.includes(original));
  assert.deepEqual(started, ["good"]);
});

test("stopAll attempts healthy children after a failing stop and observer, preserves the live failed owner and reports aggregate failure", () => {
  const records = new Map([runtime("bad", 1, true), runtime("good", 1, true)].map(item => [item.definition.id, item]));
  const live = new Set(["bad", "good"]), attempted: string[] = [];
  const original = new Error("stop was not accepted"), observer = new Error("stop observer failed");
  const service = new ManagerGatewayRuntimeService(records, {
    loadDefinitions: () => [], normalizeDefinition: item => item, definitionFingerprint: JSON.stringify,
    createRuntime: definition => ({ definition, needsRestart: false }), isRunning: item => live.has(item.definition.id), reconcileAction: () => "none", startRuntime() {},
    stopRuntime(item) { attempted.push(item.definition.id); if (item.definition.id === "bad") throw original; live.delete(item.definition.id); },
    onRuntimeError() { throw observer; }
  });
  assert.throws(() => service.stopAll(), (error: unknown) => error instanceof AggregateError && error.errors.includes(original) && error.errors.includes(observer));
  assert.deepEqual(attempted, ["bad", "good"]); assert.deepEqual([...live], ["bad"]);
  assert.equal(records.has("bad"), true); assert.equal(records.get("bad")?.needsRestart, false); assert.equal(records.get("good")?.needsRestart, false);
});

test("a child-exit background restart contains real boot I/O and reporter failures without starting a manually stopped neighbor", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-exit-restart-failure-"));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("gateway-exit-restart-failure-")); fs.rmSync(directory, { recursive: true, force: true }); });
  const badPath = path.join(directory, "bad-data"); fs.writeFileSync(badPath, "original private file");
  const definitions = [{ id: "restarting", gatewayPort: 23001, dataDir: badPath }, { id: "manually-stopped", gatewayPort: 23002, dataDir: path.join(directory, "neighbor") }];
  const records = new Map(definitions.map(definition => [definition.id, { definition, needsRestart: false }]));
  const attempted: string[] = [], reporterFailure = new Error("Controlled background reporter failure");
  const service = new ManagerGatewayRuntimeService(records, {
    loadDefinitions: () => definitions, normalizeDefinition: item => item, definitionFingerprint: JSON.stringify,
    createRuntime: definition => ({ definition, needsRestart: false }), isRunning: () => false, reconcileAction: () => "start",
    startRuntime(item) { attempted.push(item.definition.id); writeGatewayRouteBootSnapshot(item.definition.dataDir, item.definition.id, item.definition); },
    stopRuntime() {}, onRuntimeError() { throw reporterFailure; }
  });
  const child = new EventEmitter();
  let failures: readonly unknown[] = [];
  child.on("exit", () => { failures = service.startInBackground("restarting"); });
  assert.doesNotThrow(() => child.emit("exit", 0, null));
  assert.equal((failures[0] as NodeJS.ErrnoException).code, "EEXIST");
  assert.equal(failures[1], reporterFailure);
  assert.deepEqual(attempted, ["restarting"]);
  assert.equal(fs.existsSync(definitions[1]!.dataDir), false);
  assert.equal(fs.readFileSync(badPath, "utf8"), "original private file");
  assert.throws(() => service.start("restarting"), { code: "EEXIST" });
  assert.throws(() => service.restart("restarting"), { code: "EEXIST" });
});
