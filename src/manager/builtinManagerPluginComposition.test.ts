import assert from "node:assert/strict";
import test from "node:test";
import { RabiCordisHost, type RabiCordisContext } from "../runtime/cordisHost.js";
import {
  mountManagerPluginRuntime,
  type ManagerPluginDefinition
} from "../runtime/managerPluginRuntime.js";
import {
  composeBuiltinManagerPluginDefinitions,
  type BuiltinManagerPluginApplyHook
} from "./builtinManagerPluginComposition.js";

function definition(
  instanceId: string,
  apply?: (ctx: RabiCordisContext) => void | Promise<void>
): ManagerPluginDefinition {
  return {
    instanceId,
    manifest: {
      id: `builtin:${instanceId}`,
      name: instanceId,
      version: "1.0.0",
      kind: "builtin",
      hosts: ["manager"],
      capabilities: ["manager.test"]
    },
    scope: "global",
    contributions: [],
    apply
  };
}

test("composition preserves definition order and declarative contracts", () => {
  const core = definition("manager:core");
  const desktop: ManagerPluginDefinition = {
    ...definition("manager:desktop"),
    missingCapabilities: ["optional.test"]
  };
  const hook: BuiltinManagerPluginApplyHook = () => {};

  const composed = composeBuiltinManagerPluginDefinitions(
    [core, desktop],
    { "manager:desktop": hook }
  );

  assert.deepEqual(composed.map(item => item.instanceId), ["manager:core", "manager:desktop"]);
  assert.strictEqual(composed[0], core);
  assert.notStrictEqual(composed[1], desktop);
  assert.strictEqual(composed[1]?.manifest, desktop.manifest);
  assert.strictEqual(composed[1]?.contributions, desktop.contributions);
  assert.strictEqual(composed[1]?.missingCapabilities, desktop.missingCapabilities);
  assert.equal(composed[1]?.scope, desktop.scope);
});

test("composition runs original apply before hook on the same Fiber", async () => {
  const host = new RabiCordisHost();
  const lifecycle: string[] = [];
  let originalFiber: unknown;
  let hookFiber: unknown;

  const original = definition("manager:desktop", async ctx => {
    originalFiber = ctx.fiber;
    lifecycle.push("original:start");
    await Promise.resolve();
    lifecycle.push("original:ready");
    ctx.effect(() => {
      lifecycle.push("original:effect");
      return () => {
        lifecycle.push("original:dispose");
      };
    });
  });

  const composed = composeBuiltinManagerPluginDefinitions([original], {
    "manager:desktop": ctx => {
      hookFiber = ctx.fiber;
      lifecycle.push("hook:start");
      ctx.effect(() => {
        lifecycle.push("hook:effect");
        return () => {
          lifecycle.push("hook:dispose");
        };
      });
    }
  });

  const runtime = await mountManagerPluginRuntime(host, composed);
  const pluginFiber = runtime.plugins.get("manager:desktop")?.fiber;

  assert.strictEqual(originalFiber, hookFiber);
  assert.strictEqual(originalFiber, pluginFiber);
  assert.deepEqual(lifecycle, [
    "original:start",
    "original:ready",
    "original:effect",
    "hook:start",
    "hook:effect"
  ]);

  await runtime.plugins.get("manager:desktop")?.unmount();
  assert.deepEqual(lifecycle.slice(-2), ["hook:dispose", "original:dispose"]);
  await runtime.unmount();
  await host.dispose();
});

test("composition rejects hooks for unknown plugin instances immediately", () => {
  let hookCalls = 0;

  assert.throws(
    () => composeBuiltinManagerPluginDefinitions(
      [definition("manager:core")],
      {
        "manager:unknown": () => {
          hookCalls += 1;
        }
      }
    ),
    /Unknown built-in Manager plugin apply hook: manager:unknown/
  );
  assert.equal(hookCalls, 0);
});
