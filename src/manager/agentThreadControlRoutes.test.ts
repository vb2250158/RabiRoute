import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import type { AgentRequestStore } from "../agentRequests/store.js";
import { registerLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type {
  AgentThreadRequest,
  AgentThreadRequestOptions,
  AgentThreadRequestResult
} from "../agentThreads.js";
import type { MessageProcessingBoardStore } from "../messageProcessing/board.js";
import {
  createAgentThreadControlRoutes,
  type AgentThreadControlRoutesContext
} from "./agentThreadControlRoutes.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function request(method: string): http.IncomingMessage {
  return { method } as http.IncomingMessage;
}

function response(): http.ServerResponse {
  return new EventEmitter() as http.ServerResponse;
}

function context(overrides: Partial<AgentThreadControlRoutesContext> = {}): AgentThreadControlRoutesContext {
  return {
    readJsonBody: async <T>() => ({} as T),
    jsonResponse: () => undefined,
    agentRequests: {
      get: () => undefined
    } as unknown as AgentRequestStore,
    messageProcessingBoard: {
      submitOutcome: () => { throw new Error("unexpected submitOutcome"); },
      recordHandoffReturned: () => { throw new Error("unexpected recordHandoffReturned"); }
    } as unknown as Pick<MessageProcessingBoardStore, "submitOutcome" | "recordHandoffReturned">,
    applyManagedAgentThreadDefaults: value => value,
    agentThreadRequestOptions: () => ({} as AgentThreadRequestOptions),
    handleAgentThreadRequest: async () => ({ statusCode: 200, data: { ok: true } }),
    agentThreadRequestFailureData: error => ({ message: String(error) }),
    setMessageProcessingPlanBaseline: () => undefined,
    refreshAgentRequestReminderTimers: () => undefined,
    publishManagerEvent: () => undefined,
    operationalLog: { record: () => null },
    operationalError: () => undefined,
    ...overrides
  };
}

test("sessionless remote management is allowed while sends require a trusted source", async () => {
  for (const method of ["GET", "POST"]) {
    const req = request(method);
    registerLanAgentBodyGuard(req, () => undefined);
    let invoked = false;
    const statuses: number[] = [];
    const routes = createAgentThreadControlRoutes(context({
      getTrustedRemoteSource: () => undefined,
      readJsonBody: async <T>() => ({ action: "send", remoteSource: { sessionId: "forged" } } as T),
      handleAgentThreadRequest: async () => {
        invoked = true;
        return { statusCode: 200, data: { ok: true } };
      },
      jsonResponse: (_response, status) => { statuses.push(status); }
    }));
    const res = response();
    routes.handler(req, new URL("http://localhost/api/agent/threads"), res);
    res.emit("close");
    await routes.stopAcceptingAndDrain();
    assert.equal(invoked, method === "GET");
    assert.deepEqual(statuses, [method === "GET" ? 200 : 400]);
  }
});

test("caller execution options are frozen before managed defaults and cannot be supplied by body", async () => {
  let captured: AgentThreadRequestOptions["callerExecutionOptions"];
  const routes = createAgentThreadControlRoutes(context({
    readJsonBody: async <T>() => ({ action: "send", cwd: "C:/chosen", callerExecutionOptions: { model: "forged" } } as T),
    applyManagedAgentThreadDefaults: body => ({ ...body, model: "route-default" }),
    agentThreadRequestOptions: (_body, extra) => ({ ...extra } as AgentThreadRequestOptions),
    handleAgentThreadRequest: async (body, options) => {
      assert.equal(body.model, "route-default");
      captured = options.callerExecutionOptions;
      assert.equal(Object.isFrozen(captured), true);
      return { statusCode: 200, data: { ok: true } };
    }
  }));
  const res = response();
  routes.handler(request("POST"), new URL("http://localhost/api/agent/threads"), res);
  res.emit("close");
  await routes.stopAcceptingAndDrain();
  assert.deepEqual(captured, { cwd: "C:/chosen" });
});

test("application connection does not replace the trusted desktop Agent source", async () => {
  const req = request("POST");
  registerLanAgentBodyGuard(req, () => undefined);
  const remoteSource = { nodeId: "pc", agentId: "agent", sessionId: "session", provider: "codex" as const, sessionName: "Source" };
  let invoked = false;
  const routes = createAgentThreadControlRoutes(context({
    getTrustedRemoteSource: () => remoteSource,
    getTrustedDeviceSource: () => ({ scope: "scope", sourceDeviceId: "application", deviceOwner: false }),
    readJsonBody: async <T>() => ({ action: "send", sourceThreadId: "session" } as T),
    agentThreadRequestOptions: (_body, extra) => ({ ...extra } as AgentThreadRequestOptions),
    handleAgentThreadRequest: async (_body, options, deviceSource) => {
      invoked = true;
      assert.equal(options.remoteSource, remoteSource);
      assert.equal(deviceSource, undefined);
      return { statusCode: 200, data: { ok: true } };
    }
  }));
  const res = response();
  routes.handler(req, new URL("http://localhost/api/agent/threads"), res);
  res.emit("close");
  await routes.stopAcceptingAndDrain();
  assert.equal(invoked, true);
});

