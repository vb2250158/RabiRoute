import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import test from "node:test";
import { EffectScope } from "../plugin-kernel/effectScope.js";
import {
  handleAgentAdapterCatalogApi,
  mountAgentAdapterCatalogPlugin,
  type AgentAdapterCatalogServiceOptions,
  AgentAdapterCatalogService
} from "./agentAdapterCatalog.js";

test("catalog stop cancels and joins only the queries it started, retaining shared provider availability", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const provider = {
    type: "fixture",
    invoke: async (_operation: string, _payload: unknown, invocation?: { signal?: AbortSignal }) => {
      if (!invocation?.signal) return { agents: {}, cwdOptions: [] };
      entered();
      await new Promise<void>(resolve => invocation.signal!.addEventListener("abort", () => resolve(), { once: true }));
      invocation.signal.throwIfAborted();
    }
  } as unknown as import("./agentManagerProviders.js").AgentManagerProvider;
  const service = new AgentAdapterCatalogService({ rootDir: ".", getRuntimes: () => [], getProviders: () => [provider] });
  const query = service.scanOne("fixture");
  const rejected = assert.rejects(query);
  await started;
  assert.equal(service.activeCount(), 1);
  await service.stop("catalog retired");
  await rejected;
  assert.equal(service.activeCount(), 0);
  assert.throws(() => service.scanOne("fixture"), /stopping/);
  assert.deepEqual(await provider.invoke("scan", {}), { agents: {}, cwdOptions: [] });
});

test("catalog retirement keeps an unconfirmed API registration cleanup in its original owner fence", async () => {
  const scope = new EffectScope();
  let disposals = 0;
  const mount = await mountAgentAdapterCatalogPlugin({
    rootDir: ".", getRuntimes: () => [], adopt: dispose => scope.adopt(dispose),
    registerOperations: async () => ({
      async dispose() { disposals++; throw new Error("fixture API retirement failed"); }
    }) as unknown as import("./apiOperationContract.js").ApiOperationRegistration
  });
  await assert.rejects(mount.stop(), AggregateError);
  await assert.rejects(scope.dispose(), AggregateError);
  assert.equal(scope.retirementConfirmed(), false);
  assert.equal(disposals, 1);
});

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

test("Grok explicit scan forwards its paging and profile only to the dedicated worker", async () => {
  const calls: unknown[] = [];
  const service = {
    scanAll: () => { throw new Error("unexpected full scan"); },
    scanDsh: () => { throw new Error("unexpected DSH scan"); },
    async scanGrokBot(options: unknown, signal?: AbortSignal) {
      calls.push(options); assert.equal(signal instanceof AbortSignal, true);
      return { agents: { grokBot: { sessions: [] } } };
    }
  } as unknown as AgentAdapterCatalogService;
  const statuses: number[] = [];
  assert.equal(handleAgentAdapterCatalogApi(request(), new URL("http://localhost/api/scan/agents/grokBot?grokBotLimit=25&grokBotOffset=50&grokBotQuery=existing&grokBotAgentId=owner&grokBotProfilePath=C%3A%2Fprofiles%2Fa&grokBotBackendUrl=https%3A%2F%2Fapi2.cursor.sh%2F"), response(), {
    service, jsonResponse: (_res, status) => { statuses.push(status); }
  }), true);
  await settleRoute();
  assert.deepEqual(statuses, [200]);
  assert.deepEqual(calls, [{ grokBotLimit: 25, grokBotOffset: 50, grokBotQuery: "existing", grokBotAgentId: "owner", grokBotProfilePath: "C:/profiles/a", grokBotBackendUrl: "https://api2.cursor.sh/" }]);
});

test("Agent adapter catalog exposes catalog, scan, and Hook update routes", async () => {
  const calls: Array<{ kind: string; options?: unknown; signal?: AbortSignal }> = [];
  const responses: RecordedResponse[] = [];
  const service = {
    async updateHooks(adapter: string) {
      calls.push({ kind: `hooks:${adapter}` });
      return { message: "updated" };
    },
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
    request("POST"),
    new URL("http://localhost/api/agent-adapters/hooks/update?adapter=codex"),
    response(),
    context
  ), true);
  await settleRoute();

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

  assert.deepEqual(calls.map(call => call.kind), ["hooks:codex", "catalog", "all", "dsh"]);
  assert.deepEqual(calls[2]?.options, {
    grokBotAgentId: undefined,
    grokBotBackendUrl: undefined,
    grokBotLimit: 100,
    grokBotOffset: 0,
    grokBotProfilePath: undefined,
    grokBotQuery: undefined,
    codexLimit: 12,
    codexOffset: 3,
    codexQuery: undefined,
    dshLimit: 7,
    dshOffset: 0,
    dshQuery: "Rabi",
    dshBaseUrl: undefined
  });
  assert.deepEqual(calls[3]?.options, {
    dshLimit: 9,
    dshOffset: 2,
    dshQuery: undefined,
    dshBaseUrl: "http://127.0.0.1:3000"
  });
  assert.equal(calls[2]?.signal?.aborted, false);
  assert.equal(calls[3]?.signal?.aborted, false);
  assert.deepEqual(responses, [
    { statusCode: 200, body: { ok: true, message: "updated" } },
    { statusCode: 200, body: { code: 0, data: { schemaVersion: 1, adapters: [] } } },
    { statusCode: 200, body: { kind: "all" } },
    { statusCode: 200, body: { kind: "dsh" } }
  ]);
});

