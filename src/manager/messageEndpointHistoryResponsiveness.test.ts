import { refreshMessageHistoryIndex, type MessageHistorySearchProbe, type MessageHistorySearchResult } from "../messageHistorySearchIndex.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { configureTimeouts, readTimeoutOverrides } from "../shared/timeoutSettings.js";
import { dispatchMessageHistoryFixture } from "./personaHistoryOperationTestFixtures.js";
import { ManagerReadWorkerPool, ManagerReadWorkerError } from "./managerReadWorkerPool.js";
import { recentMessageContextItems, type RecentMessageContextQuery } from "../messageContextStore.js";

function queryIndexedHistory(pool: ManagerReadWorkerPool, roleDir: string, query: RecentMessageContextQuery,
  options: { signal?: AbortSignal }): Promise<MessageHistorySearchResult> {
  return pool.run<MessageHistorySearchProbe>({ type: "message_history_search", roleDir, query, indexPath: path.join(roleDir, "search.sqlite") }, options)
    .then(probe => {
      if (!probe.ready) throw new ManagerReadWorkerError(probe.reason, "busy");
      return probe.result;
    });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-http-isolation-"));
  const archive = path.join(root, "conversation", "archive");
  fs.mkdirSync(archive, { recursive: true });
  const record = (sequence: number) => ({ schemaVersion: 1, id: `synthetic-${sequence}`, sequence,
    time: 1767225600 + sequence, recordedAt: new Date((1767225600 + sequence) * 1000).toISOString(),
    direction: "inbound", adapter: "synthetic", channel: "synthetic", kind: "text", sender: "sender", target: "target",
    conversationKey: "synthetic-conversation", text: `needle 中文合 %_ ${"x".repeat(200)}` });
  const file = path.join(archive, "1~2000.jsonl");
  fs.writeFileSync(file, Array.from({ length: 2000 }, (_, i) => JSON.stringify(record(i + 1))).join("\n") + "\n");
  fs.writeFileSync(path.join(root, "conversation", "current.jsonl"), JSON.stringify(record(2001)) + "\n");
  fs.writeFileSync(path.join(archive, "index.json"), JSON.stringify({ schemaVersion: 1, nextSequence: 2002,
    archives: [{ file: "1~2000.jsonl", startedAt: record(1).recordedAt, endedAt: record(2000).recordedAt,
      entryCount: 2000, firstSequence: 1, lastSequence: 2000 }] }));
  refreshMessageHistoryIndex(root, path.join(root, "search.sqlite"));
  return { root, file };
}

