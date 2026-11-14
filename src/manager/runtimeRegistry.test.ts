import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { RuntimeRegistry, type GatewayRuntime } from "./runtimeRegistry.js";

function runtimeFor(id: string, log: string[] = []): GatewayRuntime {
  return {
    definition: { id } as GatewayDefinition,
    process: null,
    needsRestart: false,
    startedAt: null,
    stoppedAt: null,
    lastExit: null,
    readiness: "stopped",
    endpoints: [],
    lastError: null,
    log
  };
}

test("runtime registry forwards every appended line to the persistence hook", () => {
  const received: Array<[string, string]> = [];
  const registry = new RuntimeRegistry({ appendLine: (id, line) => received.push([id, line]) });
  const runtime = runtimeFor("gateway-1");
  registry.set("gateway-1", runtime);

  registry.appendLog(runtime, "first line");
  registry.appendLog(runtime, "second line");

  assert.equal(runtime.log.length, 2);
  assert.equal(received.length, 2);
  assert.equal(received[0]?.[0], "gateway-1");
  assert.match(received[0]?.[1] ?? "", /first line$/);
  assert.match(received[1]?.[1] ?? "", /second line$/);
});

test("runtime registry keeps the in-memory ring bounded while the hook still sees every line", () => {
  const received: string[] = [];
  const registry = new RuntimeRegistry({ appendLine: (_id, line) => received.push(line) });
  const runtime = runtimeFor("gateway-1");
  registry.set("gateway-1", runtime);

  for (let index = 0; index < 260; index += 1) registry.appendLog(runtime, `line-${index}`);

  assert.equal(runtime.log.length, 200);
  assert.equal(received.length, 260);
  assert.match(runtime.log[0] ?? "", /line-60$/);
});

test("a failing persistence hook never breaks runtime logging", () => {
  const registry = new RuntimeRegistry({ appendLine: () => { throw new Error("sink unavailable"); } });
  const runtime = runtimeFor("gateway-1");
  registry.set("gateway-1", runtime);

  assert.doesNotThrow(() => registry.appendLog(runtime, "still logged"));
  assert.equal(runtime.log.length, 1);
  assert.match(runtime.log[0] ?? "", /still logged$/);
});
