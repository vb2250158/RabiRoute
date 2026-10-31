import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  KnowledgeRecallMatch,
  MessageProcessingRequirement,
  RegisterMessageGroupRequirementInput
} from "../messageProcessing/board.js";
import {
  type MessageProcessingApiContext
} from "./messageProcessingRoutes.js";

import { createMessageProcessingOperations } from "./messageProcessingOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { MessageProcessingBoardStore } from "../messageProcessing/board.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

type RecordedCall = { name: string; args: unknown[] };

function requirement(
  id: string,
  status: MessageProcessingRequirement["status"] = "processing"
): MessageProcessingRequirement {
  return {
    id,
    dedupeKey: `dedupe:${id}`,
    kind: "message_reply",
    replyPolicy: "required",
    status,
    source: {
      routeId: "route-1",
      roleId: "Rabi",
      endpoint: "qq",
      conversationKey: "group:1",
      sender: "user-1",
      routeKinds: ["group_message"],
      messageIds: ["message-1"]
    },
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    dueAt: "2026-08-21T00:10:00.000Z"
  };
}

function createFixture() {
  const calls: RecordedCall[] = [];
  const requirements = new Map<string, MessageProcessingRequirement>([
    ["req/1", requirement("req/1")],
    ["req-outcome", requirement("req-outcome", "processing")],
    ["req-callback", {
      ...requirement("req-callback", "sent"),
      knowledgeMatches: [{
        id: "memory-old",
        title: "Old memory",
        type: "recent_memory",
        endpoint: "/memories/memory-old",
        score: 1,
        revisionAt: "2026-08-20T00:00:00.000Z"
      }]
    }]
  ]);
  const remember = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const updated = (id: string, status: MessageProcessingRequirement["status"]) => ({
    ...(requirements.get(id) ?? requirement(id)),
    status,
    updatedAt: "2026-08-21T01:00:00.000Z"
  });
  const context: MessageProcessingApiContext = {
    boardPayload: async (routeId, limit) => {
      remember("boardPayload", routeId, limit);
      return { routeId, limit, items: [...requirements.values()] };
    },
    board: {
      getRequirement: (id) => requirements.get(id),
      registerMessageGroup: (input) => {
        remember("registerMessageGroup", input);
        const item = requirement(input.requirementId, "pending_dispatch");
        requirements.set(item.id, item);
        return { outcome: "created" as const, requirement: item };
      },
      recordDispatch: (id, worker) => {
        remember("recordDispatch", id, worker);
        const item = { ...updated(id, "processing"), worker };
        requirements.set(id, item);
        return item;
      },
      recordDispatchFailure: (id, error) => {
        remember("recordDispatchFailure", id, error);
        const item = { ...updated(id, "send_failed"), lastError: error };
        requirements.set(id, item);
        return item;
      },
      submitOutcome: (id, input) => {
        remember("submitOutcome", id, input);
        const item = updated(id, "awaiting_send");
        requirements.set(id, item);
        return item;
      },
      recordKnowledgeCallback: (id, input) => {
        remember("recordKnowledgeCallback", id, input);
        const item = updated(id, "sent");
        requirements.set(id, item);
        return item;
      }
    },
    sendContextReview: {
      snapshot: async (id, sourceMessageId) => {
        remember("snapshot", id, sourceMessageId);
        if (id === "bad") throw new Error("snapshot failed");
        return { requirementId: id, sourceMessageId, requirementStatus: "processing", contextVersion: "fixture-context", contextItems: [], requiredReviewIds: [], alreadyReplied: false, priorReplies: [] };
      },
      approve: async (id, input) => {
        remember("approve", id, input);
        return {
          sendContextReviewToken: "review-token",
          expiresAt: "2026-08-21T02:00:00.000Z"
        };
      }
    },
    operationalLog: {
      record: (level, event, details) => {
        remember("log", level, event, details);
        return null;
      }
    },
    recallKnowledge: (source: RegisterMessageGroupRequirementInput["source"]): KnowledgeRecallMatch[] => {
      remember("recallKnowledge", source);
      return [{
        id: "plan-1",
        title: "Plan",
        type: "plan",
        endpoint: "/plans/plan-1",
        score: 0.9,
        revisionAt: "2026-08-20T00:00:00.000Z"
      }];
    },
    verifyCriticalFactRecord: (input) => { remember("verify", input); },
    setPlanBaseline: (item, roleId, planId) => remember("baseline", item, roleId, planId),
    scheduleKnowledgeCallbackReminder: (item) => remember("schedule", item),
    publishEvent: (eventType, data) => remember("event", eventType, data),

  };
  return { calls, context };
}

