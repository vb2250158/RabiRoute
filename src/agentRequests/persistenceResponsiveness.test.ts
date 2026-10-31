import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRequestStore, agentDeliveryPromptHash, type AgentRequestRecord } from "./store.js";
import { endpointExecutionOptionsHash } from "./executionOptions.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { createAgentCommunicationRecordOperations } from "../manager/agentCommunicationRecordOperations.js";

/** Entirely synthetic history: no runtime file, endpoint, credential or route is reused. */
export function syntheticAgentRequestState(deliveryCount = 370, reminderCount = 8) {
  const prompt = "Synthetic persisted delivery body. ".repeat(2048).slice(0, 65_536);
  const promptHash = agentDeliveryPromptHash(prompt), executionOptionsHash = endpointExecutionOptionsHash({});
  const endpoint = (sessionId: string) => ({ kind: "local" as const, managerInstanceId: "fixture-manager", agentId: "local:dsh",
    provider: "dsh", sessionId, authorizationIncarnation: "fixture-incarnation" });
  const source = endpoint("fixture-source"), target = endpoint("fixture-target");
  const party = (value: typeof source) => ({ endpoint: value, threadId: value.sessionId, agentAdapter: "dsh", agentType: "agent" });
  const timestamp = "2000-01-01T00:00:00.000Z";
  const deliveries = Object.fromEntries(Array.from({ length: deliveryCount }, (_, index) => {
    const deliveryId = `fixture-delivery-${index}`, generation = "fixture-generation";
    return [deliveryId, { deliveryId, generation, prompt, promptHash, executionOptions: {}, executionOptionsHash, source, target,
      state: "committed", preparation: { deliveryId, source: party(source), target: party(target), responsePolicy: "none" },
      receipt: { deliveryId, generation, promptHash, executionOptionsHash, endpoint: target, accepted: true, action: "started", transport: "fixture" },
      createdAt: timestamp, updatedAt: timestamp, attemptCount: 1 }];
  }));
  const requests: Record<string, AgentRequestRecord> = Object.fromEntries(Array.from({ length: reminderCount }, (_, index) => {
    const id = `fixture-request-${index}`;
    return [id, { id, deliveryId: `fixture-request-delivery-${index}`, status: "awaiting_response" as const,
      source: { threadId: "fixture-source", agentType: "agent" }, target: { threadId: "fixture-target", agentType: "agent" },
      responseInstruction: "Return the synthetic result.", createdAt: timestamp, updatedAt: timestamp,
      reminderCount: 0, nextReminderAt: timestamp }];
  }));
  return { version: 1, requests, deliveries };
}