test("HTTP native source comes only from ingress and retains its revocation fence", async () => {
  const verified = { scope: "scope", sourceDeviceId: "glasses-a", deviceOwner: true };
  const workStarted = deferred<void>();
  const continueWork = deferred<void>();
  let current = true;
  const observed: unknown[] = [];
  const routes = createAgentThreadControlRoutes(context({
    readJsonBody: async <T>(req: http.IncomingMessage) => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      return JSON.parse(body) as T;
    },
    getTrustedRemoteSource: () => undefined,
    getTrustedDeviceSource: req => req.headers["x-test-source"] === "verified" ? verified : undefined,
    agentThreadRequestOptions: (_body, extra) => ({ ...extra } as AgentThreadRequestOptions),
    handleAgentThreadRequest: async (_body, options, source) => {
      observed.push(source);
      if (observed.length === 2) {
        workStarted.resolve();
        await continueWork.promise;
      }
      options.requestAuthority?.();
      return { statusCode: 200, data: { ok: true } };
    },
    jsonResponse: (res, status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    }
  }));
  const server = http.createServer((req, res) => {
    registerLanAgentBodyGuard(req, () => undefined);
    markAuthenticatedConnectionRequest(req, () => {
      if (!current) throw new Error("connection revoked");
    });
    routes.handler(req, new URL(req.url!, "http://localhost"), res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/agent/threads`;
  const send = (verifiedSource: boolean) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(verifiedSource ? { "x-test-source": "verified" } : {}) },
    body: JSON.stringify({ action: "send", message: "hello", trustedDeviceSource: verified, remoteSource: { sessionId: "forged" } })
  });
  try {
    const forged = await send(false);
    assert.equal(forged.status, 400);
    assert.equal(observed.length, 0);
    const accepted = await send(true);
    assert.equal(accepted.status, 200);
    assert.deepEqual(observed, [verified]);
    const pending = send(true);
    await workStarted.promise;
    current = false;
    continueWork.resolve();
    const revoked = await pending;
    assert.equal(revoked.status, 400);
    assert.match(await revoked.text(), /connection revoked/);
  } finally {
    continueWork.resolve();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await routes.stopAcceptingAndDrain();
  }
});

test("thread drain waits for body parsing and thread work after response close", async () => {
  const body = deferred<AgentThreadRequest>();
  const threadResult = deferred<AgentThreadRequestResult>();
  const responses: unknown[] = [];
  let threadStarted = false;
  const routes = createAgentThreadControlRoutes(context({
    readJsonBody: async <T>() => await body.promise as T,
    handleAgentThreadRequest: () => {
      threadStarted = true;
      return threadResult.promise;
    },
    jsonResponse: (_response, statusCode, responseBody) => {
      responses.push({ statusCode, body: responseBody });
    }
  }));
  const res = response();

  assert.equal(routes.handler(
    request("POST"),
    new URL("http://localhost/api/agent/threads"),
    res
  ), true);
  res.emit("close");

  let stopped = false;
  const stopping = routes.stopAcceptingAndDrain().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(threadStarted, false);

  body.resolve({ action: "list" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(threadStarted, true);
  assert.equal(stopped, false);

  threadResult.resolve({ statusCode: 200, data: { ok: true, threads: [] } });
  await stopping;
  assert.deepEqual(responses, [{
    statusCode: 200,
    body: { code: 0, ok: true, threads: [] }
  }]);
});

test("thread operation rejection is observed after response close", async () => {
  const routes = createAgentThreadControlRoutes(context({
    readJsonBody: async <T>() => ({ action: "list" } as T),
    handleAgentThreadRequest: async () => { throw new Error("thread failed"); },
    jsonResponse: () => { throw new Error("response closed"); }
  }));
  const res = response();

  assert.equal(routes.handler(
    request("POST"),
    new URL("http://localhost/api/agent/threads"),
    res
  ), true);
  res.emit("close");
  await routes.stopAcceptingAndDrain();
  await new Promise(resolve => setImmediate(resolve));
});