async function startServer(context: MessageProcessingApiContext) {
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("message-processing-test", createMessageProcessingOperations(context));
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") { response.end("ready"); return; }
    if (registry.handle(request, url, response)) return;
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ fallback: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    registry, registration,
    close: async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  };
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

async function post(baseUrl: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("serves board and requirement queries, including requirement 404", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const boardResponse = await fetch(`${app.baseUrl}/api/message-processing/board?routeId=route-1&limit=25`);
    assert.equal(boardResponse.status, 200);
    assert.equal((await json(boardResponse)).data.limit, 25);
    assert.deepEqual(fixture.calls[0], { name: "boardPayload", args: ["route-1", 25] });

    const found = await fetch(`${app.baseUrl}/api/message-processing/requirements/req%2F1`);
    assert.equal(found.status, 200);
    assert.equal((await json(found)).data.id, "req/1");

    const missing = await fetch(`${app.baseUrl}/api/message-processing/requirements/missing`);
    assert.equal(missing.status, 404);
    assert.equal((await json(missing)).message, "Message processing requirement not found: missing");
  } finally {
    await app.close();
  }
});

test("serves and approves send-context reviews", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const snapshot = await fetch(
      `${app.baseUrl}/api/message-processing/requirements/req-outcome/send-context?sourceMessageId=message-1`
    );
    assert.equal(snapshot.status, 200);
    assert.deepEqual(fixture.calls.find((call) => call.name === "snapshot")?.args, ["req-outcome", "message-1"]);

    const approved = await post(
      app.baseUrl,
      "/api/message-processing/requirements/req-outcome/send-context",
      { reviewedByThreadId: "thread-1", sendRequest: { text: "reply" } }
    );
    assert.equal(approved.status, 200);
    assert.equal((await json(approved)).data.sendContextReviewToken, "review-token");
    assert.equal(fixture.calls.some((call) => call.name === "log"), true);

    const failed = await fetch(`${app.baseUrl}/api/message-processing/requirements/bad/send-context`);
    assert.equal(failed.status, 400);
    assert.equal((await json(failed)).message, "snapshot failed");
  } finally {
    await app.close();
  }
});

test("handles all requirement registration actions and rejects bad input", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const source = requirement("source").source;
    const registered = await post(app.baseUrl, "/api/message-processing/requirements", {
      action: "register_group",
      requirementId: "req-new",
      messageGroupId: "group-1",
      source
    });
    assert.equal(registered.status, 200);
    assert.equal(fixture.calls.some((call) => call.name === "recallKnowledge"), true);
    assert.equal(fixture.calls.some((call) => call.name === "registerMessageGroup"), true);

    const dispatched = await post(app.baseUrl, "/api/message-processing/requirements", {
      action: "dispatch",
      requirementId: "req-new",
      worker: { threadId: "thread-1", threadName: "Agent", workspace: "C:/workspace" }
    });
    assert.equal(dispatched.status, 200);
    assert.equal(fixture.calls.some((call) => call.name === "recordDispatch"), true);

    const failedDispatch = await post(app.baseUrl, "/api/message-processing/requirements", {
      action: "dispatch_failed",
      requirementId: "req-new",
      error: "delivery failed"
    });
    assert.equal(failedDispatch.status, 200);
    assert.equal(fixture.calls.some((call) => call.name === "recordDispatchFailure"), true);

    const unsupported = await post(app.baseUrl, "/api/message-processing/requirements", {
      action: "unknown",
      requirementId: "req-new"
    });
    assert.equal(unsupported.status, 400);
    assert.equal((await json(unsupported)).message, "Unsupported message-processing action.");

    const missingId = await post(app.baseUrl, "/api/message-processing/requirements", {
      action: "dispatch"
    });
    assert.equal(missingId.status, 400);
    assert.equal((await json(missingId)).message, "Missing requirementId.");
  } finally {
    await app.close();
  }
});

