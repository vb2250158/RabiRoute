import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";
import {
  YeYuGamerManagerApiClient,
  type YeYuGamerCommandReceipt,
  type YeYuGamerManagerConfigInput,
  type YeYuGamerWorkItemCreate
} from "./managerApi.js";
/*
 * Keep the import surface explicit: the facade may construct only the bounded
 * typed client, never a generic HTTP or execution adapter.
 */
import {
  handleYeYuGamerManagerApi,
  type YeYuGamerManagerRouteClient,
  type YeYuGamerWorkItemDispatchRequest
} from "./managerRoutes.js";

function request(method: string, remoteAddress = "127.0.0.1"): http.IncomingMessage {
  return { method, socket: { remoteAddress } } as unknown as http.IncomingMessage;
}

function receipt(): YeYuGamerCommandReceipt {
  return {
    commandId: "work-1",
    idempotencyKey: "dispatch-1",
    requestId: null,
    statusUrl: "/api/v1/agent/work-items/work-1",
    acceptedStateVersion: 4,
    state: "accepted",
    message: "recorded",
    result: {},
    submittedAt: "2026-08-27T00:00:00.000Z",
    completedAt: null,
    replayed: false
  };
}

test("Manager facade exposes only four reads and one work-item dispatch on loopback", async () => {
  const calls: string[] = [];
  let posted: { workItem: YeYuGamerWorkItemCreate; options: Record<string, unknown> } | undefined;
  const client: YeYuGamerManagerRouteClient = {
    getHealth: async () => { calls.push("health"); return {} as never; },
    getMeta: async () => { calls.push("meta"); return {} as never; },
    getSnapshot: async () => { calls.push("snapshot"); return {} as never; },
    getCapabilities: async () => { calls.push("capabilities"); return {} as never; },
    createWorkItem: async (workItem, options) => {
      calls.push("work-items");
      posted = { workItem, options };
      return receipt();
    }
  };

  const responseFor = async (
    method: string,
    pathname: string,
    body?: YeYuGamerWorkItemDispatchRequest
  ): Promise<{ status: number; body: unknown; handled: boolean }> => {
    let resolve!: (value: { status: number; body: unknown; handled: boolean }) => void;
    const done = new Promise<{ status: number; body: unknown; handled: boolean }>(accept => { resolve = accept; });
    const handled = handleYeYuGamerManagerApi(
      request(method),
      new URL(`http://127.0.0.1:8790${pathname}`),
      {} as http.ServerResponse,
      {
        getConfig: () => ({}),
        readJsonBody: async () => body as never,
        jsonResponse: (_response, status, payload) => resolve({ status, body: payload, handled }),
        createClient: () => client
      }
    );
    if (!handled) return { status: 0, body: null, handled };
    return done;
  };

  for (const resource of ["health", "meta", "snapshot", "capabilities"]) {
    const response = await responseFor("GET", `/api/agent/yeyu-gamer/${resource}`);
    assert.equal(response.handled, true);
    assert.equal(response.status, 200);
  }
  const workItem = { kind: "observation", note: "read-only observation request" } as const;
  const dispatch = await responseFor("POST", "/api/agent/yeyu-gamer/work-items", {
    workItem,
    idempotencyKey: "dispatch-1",
    expectedStateVersion: 3
  });
  assert.equal(dispatch.status, 202);
  assert.deepEqual(posted, {
    workItem,
    options: { idempotencyKey: "dispatch-1", expectedStateVersion: 3 }
  });
  assert.deepEqual(calls, ["health", "meta", "snapshot", "capabilities", "work-items"]);

  for (const forbiddenPath of [
    "/api/agent/yeyu-gamer/claims",
    "/api/agent/yeyu-gamer/decisions",
    "/api/agent/yeyu-gamer/capability-invocations",
    "/api/agent/yeyu-gamer/path",
    "/api/agent/yeyu-gamer/shell"
  ]) {
    const response = await responseFor("POST", forbiddenPath);
    assert.equal(response.handled, false);
  }
});

test("Manager facade refuses non-loopback callers before config or credentials are read", () => {
  let configReads = 0;
  let responsePayload: unknown;
  const handled = handleYeYuGamerManagerApi(
    request("GET", "192.0.2.10"),
    new URL("http://127.0.0.1:8790/api/agent/yeyu-gamer/health"),
    {} as http.ServerResponse,
    {
      getConfig: () => { configReads += 1; return {}; },
      readJsonBody: async () => ({} as never),
      jsonResponse: (_response, status, body) => { responsePayload = { status, body }; }
    }
  );
  assert.equal(handled, true);
  assert.equal(configReads, 0);
  assert.equal((responsePayload as { status: number }).status, 403);
});

test("invalid integration config fails closed without making a live external request", async () => {
  let responsePayload: unknown;
  let requests = 0;
  let resolveResponse!: () => void;
  const responded = new Promise<void>(resolve => { resolveResponse = resolve; });
  const handled = handleYeYuGamerManagerApi(
    request("GET"),
    new URL("http://127.0.0.1:8790/api/agent/yeyu-gamer/health"),
    {} as http.ServerResponse,
    {
      getConfig: () => ({ baseUrl: "http://localhost:8877/api/v1" }),
      readJsonBody: async () => ({} as never),
      jsonResponse: (_response, status, body) => {
        responsePayload = { status, body };
        resolveResponse();
      },
      createClient: (config: YeYuGamerManagerConfigInput | undefined) => new YeYuGamerManagerApiClient(config, {
        fetch: async () => {
          requests += 1;
          return new Response("{}", { status: 200 });
        }
      })
    }
  );
  assert.equal(handled, true);
  await responded;
  assert.equal((responsePayload as { status: number }).status, 400);
  assert.equal(requests, 0);
});
