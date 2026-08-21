import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import test from "node:test";
import type { AgentRequestRecord, AgentRequestStore } from "../agentRequests/store.js";
import {
  createAgentCommunicationRoutes,
  type AgentCommunicationRoutesContext
} from "./agentCommunicationRoutes.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function request(method: string): http.IncomingMessage {
  return { method } as http.IncomingMessage;
}

function response(): http.ServerResponse {
  return new EventEmitter() as http.ServerResponse;
}

function agentRequestRecord(id: string, status: AgentRequestRecord["status"]): AgentRequestRecord {
  return {
    id,
    deliveryId: `delivery-${id}`,
    status,
    source: { threadId: "source", agentType: "agent" },
    target: { threadId: "target", agentType: "agent" },
    responseInstruction: "reply",
    createdAt: "2026-08-21T00:00:00.000Z",
    reminderCount: 0,
    updatedAt: "2026-08-21T00:00:00.000Z"
  };
}

function context(overrides: Partial<AgentCommunicationRoutesContext> = {}): AgentCommunicationRoutesContext {
  const record = agentRequestRecord("request-1", "cancelled");
  const agentRequests = {
    list: () => [],
    get: () => undefined,
    cancel: () => record
  } as unknown as AgentRequestStore;
  return {
    readJsonBody: async <T>() => ({} as T),
    jsonResponse: () => undefined,
    receiptResponse: () => ({ statusCode: 404, body: {} }),
    findSendTraces: () => [],
    send: async () => ({ statusCode: 202, body: { ok: true } }),
    agentRequests,
    refreshAgentRequestReminderTimers: () => undefined,
    publishManagerEvent: () => undefined,
    ...overrides
  };
}

test("communication drain waits for send after the HTTP response closes", async () => {
  const sendResult = deferred<{ statusCode: number; body: Record<string, unknown> }>();
  const responses: unknown[] = [];
  const routes = createAgentCommunicationRoutes(context({
    readJsonBody: async <T>() => ({ prompt: "hello" } as T),
    send: () => sendResult.promise,
    jsonResponse: (_response, statusCode, body) => responses.push({ statusCode, body })
  }));
  const res = response();

  assert.equal(routes.handler(
    request("POST"),
    new URL("http://localhost/api/agent/send"),
    res
  ), true);
  res.emit("close");

  let stopped = false;
  const stopping = routes.stopAcceptingAndDrain().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);

  sendResult.resolve({ statusCode: 202, body: { ok: true, status: "accepted" } });
  await stopping;
  assert.deepEqual(responses, [{
    statusCode: 202,
    body: { code: 0, ok: true, status: "accepted" }
  }]);
});

test("communication drain includes cancel body parsing and side effects", async () => {
  const body = deferred<{ reason?: string }>();
  const calls: string[] = [];
  const record = agentRequestRecord("request-1", "cancelled");
  const agentRequests = {
    list: () => [],
    get: () => undefined,
    cancel: (requestId: string, reason?: string) => {
      calls.push(`cancel:${requestId}:${reason}`);
      return record;
    }
  } as unknown as AgentRequestStore;
  const routes = createAgentCommunicationRoutes(context({
    readJsonBody: async <T>() => await body.promise as T,
    agentRequests,
    refreshAgentRequestReminderTimers: () => { calls.push("refresh"); },
    publishManagerEvent: () => { calls.push("publish"); },
    jsonResponse: () => { calls.push("response"); }
  }));
  const res = response();

  assert.equal(routes.handler(
    request("POST"),
    new URL("http://localhost/api/agent/requests/request-1/cancel"),
    res
  ), true);
  res.emit("close");

  let stopped = false;
  const stopping = routes.stopAcceptingAndDrain().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);

  body.resolve({ reason: "done" });
  await stopping;
  assert.deepEqual(calls, [
    "cancel:request-1:done",
    "refresh",
    "publish",
    "response"
  ]);
});

test("communication operation rejection is observed after response close", async () => {
  const sendResult = deferred<{ statusCode: number; body: Record<string, unknown> }>();
  const routes = createAgentCommunicationRoutes(context({
    readJsonBody: async <T>() => ({ prompt: "hello" } as T),
    send: () => sendResult.promise,
    jsonResponse: () => { throw new Error("response closed"); }
  }));
  const res = response();

  assert.equal(routes.handler(
    request("POST"),
    new URL("http://localhost/api/agent/send"),
    res
  ), true);
  res.emit("close");
  const stopping = routes.stopAcceptingAndDrain();
  sendResult.reject(new Error("send failed"));
  await stopping;
  await new Promise(resolve => setImmediate(resolve));
});
