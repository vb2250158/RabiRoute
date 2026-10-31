import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { runPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import type { PluginIdentity } from "../plugin-kernel/types.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";
import {
  ManagerPluginRouteRegistry,
  createManagerApiOperationsService,
  type ManagerPluginRouteDeclaration,
  type ManagerPluginRouteHandler
} from "./managerPluginRouteRegistry.js";

const request = { method: "GET" } as IncomingMessage;
const response = {} as ServerResponse;
const url = new URL("http://127.0.0.1/api/test");

function asynchronousOperation(index: number): ApiOperationDefinition {
  const base = fixtureApiContract();
  return { contract: { ...base, operationId: `fixture.async.${index}`, pathTemplate: `/api/async/${index}` },
    handler: () => ({ status: 200, body: { ok: true, value: index } }) };
}

test("async API preparation yields between operations and mounts one complete batch", async () => {
  const registry = new ManagerPluginRouteRegistry(), controller = new AbortController();
  const definitions = Array.from({ length: 8 }, (_, index) => asynchronousOperation(index));
  let turns = 0, finished = false;
  const heartbeat = () => {
    if (finished) return;
    turns++;
    assert.equal(registry.catalogSnapshot().operations.length, 0, "Preparation must not publish a partial batch.");
    setImmediate(heartbeat);
  };
  setImmediate(heartbeat);
  try {
    const registration = await registry.registerOperationsAsync("async", definitions, controller.signal);
    finished = true;
    assert.ok(turns >= definitions.length);
    assert.equal(registry.catalogSnapshot().operations.length, definitions.length);
    await registration.dispose();
    assert.equal(registry.catalogSnapshot().operations.length, 0);
  } finally { finished = true; }
});

test("async API registration cancels after preparation has started without mounting routes", async () => {
  const registry = new ManagerPluginRouteRegistry(), controller = new AbortController();
  let turns = 0, finished = false;
  const heartbeat = () => {
    if (finished) return;
    if (++turns === 2) controller.abort(new Error("fixture cancellation"));
    else setImmediate(heartbeat);
  };
  setImmediate(heartbeat);
  try {
    await assert.rejects(registry.registerOperationsAsync("async", Array.from({ length: 8 }, (_, index) => asynchronousOperation(index)), controller.signal), { name: "AbortError" });
    assert.equal(turns, 2);
    assert.equal(registry.catalogSnapshot().operations.length, 0);
  } finally { finished = true; }
});

test("async API registration rejects a later invalid schema atomically and captures inputs before yielding", async () => {
  const registry = new ManagerPluginRouteRegistry(), controller = new AbortController();
  const valid = asynchronousOperation(0), invalid = asynchronousOperation(1);
  const base = invalid.contract;
  const before = registry.catalogSnapshot();
  await assert.rejects(registry.registerOperationsAsync("async", [valid, { ...invalid, contract: { ...base,
    request: { ...base.request, query: { type: "invalid" } } } }], controller.signal));
  assert.equal(registry.catalogSnapshot(), before);
  const original = JSON.parse(JSON.stringify(valid.contract));
  const mutable = { contract: original, handler: valid.handler };
  const definitions = [mutable];
  const pending = registry.registerOperationsAsync("async", definitions, controller.signal);
  original.operationId = "fixture.changed";
  original.pathTemplate = "/api/changed";
  definitions.length = 0;
  const registration = await pending;
  const operation = registry.catalogSnapshot().operations[0]!;
  assert.equal(operation.contract.operationId, valid.contract.operationId);
  assert.equal(operation.contract.pathTemplate, valid.contract.pathTemplate);
  await registration.dispose();
});

test("async host facade retains the captured Manager activation across yields", async () => {
  const published = new Set(["live"]), registry = new ManagerPluginRouteRegistry(() => published);
  const service = createManagerApiOperationsService(registry), controller = new AbortController();
  assert.throws(() => service.registerOperationsAsync([asynchronousOperation(0)], controller.signal), /active Manager plugin context/);
  const identity: PluginIdentity = { applicationGenerationId: "generation", managerInstanceId: "manager", activationId: "live",
    instanceId: "manager:async", pluginId: "io.rabiroute.fixture", version: "1.0.0", revision: "fixture", host: "manager" };
  const registration = await runPluginActivation(identity, () => service.registerOperationsAsync([asynchronousOperation(0)], controller.signal));
  assert.equal(registry.snapshot()[0]!.instanceId, identity.instanceId);
  assert.equal(registry.catalogSnapshot().operations.length, 1);
  published.clear();
  assert.equal(registry.catalogSnapshot().operations.length, 0);
  await registration.dispose();
});

function exact(
  routeId: string,
  path: string,
  handler: ManagerPluginRouteHandler,
  methods: readonly string[] = ["GET"]
): ManagerPluginRouteDeclaration {
  return { routeId, match: { kind: "exact", path, methods }, handler };
}

test("Manager plugin route registry dispatches matching declarations in registration order", () => {
  const registry = new ManagerPluginRouteRegistry();
  const calls: string[] = [];
  const handler = (name: string, handled: boolean): ManagerPluginRouteHandler =>
    (actualRequest, actualUrl, actualResponse) => {
      assert.equal(actualRequest, request);
      assert.equal(actualUrl, url);
      assert.equal(actualResponse, response);
      calls.push(name);
      return handled;
    };

  registry.register("manager:first", [
    exact("first.miss", "/api/miss", handler("miss", true)),
    exact("first.test", "/api/test", handler("first", false))
  ]);
  registry.register("manager:second", [
    exact("second.test", "/api/test", handler("second", true), ["POST"]),
    {
      routeId: "second.dynamic",
      match: {
        kind: "dynamic",
        methods: ["GET"],
        description: "test query routes",
        test: (_request, actualUrl) => actualUrl.pathname === "/api/test"
      },
      handler: handler("dynamic", true)
    }
  ]);

  assert.equal(registry.handle(request, url, response), true);
  assert.deepEqual(calls, ["first", "dynamic"]);
});

test("Manager plugin route registry disposer removes only its registration batch", () => {
  const registry = new ManagerPluginRouteRegistry();
  const calls: string[] = [];
  const disposeFirst = registry.register("manager:shared", [
    exact("shared.first", "/api/first", () => {
      calls.push("first");
      return false;
    })
  ]);
  registry.register("manager:shared", [
    exact("shared.second", "/api/test", () => {
      calls.push("second");
      return true;
    })
  ]);

  disposeFirst();
  disposeFirst();

  assert.equal(registry.handle(request, url, response), true);
  assert.deepEqual(calls, ["second"]);
});

test("Manager plugin route registry preserves owner, video and peer batches from one activation", () => {
  const published = new Set(["live"]);
  const registry = new ManagerPluginRouteRegistry(() => published);
  const identity: PluginIdentity = {
    applicationGenerationId: "generation", managerInstanceId: "manager", activationId: "live",
    instanceId: "manager:rabilink-relay", pluginId: "io.rabiroute.manager.rabilink-relay",
    version: "1.0.0", revision: "fixture", host: "manager"
  };
  const calls: string[] = [];
  const registrations = ["owners", "video", "peer"].map(name => runPluginActivation(identity, () =>
    registry.register(identity.instanceId, [exact(name, "/api/" + name, () => { calls.push(name); return true; })])
  ));
  for (const name of ["owners", "video", "peer"]) {
    assert.equal(registry.handle(request, new URL("http://127.0.0.1/api/" + name), response), true);
  }
  assert.deepEqual(calls, ["owners", "video", "peer"]);
  assert.equal(registry.snapshot()[0]?.routeCount, 3);
  registrations[1]!();
  assert.equal(registry.handle(request, new URL("http://127.0.0.1/api/video"), response), false);
  assert.equal(registry.handle(request, new URL("http://127.0.0.1/api/owners"), response), true);
  assert.equal(registry.handle(request, new URL("http://127.0.0.1/api/peer"), response), true);
  assert.equal(registry.snapshot()[0]?.routeCount, 2);
});

test("Manager plugin route registry publishes complete new activation and isolates old or unpublished batches", () => {
  const published = new Set(["old"]);
  const registry = new ManagerPluginRouteRegistry(() => published);
  const base: PluginIdentity = {
    applicationGenerationId: "generation", managerInstanceId: "manager", activationId: "old",
    instanceId: "manager:test", pluginId: "io.rabiroute.test", version: "1.0.0",
    revision: "fixture", host: "manager"
  };
  const calls: string[] = [];
  const add = (activationId: string, route: string) => runPluginActivation({ ...base, activationId }, () =>
    registry.register(base.instanceId, [exact(route, "/api/" + route, () => { calls.push(activationId); return true; })])
  );
  const disposeOld = add("old", "shared");
  add("old", "old-only");
  add("new", "shared");
  add("new", "new-only");
  const invoke = (route: string) => registry.handle(request, new URL("http://127.0.0.1/api/" + route), response);
  assert.equal(invoke("shared"), true);
  assert.equal(invoke("new-only"), false);
  assert.deepEqual(calls, ["old"]);
  published.add("new");
  assert.equal(invoke("shared"), true);
  assert.equal(invoke("new-only"), true);
  assert.equal(invoke("old-only"), false);
  assert.deepEqual(calls, ["old", "new", "new"]);
  disposeOld();
  assert.equal(registry.snapshot()[0]?.routeCount, 2);
  published.delete("old");
  published.delete("new");
  assert.equal(invoke("shared"), false);
  assert.deepEqual(registry.snapshot(), []);
});

test("Manager plugin route registry rejects empty owners and route ids", () => {
  const registry = new ManagerPluginRouteRegistry();
  const handler: ManagerPluginRouteHandler = () => false;

  assert.throws(() => registry.register("", [exact("route", "/api/test", handler)]), /instanceId is required/);
  assert.throws(() => registry.register("manager:test", [exact("", "/api/test", handler)]), /routeId is required/);
});

test("Manager plugin route registry rejects duplicate route ids and overlapping exact method paths", () => {
  const registry = new ManagerPluginRouteRegistry();
  const handler: ManagerPluginRouteHandler = () => false;
  registry.register("manager:first", [exact("shared.route", "/api/first", handler)]);

  assert.throws(
    () => registry.register("manager:second", [exact("shared.route", "/api/second", handler)]),
    /routeId already registered/
  );
  assert.throws(
    () => registry.register("manager:second", [exact("second.route", "/api/first", handler)]),
    /routes overlap/
  );
  assert.doesNotThrow(() => registry.register(
    "manager:second",
    [exact("second.post", "/api/first", handler, ["POST"])]
  ));
});

test("Manager plugin route registry propagates handler errors and stops dispatch", () => {
  const registry = new ManagerPluginRouteRegistry();
  let laterCalled = false;
  const failure = new Error("route failed");
  registry.register("manager:failing", [
    exact("failing.api", "/api/test", () => {
      throw failure;
    })
  ]);
  registry.register("manager:later", [{
    routeId: "later.api",
    match: {
      kind: "dynamic",
      description: "later test route",
      methods: ["GET"],
      test: (_request, actualUrl) => actualUrl.pathname === "/api/test"
    },
    handler: () => {
      laterCalled = true;
      return true;
    }
  }]);

  assert.throws(() => registry.handle(request, url, response), error => error === failure);
  assert.equal(laterCalled, false);
});

test("Manager plugin route registry snapshot exposes sanitized route declarations", () => {
  const registry = new ManagerPluginRouteRegistry();
  registry.register(" manager:first ", [
    exact("first.status", "/api/status", () => false),
    {
      routeId: "first.dynamic",
      match: {
        kind: "dynamic",
        description: "persona document routes",
        methods: ["GET", "POST"],
        test: () => false
      },
      handler: () => false
    }
  ]);

  assert.deepEqual(registry.snapshot(), [{
    instanceId: "manager:first",
    routeCount: 2,
    routes: [
      {
        routeId: "first.status",
        match: { kind: "exact", methods: ["GET"], path: "/api/status" }
      },
      {
        routeId: "first.dynamic",
        match: {
          kind: "dynamic",
          methods: ["GET", "POST"],
          description: "persona document routes"
        }
      }
    ]
  }]);
  assert.equal(JSON.stringify(registry.snapshot()).includes("test"), false);
});


for (const invalidResult of [undefined, null, 23]) {
  test("invalid primitive API result " + String(invalidResult) + " releases its endpoint admission", { timeout: 5_000 }, async t => {
    const registry = new ManagerPluginRouteRegistry(undefined, undefined, { maximumActiveOperationsPerOperation: 1 });
    let invalid = true;
    const registration = registry.registerOperations("primitive-result", [{ contract: fixtureApiContract(),
      handler: () => invalid ? invalidResult as unknown as ApiOperationResult : { status: 200, body: { ok: true, value: 1 } } }]);
    const server = http.createServer((request, response) => registry.handle(request, new URL(request.url!, "http://localhost"), response));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      if (registration.activeOperationCount() === 0) await registration.dispose(); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const send = () => fetch("http://127.0.0.1:" + address.port + "/api/example/records/one", { method: "POST",
      headers: { "content-type": "application/json" }, body: '{"value":1}' });
    const rejected = await send(); assert.equal(rejected.status, 500); await rejected.arrayBuffer();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(registration.activeOperationCount(), 0, "A primitive cannot leave an unknown stream owner.");
    assert.deepEqual(registry.streamRetirementDiagnostics(), []);
    invalid = false; const healthy = await send(); assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { ok: true, value: 1 });
    await registration.dispose();
  });
}
