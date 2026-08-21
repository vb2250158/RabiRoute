import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type {
  KnowledgeRecallMatch,
  MessageProcessingRequirement,
  RegisterMessageGroupRequirementInput
} from "../messageProcessing/board.js";
import {
  handleMessageProcessingApi,
  type MessageProcessingApiContext
} from "./messageProcessingRoutes.js";

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
        return item;
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
      snapshot: (id, sourceMessageId) => {
        remember("snapshot", id, sourceMessageId);
        if (id === "bad") throw new Error("snapshot failed");
        return { requirementId: id, sourceMessageId };
      },
      approve: (id, input) => {
        remember("approve", id, input);
        return {
          token: "review-token",
          requirementId: id,
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
    verifyCriticalFactRecord: (input) => remember("verify", input),
    setPlanBaseline: (item, roleId, planId) => remember("baseline", item, roleId, planId),
    scheduleKnowledgeCallbackReminder: (item) => remember("schedule", item),
    publishEvent: (eventType, data) => remember("event", eventType, data)
  };
  return { calls, context };
}

async function startServer(context: MessageProcessingApiContext) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (handleMessageProcessingApi(request, url, response, context)) return;
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ fallback: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
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
    assert.equal((await json(approved)).data.token, "review-token");
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

    const unrelated = await fetch(`${app.baseUrl}/api/unrelated`);
    assert.equal(unrelated.status, 404);
    assert.deepEqual(await json(unrelated), { fallback: true });
  } finally {
    await app.close();
  }
});
