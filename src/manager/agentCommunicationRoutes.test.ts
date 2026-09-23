import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type http from "node:http";
import test from "node:test";
import type { AgentRequestRecord, AgentRequestStore } from "../agentRequests/store.js";
import { AGENT_SEND_REQUEST_CONTRACT, prepareAgentSendRequest, type AgentSendSender } from "../agentSend.js";
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

test("upload Help exposes only partial success schemas and preserves baseline coverage", () => {
  const responses: Array<{ statusCode: number; body: any }> = [];
  const routes = createAgentCommunicationRoutes(context({
    jsonResponse: (_response, statusCode, body) => responses.push({ statusCode, body }),
    readJsonBody: async () => { throw new Error("Help must not read upload bytes"); }
  }));
  routes.handler(request("GET"), new URL("http://localhost/api/agent/help?path=%2Fapi%2Fagent%2Fuploads%2F%3AuploadId"), response());
  assert.equal(responses[0].statusCode, 200);
  const wire = JSON.parse(JSON.stringify(responses[0].body));
  assert.equal(wire.data.operations.length, 2);
  for (const { help } of wire.data.operations) {
    assert.equal(help.contractLevel, "baseline");
    assert.equal(help.coverage.exactRequestSchema, false);
    assert.equal(help.coverage.exactResponseSchema, false);
    assert.deepEqual(help.coverage.missing, help.machineReadable.missing);
    assert.deepEqual(Object.keys(help.machineReadable.responses), ["200"]);
    assert.equal(help.machineReadable.responses["200"].schema.properties.code.const, 0);
    assert.equal("schema" in help.machineReadable.request.body, false);
  }
});

test("generic Agent help returns the current operation contract", () => {
  const responses: unknown[] = [];
  const routes = createAgentCommunicationRoutes(context({
    jsonResponse: (_response, statusCode, body) => responses.push({ statusCode, body })
  }));
  assert.equal(routes.handler(request("GET"), new URL("http://localhost/api/agent/help?operationId=agent%3AGET%3A%2Fapi%2Fagent%2Fsend%2Fcapabilities"), response()), true);
  const result = responses[0] as { statusCode: number; body: { data: { count: number; operations: Array<{ help: { nextStep: string } }> } } };
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data.count, 1);
  assert.match(result.body.data.operations[0].help.nextStep, /data|coverage/i);
});

test("discovery digests identify full immutable collections independently of filters", () => {
  const results: Array<{ data: { catalogDigest?: string; channelsDigest?: string; operations?: unknown[]; channels?: unknown[] } }> = [];
  const routes = createAgentCommunicationRoutes(context({
    jsonResponse: (_response, status, body) => { assert.equal(status, 200); results.push(body as typeof results[number]); }
  }));
  for (const suffix of ["help", "help?method=GET", "help?path=%2Fmissing", "send/capabilities", "send/capabilities"]) {
    routes.handler(request("GET"), new URL(`http://localhost/api/agent/${suffix}`), response());
  }
  assert.match(results[0].data.catalogDigest!, /^sha256:[a-f0-9]{64}$/);
  assert.equal(results[0].data.catalogDigest, results[1].data.catalogDigest);
  assert.equal(results[0].data.catalogDigest, results[2].data.catalogDigest);
  assert.match(results[3].data.channelsDigest!, /^sha256:[a-f0-9]{64}$/);
  assert.equal(results[3].data.channelsDigest, results[4].data.channelsDigest);
  assert.notEqual(results[0].data.catalogDigest, results[3].data.channelsDigest);
  const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  assert.equal(results[0].data.catalogDigest, digest(results[0].data.operations));
  assert.equal(results[3].data.channelsDigest, digest(results[3].data.channels));
  assert.notEqual(results[1].data.catalogDigest, digest(results[1].data.operations));
  // Prove content sensitivity without mutating the authoritative frozen registry.
  assert.notEqual(results[0].data.catalogDigest, digest([...results[0].data.operations!, { description: "fixture change" }]));
  assert.notEqual(results[3].data.channelsDigest, digest(results[3].data.channels!.slice(1)));
});

test("Help rejects malformed filters without echoing untrusted values or entering business handlers", () => {
  for (const query of ["unknown=private-value", "method=GET&method=POST", "path=", "operationId=%20"]) {
    const responses: Array<{ status: number; body: any }> = [];
    const routes = createAgentCommunicationRoutes(context({
      jsonResponse: (_response, status, body) => responses.push({ status, body }),
      readJsonBody: async () => { throw new Error("Help must not read a body"); },
      send: async () => { throw new Error("Help must not send"); }
    }));
    assert.equal(routes.handler(request("GET"), new URL(`http://localhost/api/agent/help?${query}`), response()), true);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 400);
    assert.equal(responses[0].body.errorCode, "AGENT_HELP_INVALID_QUERY");
    assert.deepEqual(responses[0].body.help.allowedQueryParameters, ["operationId", "path", "method"]);
    assert.equal(responses[0].body.retryable, false);
    assert.ok(!JSON.stringify(responses[0].body).includes("private-value"));
  }
});