test("suppresses expired replay registrations without publishing a board change", async () => {
  const fixture = createFixture();
  fixture.context.board.registerMessageGroup = () => ({
    outcome: "replay_suppressed",
    dedupeKey: "a".repeat(64)
  });
  const app = await startServer(fixture.context);
  try {
    const response = await post(app.baseUrl, "/api/message-processing/requirements", {
      action: "register_group",
      requirementId: "req-replayed",
      messageGroupId: "group-replayed",
      source: requirement("source").source
    });
    assert.equal(response.status, 200);
    assert.equal((await json(response)).data.outcome, "replay_suppressed");
    assert.equal(fixture.calls.some((call) => call.name === "schedule"), false);
    assert.equal(fixture.calls.some((call) => call.name === "event"), false);
  } finally {
    await app.close();
  }
});

test("submits outcomes through injected verification, baseline, reminder, and event services", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const response = await post(
      app.baseUrl,
      "/api/message-processing/requirements/req-outcome/outcome",
      {
        decision: "reply",
        roleId: "Rabi",
        planId: "plan-1",
        projectFactAssessment: {
          status: "critical",
          reviewedMessageIds: ["message-1"],
          replyChainChecked: true,
          evidence: "scope changed",
          assessedAt: "2026-08-21T01:00:00.000Z",
          facts: [{ kind: "scope", evidence: "scope changed" }]
        },
        knowledgeMatchDispositions: [{
          knowledgeId: "memory-old",
          knowledgeType: "recent_memory",
          relevance: "relevant",
          evidence: "updated",
          actions: [{
            type: "update_memory",
            recordType: "memory",
            recordId: "memory-new",
            evidence: "message-1",
            verifiedAt: "2026-08-21T01:00:00.000Z"
          }]
        }],
        criticalFactDisposition: {
          status: "recorded",
          record: { type: "plan", planId: "plan-1" },
          evidence: "message-1",
          verifiedAt: "2026-08-21T01:00:00.000Z"
        }
      }
    );
    assert.equal(response.status, 200);
    assert.equal((await json(response)).data.status, "awaiting_send");
    assert.equal(fixture.calls.filter((call) => call.name === "verify").length, 2);
    assert.equal(fixture.calls.some((call) => call.name === "submitOutcome"), true);
    assert.equal(fixture.calls.some((call) => call.name === "baseline"), true);
    assert.equal(fixture.calls.some((call) => call.name === "schedule"), true);
    assert.equal(fixture.calls.some((call) => call.name === "event"), true);
  } finally {
    await app.close();
  }
});

test("records knowledge callbacks and rejects missing requirements", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  const callback = {
    knowledgeId: "memory-old",
    knowledgeType: "recent_memory",
    result: "updated",
    responseAction: "reply",
    evidence: "message-1",
    recordType: "memory",
    recordId: "memory-new",
    verifiedAt: "2026-08-21T01:00:00.000Z"
  };
  try {
    const response = await post(
      app.baseUrl,
      "/api/message-processing/requirements/req-callback/knowledge-callback",
      callback
    );
    assert.equal(response.status, 200);
    assert.equal(fixture.calls.some((call) => call.name === "verify"), true);
    assert.equal(fixture.calls.some((call) => call.name === "recordKnowledgeCallback"), true);

    const missing = await post(
      app.baseUrl,
      "/api/message-processing/requirements/missing/knowledge-callback",
      callback
    );
    assert.equal(missing.status, 400);
    assert.equal((await json(missing)).message, "Message processing requirement not found: missing");
  } finally {
    await app.close();
  }
});

