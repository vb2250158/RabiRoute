import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { CodexHookContextService, type CodexHookContextServiceOptions } from "./codexHookContext.js";
import { observeManagerHttpAbort } from "./managerHttpAbort.js";
import { createStopStageObserver } from "./hookProgressDiagnostics.js";
import { createManagerOperationalLog } from "./operationalLog.js";
import { createOperationContext, runWithOperationContext } from "../observability/dataMutationAudit.js";

test("stage diagnostics keep the active HTTP request identity without request content", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-hook-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = new Date("2026-10-29T00:00:00Z");
  const log = createManagerOperationalLog({ rootDir: root, now: () => now });
  const observe = createStopStageObserver(log);
  await runWithOperationContext(createOperationContext({ requestId: "http-1", source: "http", actor: { kind: "system" } }), async () => {
    await Promise.resolve();
    observe({ sessionId: "session-1", turnId: "turn-1", eventName: "Stop", lastAssistantMessage: "private reply" },
      { name: "completion-delivery", phase: "started", startMs: 12 });
  });
  await log.flush();
  const raw = fs.readFileSync(path.join(log.logDirectory, "manager-operations-2026-10-29.jsonl"), "utf8");
  const value = JSON.parse(raw.trim());
  assert.equal(value.requestId, "http-1");
  assert.deepEqual(value.hookProgress, { sessionId: "session-1", turnId: "turn-1", stage: "completion-delivery", phase: "started", startMs: 12 });
  assert.equal(raw.includes("private reply"), false);
});

test("Stop reports an awaiting stage before completion and records failure without swallowing it", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-hook-progress-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events: Array<Parameters<NonNullable<CodexHookContextServiceOptions["onHookStage"]>>[1]> = [];
  let entered!: () => void;
  let release!: () => void;
  const arrival = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const failure = new Error("completion unavailable");
  const service = new CodexHookContextService({
    rolesRoot: () => root, storePath: path.join(root, "sessions.json"),
    onHookStage: (request, stage) => { assert.equal(request.sessionId, "progress-session"); events.push(stage); },
    deliverAgentCompletion: async () => { entered(); await gate; throw failure; }
  });
  const pending = service.handleHook({ sessionId: "progress-session", eventName: "Stop", turnId: "turn-1" });
  await arrival;
  assert.equal(events.at(-1)?.name, "completion-delivery");
  assert.equal(events.at(-1)?.phase, "started");
  assert.equal(events.at(-1)?.durationMs, undefined);
  release();
  await assert.rejects(pending, error => error === failure);
  assert.equal(events.at(-1)?.phase, "failed");
  assert.ok(events.at(-1)!.durationMs! >= 0);
  assert.ok(events.some(event => event.name === "chat-history" && event.phase === "completed"));
  const before = events.length;
  await service.handleHook({ sessionId: "progress-session", eventName: "UserPromptSubmit" });
  assert.equal(events.length, before);
});

test("a diagnostic observer failure leaves the Stop result unchanged", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-hook-observer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new CodexHookContextService({ rolesRoot: () => root, storePath: path.join(root, "sessions.json"),
    onHookStage: () => { throw new Error("observer unavailable"); } });
  const result = await service.handleHook({ sessionId: "ordinary", eventName: "Stop", turnId: "turn-1" });
  assert.equal(result.planTaskCompletion?.reason, "no_enabled_plan_task_binding");
});

test("HTTP abort is reported once and normal completion is left to the finish listener", async t => {
  const aborted: string[] = [];
  const finished: string[] = [];
  let received!: () => void;
  let disconnected!: () => void;
  const arrival = new Promise<void>(resolve => { received = resolve; });
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const server = http.createServer((request, response) => {
    observeManagerHttpAbort(response, () => { aborted.push(request.url!); disconnected(); });
    response.once("finish", () => finished.push(request.url!));
    if (request.url === "/ok") response.end("ok");
    else received();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal(await (await fetch(base + "/ok")).text(), "ok");
  const request = http.get(base + "/pending");
  request.on("error", () => { /* The client intentionally aborts its pending request. */ });
  await arrival;
  request.destroy();
  await closed;
  assert.deepEqual(aborted, ["/pending"]);
  assert.deepEqual(finished, ["/ok"]);
});
