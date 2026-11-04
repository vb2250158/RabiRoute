import assert from "node:assert/strict";
import test from "node:test";
import { listRegisteredAgentAdapterManifests } from "./agentAdapter.js";
import { normalizeAgentAdapters, parseAgentAdapterType } from "./types.js";

test("no Agent is executable before its native plugin publication", async () => {
  const manifests = await listRegisteredAgentAdapterManifests();
  assert.deepEqual(manifests, []);
});

test("runtime parsing accepts canonical Agent ids while config migration is one-way", () => {
  assert.equal(parseAgentAdapterType("codex"), "codex");
  assert.equal(parseAgentAdapterType("codexDesktop"), null);
  assert.equal(parseAgentAdapterType("codexApp"), null);
  assert.deepEqual(normalizeAgentAdapters(["codexDesktop", "codexApp"]), ["codex"]);
});

test("Agent adapter facade reads the builtin Gateway root Registry", async () => {
  const { listRegisteredAgentAdapterManifests } = await import("./agentAdapter.js");
  const {
    AGENT_ADAPTER_REGISTRY_SERVICE,
    getBuiltinAgentAdapterRuntime
  } = await import("../runtime/agentAdapterRuntime.js");
  const { getBuiltinGatewayCordisRoot } = await import("../runtime/gatewayCordisRoot.js");
  const runtime = await getBuiltinAgentAdapterRuntime();
  const root = getBuiltinGatewayCordisRoot();

  assert.strictEqual(
    root.host.context.get(AGENT_ADAPTER_REGISTRY_SERVICE, true),
    runtime.registry
  );
  assert.deepEqual(await listRegisteredAgentAdapterManifests(), runtime.registry.listManifests());
});

test("Agent adapter facade follows a rebuilt Gateway root", async () => {
  const { getBuiltinGatewayCordisRoot } = await import("../runtime/gatewayCordisRoot.js");
  const first = await listRegisteredAgentAdapterManifests();
  assert.deepEqual(first, []);

  const firstRoot = getBuiltinGatewayCordisRoot();
  await firstRoot.dispose();

  const second = await listRegisteredAgentAdapterManifests();
  const secondRoot = getBuiltinGatewayCordisRoot();
  assert.deepEqual(second, []);
  assert.notStrictEqual(secondRoot, firstRoot);
  await secondRoot.dispose();
});

test("device factory dispatches original binding into the device mailbox rather than generic PC delivery", async () => {
  const { createDeviceAgentAdapter } = await import("./deviceAgentAdapter.js");
  const binding = { instanceId: "pc-owner", agentId: "device-stable" };
  const calls: Array<{ binding: unknown; method: string; path: string; body: any }> = [];
  const adapter = createDeviceAgentAdapter(binding, { request: async (selected, method, path, body) => {
    calls.push({ binding: selected, method, path, body });
    return { receipt: { ownerAccepted: true, status: "accepted" } };
  } });
  await adapter.deliver({ deliveryId: "original-delivery", messageSource: { type: "system", eventType: "fixture", eventName: "Fixture", eventId: "original-event" }, messageContent: "fixture message" });
  assert.equal(adapter.type, "deviceAgent");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].binding, binding);
  assert.equal(calls[0].path, "/api/device-agents/device-stable/deliveries");
  assert.equal(calls[0].body.deliveryId, "original-delivery");
});

test("unbound local device factory fails closed even when an isolated request is supplied", async () => {
  const { createDeviceAgentAdapter } = await import("./deviceAgentAdapter.js");
  let called = false;
  const adapter = createDeviceAgentAdapter(undefined, { request: async () => { called = true; throw new Error("unexpected request"); } });
  await assert.rejects(adapter.deliver({ deliveryId: "original-delivery", messageSource: { type: "system", eventType: "fixture", eventName: "Fixture", eventId: "event" }, messageContent: "fixture" }), /BINDING_REQUIRED/);
  assert.equal(called, false);
});