test("returns 400 for invalid JSON and false for unrelated routes", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  try {
    const invalid = await post(app.baseUrl, "/api/message-processing/requirements", "{");
    assert.equal(invalid.status, 400);
    const oversized = await post(app.baseUrl, "/api/message-processing/requirements", { padding: "x".repeat(1024 * 1024) });
    assert.equal(oversized.status, 413);
    assert.equal((await json(oversized)).errorCode, "API_REQUEST_TOO_LARGE");

    const unrelated = await fetch(`${app.baseUrl}/api/unrelated`);
    assert.equal(unrelated.status, 404);
    assert.deepEqual(await json(unrelated), { fallback: true });
  } finally {
    await app.close();
  }
});


test("registers and retires the same seven executable message-processing operations", async () => {
  const fixture = createFixture();
  const app = await startServer(fixture.context);
  const source = requirement("source").source;
  const callback = {
    knowledgeId: "memory-old",
    knowledgeType: "recent_memory" as const,
    result: "updated" as const,
    responseAction: "reply" as const,
    evidence: "message-1",
    recordType: "memory" as const,
    recordId: "memory-new",
    verifiedAt: "2026-08-21T01:00:00.000Z"
  };
  try {
    await fetch(`${app.baseUrl}/api/message-processing/board`);
    await post(app.baseUrl, "/api/message-processing/requirements/req-outcome/send-context", {
      reviewedByThreadId: "thread-1",
      sendRequest: { text: "reply" }
    });
    await post(app.baseUrl, "/api/message-processing/requirements", {
      action: "register_group",
      requirementId: "req-tracked",
      messageGroupId: "group-tracked",
      source
    });
    await post(app.baseUrl, "/api/message-processing/requirements/req-outcome/outcome", {
      decision: "reply"
    });
    await post(
      app.baseUrl,
      "/api/message-processing/requirements/req-callback/knowledge-callback",
      callback
    );

    assert.equal(app.registry.catalogSnapshot().operations.length, 7);
    await app.registration.dispose();
    assert.equal(app.registry.catalogSnapshot().operations.length, 0);
  } finally {
    await app.close();
  }
});

function verificationGate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Storage blocked independent request")), 1000); })]); }
  finally { clearTimeout(timer); }
}
for (const operation of ["outcome", "knowledge-callback"] as const) {
  test(`${operation} keeps health responsive and waits for asynchronous evidence before committing`, async () => {
    const fixture = createFixture(), entered = verificationGate(), wait = verificationGate();
    fixture.context.verifyCriticalFactRecord = async () => { entered.release(); await wait.promise; };
    const app = await startServer(fixture.context);
    const body = operation === "outcome" ? { decision: "reply" } : {
      knowledgeId: "memory-old", knowledgeType: "recent_memory", result: "updated", responseAction: "reply",
      recordType: "memory", recordId: "memory-new", evidence: "message-1", verifiedAt: "2026-08-21T01:00:00.000Z"
    };
    const pending = post(app.baseUrl, `/api/message-processing/requirements/${operation === "outcome" ? "req-outcome" : "req-callback"}/${operation}`, body);
    try {
      await bounded(entered.promise);
      assert.equal(await (await bounded(fetch(app.baseUrl + "/health"))).text(), "ready");
      assert.equal(fixture.calls.some(call => call.name === "submitOutcome" || call.name === "recordKnowledgeCallback"), false);
      wait.release(); assert.equal((await bounded(pending)).status, 200);
      assert.equal(fixture.calls.some(call => call.name === (operation === "outcome" ? "submitOutcome" : "recordKnowledgeCallback")), true);
    } finally { wait.release(); await pending.catch(() => {}); await app.close(); }
  });
}
test("asynchronous evidence failure never commits an outcome", async () => {
  const fixture = createFixture();
  fixture.context.verifyCriticalFactRecord = async () => { throw new Error("Physical evidence unavailable"); };
  const app = await startServer(fixture.context);
  try {
    const response = await post(app.baseUrl, "/api/message-processing/requirements/req-outcome/outcome", { decision: "reply" });
    assert.equal(response.status, 400);
    assert.equal(fixture.calls.some(call => call.name === "submitOutcome" || call.name === "baseline" || call.name === "event"), false);
  } finally { await app.close(); }
});
test("outcome verification rejects a requirement changed while storage was pending", async () => {
  const fixture = createFixture(), entered = verificationGate(), wait = verificationGate();
  const originalGet = fixture.context.board.getRequirement;
  let changed = false;
  fixture.context.board.getRequirement = id => { const item = originalGet(id); return item && changed ? { ...item, updatedAt: "2026-08-21T01:01:00.000Z" } : item; };
  fixture.context.verifyCriticalFactRecord = async () => { entered.release(); await wait.promise; };
  const app = await startServer(fixture.context);
  const pending = post(app.baseUrl, "/api/message-processing/requirements/req-outcome/outcome", { decision: "reply" });
  try {
    await bounded(entered.promise); changed = true; wait.release();
    assert.equal((await bounded(pending)).status, 400);
    assert.equal(fixture.calls.some(call => call.name === "submitOutcome"), false);
  } finally { wait.release(); await pending.catch(() => {}); await app.close(); }
});