test("failed history queries return the request ID passed to the read service", async t => {
  let requestId: string | undefined;
  const server = http.createServer((request, response) => {
    dispatchMessageHistoryFixture(request, new URL(request.url || "/", "http://fixture.invalid"), response, {
      roleDirectory: () => "synthetic-role",
      json: (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); },
      queryHistory: async (_directory, _query, options) => { requestId = options.requestId; throw new ManagerReadWorkerError("SEARCH_BUSY", "busy"); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const response = await requestHistory(`http://127.0.0.1:${address.port}/api/roles/synthetic/message-endpoint-history`).result;
  assert.equal(response.error, undefined);
  const body = response.body;
  assert.equal(response.status, 503); assert.equal(body.errorCode, "SEARCH_BUSY");
  assert.match(body.requestId, /^[a-f0-9-]{36}$/); assert.equal(body.requestId, requestId);
});

const clientSource = `
const { parentPort } = require('node:worker_threads');
const http = require('node:http');
let base;
function get(url) { return new Promise((resolve,reject) => {
  const request=http.get(url,response=>{let body='';response.setEncoding('utf8');response.on('data',part=>body+=part);
    response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(body)}));});request.on('error',reject);
}); }
parentPort.on('message',async message=>{try {
  if(message.type==='start'){base=message.base;const result=await get(base+'/api/roles/synthetic/message-endpoint-history?limit=20&includeArchives=1&query=needle');parentPort.postMessage({type:'history',result});}
  if(message.type==='history-started'){const began=performance.now();const result=await get(base+'/health');parentPort.postMessage({type:'health',result,ms:performance.now()-began});}
}catch(error){parentPort.postMessage({type:'failure',error:String(error)});}});
parentPort.postMessage({type:'ready'});
`;

test("history uses the real bounded reader while an independent HTTP client can reach health", { timeout: 15000 }, async t => {
  const data = fixture();
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 2, timeoutMs: 8000 });
  const client = new Worker(clientSource, { eval: true });
  let parentReads = 0;
  let injectedQueries = 0;
  const originalRead = fs.readFileSync;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  // Model slow synchronous storage at the actual old call site, not a fake HTTP handler.
  // The child reader has its own fs module and must never execute this parent hook.
  t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === data.file) { parentReads++; Atomics.wait(wait, 0, 0, 350); }
    return Reflect.apply(originalRead, fs, args);
  }) as typeof fs.readFileSync);
  const context = {
    roleDirectory: () => data.root,
    json: (response: http.ServerResponse, status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); },
    queryHistory: (roleDir: string, query: RecentMessageContextQuery, options: { signal?: AbortSignal }) => {
      injectedQueries++;
      return queryIndexedHistory(pool, roleDir, query, options);
    }
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/health") { context.json(response, 200, { live: true }); return; }
    client.postMessage({ type: "history-started" });
    if (!dispatchMessageHistoryFixture(request, url, response, context)) context.json(response, 404, {});
  });
  try {
    const ready = new Promise<void>((resolve, reject) => { client.once("error", reject); client.once("message", () => resolve()); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    await ready;
    await pool.run({ type: "message_history_search", roleDir: data.root, query: { limit: 1 }, indexPath: path.join(data.root, "search.sqlite") }, { timeoutMs: 10000 });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const messages: Array<{ type: string; result: { status: number; body: any }; ms?: number }> = [];
    const completed = new Promise<void>((resolve, reject) => {
      client.on("message", message => {
        if (message.type === "failure") { reject(new Error(message.error)); return; }
        messages.push(message); if (messages.length === 2) resolve();
      });
      client.once("error", reject);
    });
    client.postMessage({ type: "start", base: `http://127.0.0.1:${address.port}` });
    await completed;
    assert.equal(injectedQueries, 1, "the HTTP route must delegate rather than read storage inline");
    assert.equal(parentReads, 0, "history storage must never be read in the HTTP event loop");
    const history = messages.find(item => item.type === "history")!;
    const health = messages.find(item => item.type === "health")!;
    assert.equal(history.result.status, 200); assert.equal(history.result.body.data.entries.length, 20);
    assert.equal(history.result.body.data.entries.at(-1).sequence, 2001);
    assert.equal(health.result.status, 200); assert.equal(health.result.body.live, true);
    assert.ok(health.ms! < 1000, "indexed search must leave the independent health request responsive");
    console.log(JSON.stringify({ experiment: "history-http-isolation", healthMs: health.ms, parentReads, returned: 20 }));
  } finally {
    await client.terminate(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.stop(); fs.rmSync(data.root, { recursive: true, force: true });
  }
});

function json(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
}

async function serve(context: Parameters<typeof dispatchMessageHistoryFixture>[3]) {
  const server = http.createServer((request, response) => {
    if (!dispatchMessageHistoryFixture(request, new URL(request.url!, "http://127.0.0.1"), response, context)) json(response, 404, {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}/api/roles/synthetic/message-endpoint-history`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

function requestHistory(url: string) {
  let request!: http.ClientRequest;
  const result = new Promise<{ status?: number; body?: any; error?: Error }>(resolve => {
    request = http.get(url, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", part => body += part);
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", error => resolve({ error }));
  });
  return { request, result };
}

test("history labels bounded coverage and rejects unsupported pagination before reading", async () => {
  let reads = 0;
  const service = await serve({ roleDirectory: () => "synthetic", json,
    queryHistory: async () => { reads++; return []; } });
  try {
    const result = await requestHistory(service.url + "?includeArchives=1&limit=9999&maxChars=999999&from=1767225600&to=1767229200").result;
    assert.equal(result.status, 200);
    const coverage = result.body.data.coverage;
    assert.equal(coverage.recordScope, "saved_role_messages");
    assert.equal(coverage.resultMode, "latest_matches");
    assert.equal(coverage.completenessUnknown, true, "an empty excerpt must not imply complete coverage");
    assert.equal(coverage.paginationSupported, false);
    assert.equal(coverage.limit, 200);
    assert.equal(coverage.maxChars, 200000);
    assert.equal(coverage.from, 1767225600);
    assert.equal(coverage.to, 1767229200);
    assert.equal(coverage.limitReducesArchiveScan, false);
    for (const query of ["cursor=example", "offset=200", "cursor="]) {
      const invalid = await requestHistory(service.url + "?" + query).result;
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.errorCode, "MESSAGE_HISTORY_PAGINATION_UNSUPPORTED");
      assert.equal(invalid.body.retryable, false);
    }
    for (const query of ["from=2026-01-01", "to=NaN", "from=", "from=200&to=100"]) {
      const invalid = await requestHistory(service.url + "?includeArchives=1&" + query).result;
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.errorCode, "MESSAGE_HISTORY_TIME_RANGE_INVALID");
      assert.equal(invalid.body.retryable, false);
    }
    assert.equal(reads, 1, "invalid pagination or time ranges must not scan storage");
  } finally { await service.close(); }
});

test("history worker preserves every HTTP filter, archive selection, character budget and business errors", { timeout: 15000 }, async () => {
  const data = fixture(); const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, timeoutMs: 8000 });
  const seen: RecentMessageContextQuery[] = [];
  const service = await serve({ roleDirectory: roleId => { if (roleId !== "synthetic") throw new Error("unknown role"); return data.root; }, json,
    queryHistory: (roleDir, query, options) => { seen.push(query); return queryIndexedHistory(pool, roleDir, query, options); } });
  try {
    const queries: RecentMessageContextQuery[] = [
      { limit: 20, maxChars: 200000, includeArchives: false },
      { limit: 50, maxChars: 200000, includeArchives: true, adapter: "synthetic", channel: "synthetic", kind: "text", sender: "sender", target: "target", conversationKey: "synthetic-conversation", query: "needle 中文合 %_", queryMatch: "all", from: 1767227580, to: 1767227590 },
      { limit: 20, maxChars: 300, includeArchives: true, query: "needle" },
      { limit: 20, maxChars: 200000, includeArchives: true, query: "absent-token" }
    ];
    await pool.run({ type: "message_history_search", roleDir: data.root, query: { limit: 1 }, indexPath: path.join(data.root, "search.sqlite") }, { timeoutMs: 10000 });
    for (const query of queries) {
      const parameters = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) parameters.set(key === "queryMatch" ? "match" : key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
      const result = await requestHistory(`${service.url}?${parameters}`).result;
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.data.entries, JSON.parse(JSON.stringify(recentMessageContextItems([data.root], query))));
      assert.equal(result.body.data.count, result.body.data.entries.length);
      assert.equal(result.body.data.coverage.includeArchives, query.includeArchives);
    }
    assert.equal(seen.length, queries.length);
    const invalid = await requestHistory(service.url.replace("/synthetic/", "/unknown/")).result;
    assert.equal(invalid.status, 400); assert.equal(invalid.body.message, "unknown role");
    assert.equal(seen.length, queries.length, "invalid role must not reach the reader");
  } finally { await service.close(); await pool.stop(); fs.rmSync(data.root, { recursive: true, force: true }); }
});

function blockedReader(data: ReturnType<typeof fixture>, timeoutMs: number) {
  const hook = path.join(data.root, "slow-test-storage.mjs");
  fs.writeFileSync(hook, `import {DatabaseSync} from 'node:sqlite';const prepare=DatabaseSync.prototype.prepare;let entered=false;let blocking=false;process.on('message',r=>{blocking=r.task?.query?.includeArchives===true;});DatabaseSync.prototype.prepare=function(sql,...args){if(blocking&&String(sql).includes('ORDER BY d.sourceOrder DESC,d.position DESC,d.rowid DESC')&&!entered){entered=true;process.send?.({type:'test-history-read-entered'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,4000);}return Reflect.apply(prepare,this,[sql,...args]);};`);
  let enteredResolve!: () => void; let exitedResolve!: () => void;
  const entered = new Promise<void>(resolve => enteredResolve = resolve);
  const exited = new Promise<void>(resolve => exitedResolve = resolve);
  const pids: number[] = [];
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs,
    terminationTimeoutMs: 300, forceTerminationTimeoutMs: 300,
    workerFactory: () => {
      const child = fork(fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./managerReadWorker.ts" : "./managerReadWorker.js", import.meta.url)), [], {
        execArgv: [...(import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : []), "--import", pathToFileURL(hook).href],
        env: { ...process.env, RABIROUTE_MANAGER_READ_PROCESS: "1", RABI_TEST_HISTORY_FILE: data.file },
        serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"]
      });
      if (child.pid) pids.push(child.pid);
      child.on("message", (message: any) => { if (message?.type === "test-history-read-entered") enteredResolve(); });
      child.once("exit", () => exitedResolve());
      return child;
    }
  });
  return { pool, entered, exited, pids };
}

test("history queue saturation returns 503 and client abort retires the genuinely blocked worker", { timeout: 15000 }, async () => {
  const data = fixture(); const reader = blockedReader(data, 10000);
  let queries = 0; let queuedResolve!: () => void; let cancelledResolve!: () => void;
  const queued = new Promise<void>(resolve => queuedResolve = resolve);
  const cancelled = new Promise<void>(resolve => cancelledResolve = resolve);
  const service = await serve({ roleDirectory: () => data.root, json, queryHistory: (roleDir, query, options) => {
    queries++; const result = queryIndexedHistory(reader.pool, roleDir, query, options);
    if (queries === 2) { options.signal.addEventListener("abort", () => cancelledResolve(), { once: true }); queuedResolve(); }
    return result;
  } });
  try {
    await reader.pool.run({ type: "message_history_search", roleDir: data.root, query: { limit: 1 }, indexPath: path.join(data.root, "search.sqlite") }, { timeoutMs: 10000 });
    const active = requestHistory(`${service.url}?includeArchives=1`);
    await Promise.race([reader.entered, active.result.then(result => {
      throw new Error(`History reader failed before entering storage: ${result.status ?? result.error?.message}`);
    })]);
    const pending = requestHistory(`${service.url}?includeArchives=1`); await queued;
    const rejected = await requestHistory(`${service.url}?includeArchives=1`).result;
    assert.equal(rejected.status, 503); assert.equal(rejected.body.code, -1);
    assert.equal(reader.pool.status().active, 1); assert.equal(reader.pool.status().queued, 1);
    pending.request.destroy(); await cancelled; await pending.result;
    active.request.destroy(); await active.result; await reader.exited;
    assert.equal(reader.pids.length, 1, "cancelled queued work must not spawn another process");
    assert.equal(reader.pool.status().active, 0); assert.equal(reader.pool.status().queued, 0);
    assert.equal(reader.pool.status().workerPids.includes(reader.pids[0]!), false);
  } finally { await service.close(); await reader.pool.stop(); fs.rmSync(data.root, { recursive: true, force: true }); }
});

test("history deadline returns 503 and confirms blocked child exit before releasing its slot", { timeout: 15000 }, async () => {
  const data = fixture(); const reader = blockedReader(data, 2500);
  const service = await serve({ roleDirectory: () => data.root, json,
    queryHistory: (roleDir, query, options) => queryIndexedHistory(reader.pool, roleDir, query, options) });
  try {
    // Measure the storage deadline independently of cold tsx/module startup.
    await reader.pool.run({ type: "message_history_search", roleDir: data.root, query: { limit: 1 }, indexPath: path.join(data.root, "search.sqlite") }, { timeoutMs: 10000 });
    const request = requestHistory(`${service.url}?includeArchives=1`);
    await Promise.race([reader.entered, request.result.then(result => {
      throw new Error(`History reader failed before entering storage: ${result.status ?? result.error?.message}`);
    })]);
    const result = await request.result;
    assert.equal(result.status, 503); assert.equal(result.body.code, -1);
    await reader.exited;
    assert.equal(reader.pool.status().active, 0); assert.equal(reader.pool.status().queued, 0);
    assert.equal(reader.pool.status().workerPids.includes(reader.pids[0]!), false);
  } finally { await service.close(); await reader.pool.stop(); fs.rmSync(data.root, { recursive: true, force: true }); }
});


test("history HTTP deadline includes a reader that never settles", { timeout: 6000 }, async () => {
  let aborted = false;
  const service = await serve({ roleDirectory: () => 'synthetic', json, queryHistory: (_directory, _query, { signal }) => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  } });
  try {
    const start = performance.now();
    const result = await requestHistory(service.url).result;
    assert.equal(result.status, 503); assert.equal(result.body.errorCode, 'SEARCH_DEADLINE_EXCEEDED');
    assert.equal(aborted, true); assert.ok(performance.now() - start < 3000);
  } finally { await service.close(); }
});

test("history honors a shorter remaining client budget and validates its range", async () => {
  let queries = 0; let aborted = false;
  const service = await serve({ roleDirectory: () => "synthetic", json, queryHistory: (_directory, _query, options) => {
    queries++; assert.ok(Number.isFinite(options.deadlineAt)); assert.ok(options.deadlineAt! - performance.now() <= 40); assert.ok(options.requestId);
    options.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  } });
  try {
    for (const budget of ["0", "-1", "2147483648", "2.5", "NaN", ""]) {
      const result = await requestHistory(service.url + "?budgetMs=" + encodeURIComponent(budget)).result;
      assert.equal(result.status, 400); assert.equal(result.body.errorCode, "MESSAGE_HISTORY_BUDGET_INVALID");
    }
    assert.equal(queries, 0);
    const start = performance.now();
    const result = await requestHistory(service.url + "?budgetMs=40").result;
    assert.equal(result.status, 503); assert.equal(result.body.errorCode, "SEARCH_DEADLINE_EXCEEDED");
    assert.ok(performance.now() - start < 500); assert.equal(aborted, true);
  } finally { await service.close(); }
});

test("history preserves explicit budgets above three seconds and applies the configured default", async () => {
  const previous = readTimeoutOverrides();
  const remaining: number[] = [];
  const service = await serve({ roleDirectory: () => "synthetic", json, queryHistory: async (_directory, _query, options) => {
    remaining.push(options.deadlineAt! - performance.now());
    return [];
  } });
  try {
    configureTimeouts({ ...previous, "history.request": 7500 });
    assert.equal((await requestHistory(service.url).result).status, 200);
    configureTimeouts({ ...previous, "history.request": 2500 });
    assert.equal((await requestHistory(service.url + "?budgetMs=8000").result).status, 200);
    assert.ok(remaining[0]! > 7000 && remaining[0]! <= 7500);
    assert.ok(remaining[1]! > 7500 && remaining[1]! <= 8000);
  } finally { configureTimeouts(previous); await service.close(); }
});

test("history exposes index snapshot versions without changing bounded excerpt coverage", async () => {
  const service = await serve({ roleDirectory: () => "synthetic", json, queryHistory: async () => ({ entries: [],
    coverage: { indexVersion: "index-version", sourceVersion: "source-version", indexedAt: "2026-10-20T00:00:00.000Z", sourceSnapshotIndexed: true },
    metrics: { strategy: "postings", candidates: 0, elapsedMs: 1 } }) });
  try {
    const result = await requestHistory(service.url).result;
    assert.equal(result.status, 200); assert.equal(result.body.data.count, 0);
    assert.equal(result.body.data.coverage.indexVersion, "index-version");
    assert.equal(result.body.data.coverage.sourceVersion, "source-version");
    assert.equal(result.body.data.coverage.completenessUnknown, true);
    assert.equal(result.body.data.coverage.paginationSupported, false);
    assert.equal(result.body.data.metrics, undefined); assert.match(result.body.requestId, /^[a-f0-9-]{36}$/);
  } finally { await service.close(); }
});
