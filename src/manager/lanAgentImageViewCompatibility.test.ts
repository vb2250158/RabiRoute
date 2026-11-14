import assert from "node:assert/strict";
import test from "node:test";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { COMPUTER_IMAGE_VIEW_CAPABILITY } from "../../apps/rabi-agent/lib/computer-image-view.mjs";

/** The actual dispatcher uses an in-memory transport and its original pending-result path. */
function fixture(capabilities: string[] = []) {
  const registry = Object.create(LanAgentRegistry.prototype);
  const connection = { socket: {} };
  const sent: Array<Record<string, any>> = [];
  Object.assign(registry, {
    options: {}, localInstanceId: "local", nodes: new Map([["node", { computerCapabilities: capabilities }]]),
    connections: new Map([["node", connection]]), managementRequests: new Map(),
    getComputerSettingsRaw: () => ({}), requireConnection: () => connection, assertComputerFeature: () => {},
    send: (_socket: unknown, frame: Record<string, any>) => {
      sent.push(frame);
      const pending = registry.managementRequests.get(frame.requestId);
      clearTimeout(pending.timer);
      registry.managementRequests.delete(frame.requestId);
      pending.resolve({ state: "fixture-forwarded" });
    },
  });
  return { registry, sent };
}

const source = { frameId: "cached-frame", coordinateSpace: "capture", width: 1920, height: 1080, imageView: { width: 512, height: 288 } };
const input = { action: "input.execute", requestId: "original-input", controlSessionId: "original-session", source, actions: [{ type: "click", x: 256, y: 144 }] };

test("an old Node receives no scaled coordinate frame and the original request remains queryable", async () => {
  const f = fixture(["input", "screenshots", "annotation"]);
  assert.throws(() => f.registry.manageAgent("node", "computer", input, 1000), (error: any) => {
    assert.equal(error.code, "COMPUTER_IMAGE_VIEW_UNSUPPORTED");
    assert.equal(error.field, "source.imageView");
    assert.equal(error.requestId, input.requestId);
    assert.equal(error.deliveryFrameSent, false);
    assert.equal(error.mutationOutcome, undefined);
    assert.equal(error.uncertain, undefined);
    assert.match(error.nextAction, /input.status/);
    return true;
  });
  assert.equal(f.sent.length, 0);
  assert.equal(f.registry.managementRequests.size, 0);
  await f.registry.manageAgent("node", "computer", { action: "input.status", requestId: input.requestId }, 1000);
  assert.equal(f.sent[0]!.params.requestId, input.requestId);
});

test("the current format declaration forwards original input without coordinate rewriting", async () => {
  const f = fixture([COMPUTER_IMAGE_VIEW_CAPABILITY]);
  const result = await f.registry.manageAgent("node", "computer", input, 1000);
  assert.equal(result.state, "fixture-forwarded");
  assert.deepEqual(f.sent[0]!.params.source, source);
  assert.deepEqual(f.sent[0]!.params.actions, input.actions);
  assert.equal(f.sent[0]!.params.requestId, input.requestId);
});

test("legacy text, key, unpositioned wheel, equal-size and cleanup requests remain available", async () => {
  const f = fixture();
  const requests = [
    { ...input, actions: [{ type: "text", text: "fixture" }] },
    { ...input, actions: [{ type: "key", keys: ["Enter"] }] },
    { ...input, actions: [{ type: "scroll", deltaY: 1, y: 10 }] },
    { ...input, source: { ...source, imageView: { width: 1920, height: 1080 } } },
    { action: "screen.capture" }, { action: "file.stat", path: "fixture.txt" },
    { action: "input.cancel", requestId: input.requestId }, { action: "control.end", controlSessionId: input.controlSessionId },
  ];
  for (const body of requests) await f.registry.manageAgent("node", "computer", body, 1000);
  assert.equal(f.sent.length, requests.length);
});

test("local computer execution stays with its Native capability owner", async () => {
  const f = fixture();
  let calls = 0;
  f.registry.localComputer = { execute: async () => { calls++; return { state: "local" }; } };
  assert.equal((await f.registry.manageAgent("local", "computer", input, 1000)).state, "local");
  assert.equal(calls, 1);
  assert.equal(f.sent.length, 0);
});