test("Help preserves filter intersection, lowercase method and empty search compatibility", () => {
  for (const [query, status, count] of [
    ["path=%2Fapi%2Fagent%2Fsend&method=post", 200, 1],
    ["path=%2Fdoes-not-exist", 200, 0],
    ["operationId=missing", 404, undefined],
    ["operationId=agent%3APOST%3A%2Fapi%2Fagent%2Fsend&method=GET", 404, undefined]
  ] as const) {
    const responses: Array<{ status: number; body: any }> = [];
    const routes = createAgentCommunicationRoutes(context({ jsonResponse: (_response, status, body) => responses.push({ status, body }) }));
    routes.handler(request("GET"), new URL(`http://localhost/api/agent/help?${query}`), response());
    assert.equal(responses[0].status, status);
    if (status === 200) assert.equal(responses[0].body.data.count, count);
    else assert.equal(responses[0].body.errorCode, "AGENT_HELP_NOT_FOUND");
  }
});

test("send capabilities exposes the parser-owned partial field contract without upgrading baseline", () => {
  const responses: Array<{ data: any }> = [];
  const routes = createAgentCommunicationRoutes(context({
    jsonResponse: (_response, status, body) => { assert.equal(status, 200); responses.push(body as typeof responses[number]); },
    send: async () => { throw new Error("Discovery must not send"); },
    readJsonBody: async () => { throw new Error("Discovery must not parse a body"); }
  }));
  for (const suffix of ["send/capabilities", "send/capabilities", "help?path=%2Fapi%2Fagent%2Fsend&method=POST"]) {
    routes.handler(request("GET"), new URL(`http://localhost/api/agent/${suffix}`), response());
  }
  const data = responses[0].data;
  assert.equal(data.requestContract, AGENT_SEND_REQUEST_CONTRACT);
  const wire = JSON.parse(JSON.stringify(data));
  assert.deepEqual(wire.requestContract, AGENT_SEND_REQUEST_CONTRACT);
  const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  assert.equal(data.requestContractDigest, digest(wire.requestContract));
  assert.equal(data.requestContractDigest, responses[1].data.requestContractDigest);
  assert.notEqual(data.requestContractDigest, digest({ ...wire.requestContract, missing: [] }));
  assert.equal(data.channelsDigest, digest(wire.channels));
  assert.equal(wire.requestContract.kind, "partial-field-allowlist");
  assert.ok(wire.requestContract.missing.includes("required-and-conditional-fields"));
  assert.equal("schema" in wire.requestContract, false);
  for (const channel of wire.channels) {
    assert.deepEqual(wire.requestContract.paramsAllowedFields[channel.channel], Object.keys(channel.params));
    const base = { deliveryId: "discovery-contract", sender: { agentType: "dsh", sessionId: "example-session" }, routeId: "example-route", ...channel.example };
    assert.doesNotThrow(() => prepareAgentSendRequest(base));
    for (const section of ["request", "sender", "payload", "params"]) {
      const extra = section === "request" ? { ...base, unsupportedField: true }
        : { ...base, [section]: { ...base[section], unsupportedField: true } };
      assert.throws(() => prepareAgentSendRequest(extra), { message: `${section} contains unsupported fields: unsupportedField.` });
    }
  }
  const help = responses[2].data.operations[0].help;
  assert.equal(help.contractLevel, "baseline");
  assert.equal(help.coverage.exactRequestSchema, false);
  assert.equal(help.coverage.exactResponseSchema, false);
});

test("send capabilities returns channels and QQ repair guidance", () => {
  const responses: unknown[] = [];
  const routes = createAgentCommunicationRoutes(context({
    jsonResponse: (_response, statusCode, body) => responses.push({ statusCode, body })
  }));
  assert.equal(routes.handler(request("GET"), new URL("http://localhost/api/agent/send/capabilities"), response()), true);
  const result = responses[0] as { statusCode: number; body: { data: { channels: Array<{ channel: string }>; contract: { qq: string } } } };
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.data.channels.map(item => item.channel), ["napcat", "wecom", "weixin", "feishu", "rabilink", "speech", "fennenote", "role_panel", "plan_feedback"]);
  assert.match(result.body.data.contract.qq, /channel=napcat/);
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
