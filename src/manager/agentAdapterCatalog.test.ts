import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import test from "node:test";
import {
  handleAgentAdapterCatalogApi,
  type AgentAdapterCatalogService
} from "./agentAdapterCatalog.js";

type RecordedResponse = {
  statusCode: number;
  body: unknown;
};

function request(method = "GET"): http.IncomingMessage {
  return Object.assign(new EventEmitter(), { method }) as unknown as http.IncomingMessage;
}

function response(): http.ServerResponse {
  return Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false
  }) as unknown as http.ServerResponse;
}

async function settleRoute(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("Agent adapter catalog exposes only the catalog and scan routes", async () => {
  const calls: Array<{ kind: string; options?: unknown; signal?: AbortSignal }> = [];
  const responses: RecordedResponse[] = [];
  const service = {
    async catalog() {
      calls.push({ kind: "catalog" });
      return { schemaVersion: 1, adapters: [] };
    },
    async scanAll(options: unknown, signal?: AbortSignal) {
      calls.push({ kind: "all", options, signal });
      return { kind: "all" };
    },
    async scanDsh(options: unknown, signal?: AbortSignal) {
      calls.push({ kind: "dsh", options, signal });
      return { kind: "dsh" };
    }
  } as unknown as AgentAdapterCatalogService;
  const context = {
    service,
    jsonResponse: (_response: http.ServerResponse, statusCode: number, body: unknown) => {
      responses.push({ statusCode, body });
    }
  };

  assert.equal(handleAgentAdapterCatalogApi(
    request(),
    new URL("http://localhost/api/agent-adapters/catalog"),
    response(),
    context
  ), true);
  await settleRoute();

  assert.equal(handleAgentAdapterCatalogApi(
    request(),
    new URL("http://localhost/api/scan/agents?codexLimit=12&codexOffset=3&dshLimit=7&dshQuery=Rabi"),
    response(),
    context
  ), true);
  await settleRoute();

  assert.equal(handleAgentAdapterCatalogApi(
    request(),
    new URL("http://localhost/api/scan/agents/dsh?dshLimit=9&dshOffset=2&dshBaseUrl=http%3A%2F%2F127.0.0.1%3A3000"),
    response(),
    context
  ), true);
  await settleRoute();

  assert.equal(handleAgentAdapterCatalogApi(
    request(),
    new URL("http://localhost/api/agent-adapters/availability"),
    response(),
    context
  ), false);
  assert.equal(handleAgentAdapterCatalogApi(
    request(),
    new URL("http://localhost/api/agent-adapters/dsh/availability"),
    response(),
    context
  ), false);

  assert.deepEqual(calls.map(call => call.kind), ["catalog", "all", "dsh"]);
  assert.deepEqual(calls[1]?.options, {
    codexLimit: 12,
    codexOffset: 3,
    codexQuery: undefined,
    dshLimit: 7,
    dshOffset: 0,
    dshQuery: "Rabi",
    dshBaseUrl: undefined
  });
  assert.deepEqual(calls[2]?.options, {
    dshLimit: 9,
    dshOffset: 2,
    dshQuery: undefined,
    dshBaseUrl: "http://127.0.0.1:3000"
  });
  assert.equal(calls[1]?.signal?.aborted, false);
  assert.equal(calls[2]?.signal?.aborted, false);
  assert.deepEqual(responses, [
    { statusCode: 200, body: { code: 0, data: { schemaVersion: 1, adapters: [] } } },
    { statusCode: 200, body: { kind: "all" } },
    { statusCode: 200, body: { kind: "dsh" } }
  ]);
});
