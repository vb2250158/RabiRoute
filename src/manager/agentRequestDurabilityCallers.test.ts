import assert from "node:assert/strict";
import http from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { cancelAgentRequest, readAgentRequest, readAgentRequests } from "./agentCommunicationRecordOperations.js";
import type { AgentCommunicationRoutesContext } from "./agentCommunicationRoutes.js";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginModule } from "../plugin-kernel/types.js";
import { preparedApiJson } from "./apiPreparedJson.js";
import { createAgentCommunicationRecordOperations } from "./agentCommunicationRecordOperations.js";

type RecordContext = Pick<AgentCommunicationRoutesContext, "agentRequests" | "refreshAgentRequestReminderTimers" | "publishManagerEvent" | "findSendTraces">;

test("public request reads await the complete owner result and preserve all fields through the original status filter", async () => {
  let complete!: (records: unknown[]) => void;
  const pending = new Promise<unknown[]>(resolve => { complete = resolve; });
  const context = { agentRequests: { readRequests: () => pending, list() { assert.fail("Public reads cannot clone the synchronous full history."); } } } as unknown as RecordContext;
  let replied = false;
  const reading = readAgentRequests(new URL("http://fixture.invalid/api/agent/requests?status=responded"), context).then(result => { replied = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(replied, false);
  const records = [{ id: "returned", status: "responded", response: { result: "Full original response ".repeat(1000), nextAction: "continue" }, legacyField: { keep: true } },
    { id: "pending", status: "awaiting_response" }];
  complete(records);
  const result = await reading;
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { code: 0, data: { requests: [records[0]] } });
  assert.deepEqual(JSON.parse(preparedApiJson(result.body)!), result.body);
  assert.equal(Object.isFrozen(result.body), true);
  assert.equal(Object.isFrozen(records[0]), false);
});

test("request cancellation reports success and publishes changes only after durable completion", async () => {
  let complete!: (value: unknown) => void;
  const pending = new Promise(resolve => { complete = resolve; });
  const events: string[] = [];
  const context = { agentRequests: { cancel: () => pending }, refreshAgentRequestReminderTimers: () => events.push("refresh"),
    publishManagerEvent: () => events.push("published") } as unknown as RecordContext;
  let replied = false;
  const cancellation = cancelAgentRequest("request", {}, context).then(value => { replied = true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(replied, false); assert.deepEqual(events, []);
  complete({ id: "request", status: "cancelled" });
  assert.equal((await cancellation).status, 200);
  assert.deepEqual(events, ["refresh", "published"]);
});

test("a committed cancellation remains confirmed when reminder refresh and change observers fail", async () => {
  const record = { id: "original-request", status: "cancelled" };
  let committed = false, refreshes = 0, events = 0;
  const context = { agentRequests: { cancel: async () => { committed = true; return record; } },
    refreshAgentRequestReminderTimers: () => { refreshes++; throw Object.assign(new Error("Owner now unavailable."), { code: "AGENT_REQUEST_STORE_UNAVAILABLE" }); },
    publishManagerEvent: () => { events++; throw new Error("Observer failed."); } } as unknown as RecordContext;
  const operation = createAgentCommunicationRecordOperations(context).find(value => value.contract.operationId === "agent.requests.cancel")!;
  const request = new http.IncomingMessage(new Socket());
  const result = await operation.handler({ request, response: new http.ServerResponse(request),
    url: new URL("http://fixture.invalid/api/agent/requests/original-request/cancel"), query: {}, path: { requestId: record.id }, body: {} });
  assert.equal(committed, true); assert.equal(refreshes, 1); assert.equal(events, 1);
  assert.equal(result.status, 200); assert.deepEqual(result.body, { code: 0, data: record });
  assert.equal(result.mutationOutcome, undefined);
});

test("asynchronously rejected cancellation observers cannot reject its durable result or escape unhandled", async () => {
  let refreshes = 0, events = 0;
  const record = { id: "original-request", status: "cancelled" };
  const context = { agentRequests: { cancel: async () => record },
    refreshAgentRequestReminderTimers: async () => { refreshes++; throw new Error("Async refresh failed."); },
    publishManagerEvent: async () => { events++; throw new Error("Async observer failed."); } } as unknown as RecordContext;
  const result = await cancelAgentRequest(record.id, {}, context);
  assert.equal(result.status, 200); assert.deepEqual(result.body, { code: 0, data: record });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1); assert.equal(events, 1);
});

test("an unavailable request store returns a local 503 without reporting absence or a cancellation event", async () => {
  const error = Object.assign(new Error("Request store owner is unavailable."), { code: "AGENT_REQUEST_STORE_UNAVAILABLE", statusCode: 503 });
  let events = 0;
  const context = { agentRequests: { readRequests: async () => { throw error; }, get() { throw error; }, cancel: async () => { throw error; } },
    refreshAgentRequestReminderTimers: () => { events++; }, publishManagerEvent: () => { events++; } } as unknown as RecordContext;
  assert.equal((await readAgentRequests(new URL("http://fixture.invalid/api/agent/requests"), context)).status, 503);
  assert.equal(readAgentRequest("request", context).status, 503);
  assert.equal((await cancelAgentRequest("request", {}, context)).status, 503);
  assert.equal(events, 0);
});

test("a cancellation acknowledgement lost by the owner remains explicitly unknown", async () => {
  const error = Object.assign(new Error("Commit acknowledgement was lost."), { code: "AGENT_REQUEST_COMMIT_UNKNOWN", statusCode: 503, commitState: "unknown", retryable: false });
  let events = 0;
  const context = { agentRequests: { cancel: async () => { throw error; } },
    refreshAgentRequestReminderTimers: () => { events++; }, publishManagerEvent: () => { events++; } } as unknown as RecordContext;
  const result = await cancelAgentRequest("request", {}, context);
  assert.equal(result.status, 503); assert.equal(result.mutationOutcome, "unknown");
  assert.deepEqual(result.body, { code: -1, message: error.message, errorCode: error.code, commitState: "unknown", uncertain: true, retryable: false });
  assert.equal(events, 0);
});

async function automationFixture(ready: Promise<void>, failure?: (error: unknown) => void) {
  const module = await import(new URL("../../plugins/builtin/io.rabiroute.manager.message-processing-automation/1.0.0/manager.mjs", import.meta.url).href) as PluginModule;
  let started = 0, stopped = 0, announce!: () => void;
  const startedSignal = new Promise<void>(resolve => { announce = resolve; });
  const host: Record<string, unknown> = { managerReadOnly: false, agentRequests: { ready: () => ready, list: () => [], get: () => undefined },
    MessageProcessingAutomationService: class { start() { started++; announce(); } async stop() { stopped++; } },
    KnowledgeCallbackReminderService: class { async start() {} async stop() {} },
    messageProcessingBoard: { list: () => [], getRequirement: () => undefined, pendingKnowledgeMatches: () => [] },
    subscribePlanUpdates: () => () => {}, managerOperationalLog: { record() {} }, managerOperationalError: () => "fixture failure", rootDir: "fixture" };
  const runtime = new GenerationRuntime({ host: "manager", activationTimeoutMs: 50,
    executor: { async prepare() { return module; } }, onRuntimeFailure: event => failure?.(event.error),
    hostServices: [{ capability: "host.manager.message-processing-automation@1", value: host }] });
  const candidate: PluginCandidate = { instanceId: "automation", revision: "one", config: {}, entry: { execution: "in_process", path: "fixture.mjs" },
    manifest: { schemaVersion: 2, id: "io.test.automation", version: "1.0.0", permissions: [], optional: [],
      provides: ["manager.message-processing-automation@1"], requires: ["host.manager.message-processing-automation@1"],
      entries: { manager: { execution: "in_process", module: "./manager.mjs" } } } };
  return { runtime, candidate, startedSignal, started: () => started, stopped: () => stopped };
}

test("automation readiness does not occupy publication or start after its activation retires", async () => {
  let ready!: () => void;
  const storeReady = new Promise<void>(resolve => { ready = resolve; });
  const fixture = await automationFixture(storeReady);
  await fixture.runtime.switch([fixture.candidate]);
  assert.equal(fixture.started(), 0);
  assert.equal(await fixture.runtime.publishSourcePatch(fixture.runtime.current().id, async () => "independent source publication"), "independent source publication");
  await fixture.runtime.dispose();
  ready(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(fixture.started(), 0);
  assert.equal(fixture.stopped(), 1);
});

test("automation starts after store readiness and retains its actual cleanup owner", async () => {
  let ready!: () => void;
  const fixture = await automationFixture(new Promise<void>(resolve => { ready = resolve; }));
  await fixture.runtime.switch([fixture.candidate]); assert.equal(fixture.started(), 0);
  ready(); await fixture.startedSignal;
  assert.equal(fixture.started(), 1);
  await fixture.runtime.dispose(); assert.equal(fixture.stopped(), 1);
});

test("a failed store readiness task fails only its published automation activation", async () => {
  let reject!: (error: unknown) => void, failed!: () => void;
  const failure = new Promise<void>(resolve => { failed = resolve; });
  const fixture = await automationFixture(new Promise<void>((_resolve, fail) => { reject = fail; }), () => failed());
  await fixture.runtime.switch([fixture.candidate]);
  reject(new Error("Owned request store loader failed.")); await failure;
  assert.equal(fixture.runtime.current().records.find(record => record.identity.instanceId === "automation")?.status, "failed");
  assert.equal(fixture.started(), 0);
  await fixture.runtime.dispose();
});