async function nativeBoardFixture(t: test.TestContext) {
  const fixture = createFixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), "message-processing-operation-"));
  let time = Date.parse("2026-10-21T00:00:00.000Z"); const now = () => new Date(time);
  const boardPath = path.join(root, "board.json"), board = new MessageProcessingBoardStore(boardPath, now);
  fixture.context.board = board;
  fixture.context.recallKnowledge = () => [];
  fixture.context.boardPayload = async () => ({ requirement: board.getRequirement("native-requirement") ?? null });
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "empty-processing-node");
  const registry = new ManagerPluginRouteRegistry(), unblock: Array<() => void> = [], outcomeClosed = verificationGate();
  let registration: ReturnType<typeof registry.registerOperations>, server: http.Server | undefined;
  t.after(async () => {
    for (const release of unblock) release(); await registration?.dispose();
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("message-processing-operation-")); fs.rmSync(root, { recursive: true, force: true });
  });
  registration = registry.registerOperations("native-processing-fixture", createMessageProcessingOperations(fixture.context));
  let sourceValid = true;
  server = http.createServer((request, response) => {
    if (request.url?.endsWith("/outcome")) response.once("close", outcomeClosed.release);
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => {
      if (!sourceValid) throw new Error("Original request source changed.");
      // This fixture supplies the server-owned original source context explicitly;
      // enrollment alone never invents an Agent or its source session attribution.
      assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, { provider: "codex", sessionId: "explicit-source-session" });
    });
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
  const request = (url: string, body?: unknown, signal?: AbortSignal) => new Promise<Response>((resolve, reject) => {
    const outgoing = http.request(base + url, { method: body === undefined ? "GET" : "POST", signal, headers: { authorization: "Bearer " + credential.token, "content-type": "text/plain" } }, incoming => {
      const chunks: Buffer[] = []; incoming.on("data", chunk => chunks.push(Buffer.from(chunk))); incoming.on("error", reject);
      incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode! })));
    }); outgoing.on("error", reject); outgoing.setTimeout(15000, () => outgoing.destroy(new Error("Owned message-processing fixture timeout."))); outgoing.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  const register = (id = "native-requirement", messageId = "message-1") => request("/api/message-processing/requirements", { action: "register_group", requirementId: id, messageGroupId: "native-group-" + id, source: { ...requirement("source").source, messageIds: [messageId] } });
  const outcome = { decision: "reply", decidedByThreadId: "explicit-source-session", projectFactAssessment: { status: "none", reviewedMessageIds: ["message-1"], replyChainChecked: true, evidence: "Fixture source and reply chain were checked.", assessedAt: now().toISOString(), assessedByThreadId: "explicit-source-session" } };
  const holdVerification = () => { const entered = verificationGate(), wait = verificationGate(); unblock.push(wait.release); fixture.context.verifyCriticalFactRecord = async () => { entered.release(); await wait.promise; }; return { started: entered.promise, release: wait.release }; };
  return { ...fixture, root, board, boardPath, now, request, register, outcome, authority, credential, registry, registration, holdVerification, outcomeClosed: outcomeClosed.promise, advance: () => { time += 1000; }, revokeSource: () => { sourceValid = false; } };
}