for (const history of ["delivery prompts", "responded request results"] as const) test(`25MB ${history} initialization and overdue reminder burst keep independent HTTP health responsive`, { timeout: 45_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-agent-request-scale-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "agent-requests.json"), raw = syntheticAgentRequestState(history === "delivery prompts" ? 370 : 0);
  if (history === "responded request results") {
    const result = "Synthetic closed response. ".repeat(500).slice(0, 11_999) + ".";
    for (let index = 0; index < 2200; index++) {
      const id = `fixture-closed-request-${index}`, original = raw.requests["fixture-request-0"]!;
      raw.requests[id] = { ...original, id, deliveryId: `fixture-closed-delivery-${index}`, status: "responded", nextReminderAt: undefined,
        response: { deliveryId: `fixture-closed-response-${index}`, by: original.target, result, nextAction: "No further action.", respondedAt: original.updatedAt } };
    }
  }
  // Fixture generation precedes observation; no synchronous fixture encoding is mistaken for runtime work.
  await fs.writeFile(file, JSON.stringify(raw, null, 2));
  const bytes = (await fs.stat(file)).size;
  assert.ok(bytes > 24_000_000 && bytes < 30_000_000, `Unexpected representative fixture scale: ${bytes}`);
  const registry = new ManagerPluginRouteRegistry();
  let registration: Awaited<ReturnType<ManagerPluginRouteRegistry["registerOperationsAsync"]>> | undefined;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/plain" }); response.end("fixture-health"); }
    else if (!registry.handle(request, url, response)) { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const latencies: number[] = [], drifts: number[] = [], errors: unknown[] = [], inFlight = new Set<Promise<void>>();
  let stage = "server-ready"; const slowTicks: Array<{ stage: string; driftMs: number }> = []; let lastTick = performance.now();
  const interval = setInterval(() => {
    const now = performance.now(), driftMs = Math.max(0, now - lastTick - 20); drifts.push(driftMs); if (driftMs > 100) slowTicks.push({ stage, driftMs }); lastTick = now;
    if (inFlight.size) return;
    const requestStage = stage; const startedAt = performance.now();
    const request = fetch(base, { signal: AbortSignal.timeout(1500) }).then(async response => {
      assert.equal(response.status, 200); assert.equal(await response.text(), "fixture-health");
      latencies.push(performance.now() - startedAt);
    }).catch(error => { errors.push({ requestStage, errorStage: stage, elapsedMs: performance.now() - startedAt, name: error?.name, message: error?.message, cause: error?.cause ? { name: error.cause.name, message: error.cause.message, code: error.cause.code } : undefined }); }).finally(() => { inFlight.delete(request); });
    inFlight.add(request);
  }, 20);
  const store = new AgentRequestStore(file, undefined, { timeoutMs: 10_000 });
  let loadMs = 0, singleCommitMs = 0, burstMs = 0, fullRequestListMs = 0, registryReadMs = 0, apiText: string | undefined;
  try {
    stage = "load"; const loading = performance.now(); await store.ready(); loadMs = performance.now() - loading;
    stage = "sync-list"; const listing = performance.now(), records = store.list(); fullRequestListMs = performance.now() - listing;
    assert.equal(records.length, history === "delivery prompts" ? 8 : 2208);
    const due = store.dueReminders(); assert.equal(due.length, 8);
    stage = "single-write"; const first = performance.now(); await store.recordReminderResult(due[0]!.id, false, "Synthetic target unavailable."); singleCommitMs = performance.now() - first;
    stage = "burst"; const burst = performance.now();
    await Promise.all(due.slice(1).map(record => store.recordReminderResult(record.id, false, "Synthetic target unavailable.")));
    burstMs = performance.now() - burst;
    if (history === "delivery prompts") {
      assert.equal(Object.hasOwn(store.getEndpointDelivery("fixture-delivery-0")!, "prompt"), false);
      assert.equal((await store.readEndpointDelivery("fixture-delivery-0"))!.prompt, raw.deliveries["fixture-delivery-0"]!.prompt);
    } else assert.equal(store.get("fixture-closed-request-2199")!.response!.result, raw.requests["fixture-closed-request-2199"]!.response!.result);
    if (history === "responded request results") {
      stage = "registration"; registration = await registry.registerOperationsAsync("fixture-agent-requests", createAgentCommunicationRecordOperations({
        agentRequests: store, refreshAgentRequestReminderTimers() {}, publishManagerEvent() {}, findSendTraces: () => []
      }), new AbortController().signal);
      // Use the real public definition and its ordinary 100ms synchronous guard.
      stage = "registry-read"; const reading = performance.now();
      const response = await fetch(base + "/api/agent/requests", { signal: AbortSignal.timeout(30_000) });
      apiText = await response.text(); registryReadMs = performance.now() - reading;
      assert.equal(response.status, 200, `Actual Registry request failed: ${apiText.slice(0, 300)}`);
      const filtered = await fetch(base + "/api/agent/requests?status=awaiting_response", { signal: AbortSignal.timeout(30_000) });
      assert.equal(filtered.status, 200);
      assert.equal((await filtered.json()).data.requests.length, 8);
    }
    stage = "store-close"; await store.close();
  } finally {
    stage = "cleanup"; clearInterval(interval);
    // Drain observed requests before closing their server, including requests not yet parsed on a reused connection.
    await Promise.allSettled([...inFlight]);
    const cleanup = await Promise.allSettled([registration?.dispose(), store.close(),
      new Promise<void>(resolve => server.close(() => resolve()))]);
    const failures = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Synthetic persistence fixture cleanup failed.");
  }
  try {
    const persisted = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(Object.keys(persisted.deliveries).length, history === "delivery prompts" ? 370 : 0);
    assert.deepEqual(persisted.deliveries, raw.deliveries);
    for (const record of Object.values(persisted.requests) as Array<{ status: string; reminderCount: number; lastReminderError: string; nextReminderAt: string }>) {
      if (record.status === "responded") continue;
      assert.equal(record.reminderCount, 1); assert.equal(record.lastReminderError, "Synthetic target unavailable.");
      assert.ok(Date.parse(record.nextReminderAt) > Date.now() - 1000);
    }
    t.diagnostic(JSON.stringify({ history, errors, slowTicks, loadMs, fullRequestListMs, singleCommitMs, burstMs, registryReadMs })); assert.equal(errors.length, 0, JSON.stringify(errors)); assert.ok(latencies.length >= 5);
    assert.ok(Math.max(...latencies) < 500, `Independent health latency exceeded 500ms: ${Math.max(...latencies)}`);
    assert.ok(Math.max(...drifts) < 500, `Main event loop stalled: ${Math.max(...drifts)}`);
    if (history === "responded request results") for (let index = 0; index < 2200; index++) {
      const id = `fixture-closed-request-${index}`;
      assert.deepEqual(persisted.requests[id].response, raw.requests[id]!.response);
    }
    if (apiText !== undefined) {
      const received = JSON.parse(apiText).data.requests as AgentRequestRecord[];
      assert.equal(received.length, 2208);
      for (const record of received) assert.deepEqual(record, persisted.requests[record.id]);
    }
    t.diagnostic(JSON.stringify({ history, fixtureBytes: bytes, deliveries: Object.keys(raw.deliveries).length, reminderCommits: 8, loadMs, fullRequestListMs, singleCommitMs, burstMs,
      registryReadMs, apiResponseBytes: apiText === undefined ? 0 : Buffer.byteLength(apiText),
      healthSamples: latencies.length, healthMaximumMs: Math.max(...latencies), loopMaximumDriftMs: Math.max(...drifts) }));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
