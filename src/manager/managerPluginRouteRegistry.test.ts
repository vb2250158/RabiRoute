import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { ManagerPluginRouteRegistry, type ManagerPluginRouteHandler } from "./managerPluginRouteRegistry.js";

const request = {} as IncomingMessage;
const response = {} as ServerResponse;
const url = new URL("http://127.0.0.1/api/test");

test("Manager plugin route registry dispatches handlers in registration order and stops when handled", () => {
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

  registry.register("manager:first", [handler("first-1", false), handler("first-2", false)]);
  registry.register("manager:second", [handler("second-1", true), handler("second-2", true)]);
  registry.register("manager:third", [handler("third-1", true)]);

  assert.equal(registry.handle(request, url, response), true);
  assert.deepEqual(calls, ["first-1", "first-2", "second-1"]);
});

test("Manager plugin route registry disposer removes only its registration batch", () => {
  const registry = new ManagerPluginRouteRegistry();
  const calls: string[] = [];
  const duplicate: ManagerPluginRouteHandler = () => {
    calls.push("duplicate");
    return false;
  };
  const disposeFirst = registry.register("manager:shared", [duplicate, duplicate]);
  registry.register("manager:shared", [() => {
    calls.push("second-batch");
    return true;
  }]);

  disposeFirst();
  disposeFirst();

  assert.equal(registry.handle(request, url, response), true);
  assert.deepEqual(calls, ["second-batch"]);
});

test("Manager plugin route registry rejects empty instance ids", () => {
  const registry = new ManagerPluginRouteRegistry();
  const handler: ManagerPluginRouteHandler = () => false;

  assert.throws(() => registry.register("", [handler]), /Manager plugin route instanceId is required/);
  assert.throws(() => registry.register("   ", [handler]), /Manager plugin route instanceId is required/);
});

test("Manager plugin route registry propagates handler errors and stops dispatch", () => {
  const registry = new ManagerPluginRouteRegistry();
  let laterCalled = false;
  const failure = new Error("route failed");
  registry.register("manager:failing", [() => {
    throw failure;
  }]);
  registry.register("manager:later", [() => {
    laterCalled = true;
    return true;
  }]);

  assert.throws(() => registry.handle(request, url, response), error => error === failure);
  assert.equal(laterCalled, false);
});

test("Manager plugin route registry snapshot exposes only instance ids and handler counts", () => {
  const registry = new ManagerPluginRouteRegistry();
  const sharedHandler: ManagerPluginRouteHandler = () => false;
  registry.register(" manager:first ", [sharedHandler, sharedHandler]);
  const disposeSecondBatch = registry.register("manager:first", [() => true]);
  registry.register("manager:second", []);

  assert.deepEqual(registry.snapshot(), [
    { instanceId: "manager:first", handlerCount: 3 },
    { instanceId: "manager:second", handlerCount: 0 }
  ]);
  assert.equal(JSON.stringify(registry.snapshot()).includes("sharedHandler"), false);

  disposeSecondBatch();
  assert.deepEqual(registry.snapshot(), [
    { instanceId: "manager:first", handlerCount: 2 },
    { instanceId: "manager:second", handlerCount: 0 }
  ]);
});

test("Manager plugin route registry keeps duplicate handlers in one batch", () => {
  const registry = new ManagerPluginRouteRegistry();
  let calls = 0;
  const duplicate: ManagerPluginRouteHandler = () => {
    calls += 1;
    return false;
  };
  registry.register("manager:duplicates", [duplicate, duplicate]);

  assert.equal(registry.handle(request, url, response), false);
  assert.equal(calls, 2);
});