test("an enrolled Node records and reads the original durable Board without a separate feature grant or duplicate requirement", async t => {
  const f = await nativeBoardFixture(t);
  assert.equal(f.registry.catalogSnapshot().operations.length, 7);
  assert.ok(f.registry.catalogSnapshot().operations.every(operation => operation.contract.exposure === "public"));
  const first = await f.register(); assert.equal(first.status, 200); assert.equal((await first.json()).data.outcome, "created");
  const duplicate = await f.register("another-id"); assert.equal(duplicate.status, 200); const repeated = await duplicate.json(); assert.equal(repeated.data.outcome, "existing"); assert.equal(repeated.data.requirement.id, "native-requirement");
  const restored = new MessageProcessingBoardStore(f.boardPath, f.now); assert.equal(restored.getRequirement("native-requirement")?.status, "pending_dispatch"); assert.equal(restored.getRequirement("another-id"), undefined);
  assert.equal((await f.request("/api/message-processing/board")).status, 200);
  const read = await f.request("/api/message-processing/requirements/native-requirement"); assert.equal(read.status, 200); assert.equal((await read.json()).data.id, "native-requirement");
});

test("an explicitly attributed outcome persists through the native Board after evidence validation", async t => {
  const f = await nativeBoardFixture(t); await f.register(); f.advance();
  const response = await f.request("/api/message-processing/requirements/native-requirement/outcome", f.outcome);
  assert.equal(response.status, 200); assert.equal((await response.json()).data.status, "awaiting_send");
  assert.equal(new MessageProcessingBoardStore(f.boardPath, f.now).getRequirement("native-requirement")?.decision?.decidedByThreadId, "explicit-source-session");
  const forged = await f.request("/api/message-processing/requirements/native-requirement/outcome", { ...f.outcome, decidedByThreadId: "other-session" }); assert.equal(forged.status, 400);
});

test("source changes during original asynchronous evidence verification prevent a durable outcome commit", async t => {
  const f = await nativeBoardFixture(t); await f.register(); const hold = f.holdVerification();
  const pending = f.request("/api/message-processing/requirements/native-requirement/outcome", f.outcome); await hold.started; f.revokeSource(); hold.release();
  const response = await pending; assert.equal(response.status, 400); assert.equal(new MessageProcessingBoardStore(f.boardPath, f.now).getRequirement("native-requirement")?.status, "pending_dispatch");
});

test("Node revocation during verification hides the result and prevents a native Board mutation", async t => {
  const f = await nativeBoardFixture(t); await f.register(); const hold = f.holdVerification();
  const pending = f.request("/api/message-processing/requirements/native-requirement/outcome", f.outcome); await hold.started;
  f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); hold.release();
  const response = await pending; assert.equal(response.status, 403); assert.equal((await response.json()).data, undefined);
  assert.equal(new MessageProcessingBoardStore(f.boardPath, f.now).getRequirement("native-requirement")?.status, "pending_dispatch");
});

test("retirement after HTTP disconnect joins pending original evidence verification and leaves the native Board unchanged", async t => {
  const f = await nativeBoardFixture(t); await f.register(); const hold = f.holdVerification(), controller = new AbortController();
  const pending = f.request("/api/message-processing/requirements/native-requirement/outcome", f.outcome, controller.signal).catch(() => undefined); await hold.started; controller.abort(); await pending; await f.outcomeClosed;
  let retired = false; const retirement = f.registration.dispose().then(() => { retired = true; }); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  hold.release(); await retirement; assert.equal(f.registry.catalogSnapshot().operations.length, 0); assert.equal(new MessageProcessingBoardStore(f.boardPath, f.now).getRequirement("native-requirement")?.status, "pending_dispatch");
});
