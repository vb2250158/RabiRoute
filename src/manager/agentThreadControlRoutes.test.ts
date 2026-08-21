import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import test from "node:test";
import type { AgentRequestStore } from "../agentRequests/store.js";
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
