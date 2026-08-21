import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import {
  ManagerPluginRouteRegistry,
  type ManagerPluginRouteDeclaration,
  type ManagerPluginRouteHandler
} from "./managerPluginRouteRegistry.js";

const request = { method: "GET" } as IncomingMessage;
const response = {} as ServerResponse;
const url = new URL("http://127.0.0.1/api/test");

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
