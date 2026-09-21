import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import test from "node:test";
import type { AgentRequestRecord, AgentRequestStore } from "../agentRequests/store.js";
import type { AgentSendSender } from "../agentSend.js";
import { registerLanAgentBodyGuard, setTrustedLanAgentSource, type TrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { assertAgentSendPermission } from "./agentSendPermission.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
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

test("send forwards only request-owned remote authority to Route permission", async () => {
  const remote: TrustedLanAgentSource = {
    nodeId: "remote-node", agentId: "remote-agent", provider: "dsh",
    sessionId: "same-session", sessionName: "Remote primary"
  };
  for (const bound of [false, true]) {
    const req = request("POST");
    setTrustedLanAgentSource(req, remote);
    registerLanAgentBodyGuard(req, () => undefined);
    const res = response();
    const statuses: number[] = [];
    let delivered = false;
    const definition = {
      primaryAgentAdapter: "dsh", dshSessionId: remote.sessionId,
      codexHooks: { onlyPrimaryPersonaCanSendMessages: true },
      agentInstanceBindings: bound ? { dsh: { instanceId: remote.nodeId, agentId: remote.agentId } } : undefined
    } as GatewayDefinition;
    const routes = createAgentCommunicationRoutes(context({
      readJsonBody: async <T>() => ({
        sender: { agentType: "primary_persona", sessionId: remote.sessionId },
        remoteSource: { ...remote, nodeId: "forged-node" }
      } as T),
      send: async (body, options) => {
        assert.deepEqual(options?.remoteSource, remote);
        assertAgentSendPermission(body.sender as AgentSendSender, definition, options?.remoteSource);
        delivered = true;
        return { statusCode: 202, body: { ok: true } };
      },
      jsonResponse: (_res, status) => { statuses.push(status); }
    }));
    assert.equal(routes.handler(req, new URL("http://localhost/api/agent/send"), res), true);
    res.emit("close");
    await routes.stopAcceptingAndDrain();
    assert.equal(delivered, bound);
    assert.deepEqual(statuses, [bound ? 202 : 400]);
  }
});

test("send ignores body authority locally and fails closed for a remote request without trusted session", async () => {
  for (const remoteRequest of [false, true]) {
    const req = request("POST");
    if (remoteRequest) registerLanAgentBodyGuard(req, () => undefined);
    let sent = false;
    const statuses: number[] = [];
    const routes = createAgentCommunicationRoutes(context({
      readJsonBody: async <T>() => ({ remoteSource: { nodeId: "forged-node" } } as T),
      send: async (_body, options) => {
        assert.equal(options?.remoteSource, undefined);
        sent = true;
        return { statusCode: 202, body: { ok: true } };
      },
      jsonResponse: (_res, status) => { statuses.push(status); }
    }));
    const res = response();
    routes.handler(req, new URL("http://localhost/api/agent/send"), res);
    res.emit("close");
    await routes.stopAcceptingAndDrain();
    assert.equal(sent, !remoteRequest);
    assert.deepEqual(statuses, [remoteRequest ? 400 : 202]);
  }
});

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

test("send validation failure returns the actual protocol contract without delivering", async () => {
  const received = deferred<{ status: number; body: Record<string, any> }>();
  const routes = createAgentCommunicationRoutes(context({
    send: async () => { throw new Error("Missing deliveryId"); },
    jsonResponse: (_response, status, body) => received.resolve({ status, body: body as Record<string, any> })
  }));
  const res = response();
  assert.equal(routes.handler(request("POST"), new URL("http://localhost/api/agent/send"), res), true);
  const result = await received.promise;
  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.contract.method, "POST");
  assert.equal(result.body.contract.path, "/api/agent/send");
  assert.deepEqual(result.body.contract.requiredFields, ["deliveryId", "sender", "routeId", "channel", "params", "payload"]);
  assert.deepEqual(result.body.contract.senderFields, ["agentType", "sessionId"]);
  assert.match(result.body.contract.retryRule, /same deliveryId/);
  res.emit("finish");
  await routes.stopAcceptingAndDrain();
});
