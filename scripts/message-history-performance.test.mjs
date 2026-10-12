import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { handleMessageEndpointHistoryApi } from "../dist/manager/messageEndpointHistoryRoutes.js";
import { ManagerReadWorkerPool } from "../dist/manager/managerReadWorkerPool.js";

test("production history reader searches 100,000 records over HTTP within its deadline", { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-history-performance-"));
  const archive = path.join(root, "conversation", "archive");
  fs.mkdirSync(archive, { recursive: true });
  const epoch = 1767225600;
  const archives = [];
  const expected = [];
  for (let first = 1; first <= 100000; first += 5000) {
    const lines = [];
    for (let sequence = first; sequence < first + 5000; sequence++) {
      const matches = sequence % 997 === 0;
      if (matches) expected.push(sequence);
      lines.push(JSON.stringify({ schemaVersion: 1, id: `synthetic-${sequence}`, sequence,
        recordedAt: new Date((epoch + sequence) * 1000).toISOString(), time: epoch + sequence,
        direction: "inbound", adapter: "synthetic", channel: "synthetic", kind: "group",
        sender: "sender", target: "target", conversationKey: "synthetic:group",
        text: `${matches ? "needle" : "ordinary"} ${"x".repeat(160)}` }));
    }
    const last = first + 4999;
    const file = `${first}~${last}.jsonl`;
    fs.writeFileSync(path.join(archive, file), lines.join("\n") + "\n");
    archives.push({ file, entryCount: 5000, firstSequence: first, lastSequence: last,
      startedAt: new Date((epoch + first) * 1000).toISOString(), endedAt: new Date((epoch + last) * 1000).toISOString() });
  }
  fs.writeFileSync(path.join(archive, "index.json"), JSON.stringify({ schemaVersion: 1, nextSequence: 100001, archives }));
  fs.writeFileSync(path.join(root, "conversation", "current.jsonl"), "");
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 2, timeoutMs: 30000 });
  const json = (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/health") return json(response, 200, { live: true });
    if (!handleMessageEndpointHistoryApi(request, url, response, { roleDirectory: () => root, json,
      queryHistory: (roleDir, query, options) => pool.run({ type: "role_message_endpoint_history", roleDir, query }, options) })) json(response, 404, {});
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = base + "/api/roles/synthetic/message-endpoint-history?includeArchives=1&kind=group&query=needle&limit=20";
    const durations = [];
    for (let run = 0; run < 2; run++) {
      const began = performance.now();
      const request = fetch(url);
      const health = await fetch(base + "/health");
      assert.equal(health.status, 200);
      const response = await request;
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.data.entries.map(item => item.sequence), expected.slice(-20));
      durations.push(Math.round(performance.now() - began));
    }
    const missing = await fetch(url.replace("query=needle", "query=missing-token"));
    assert.equal(missing.status, 200);
    assert.equal((await missing.json()).data.count, 0);
    assert.ok(durations[1] < durations[0] * 0.6, `Archive reuse should avoid normalization: cold=${durations[0]}, warm=${durations[1]}`);
    console.log(JSON.stringify({ experiment: "production-history-100k-http", records: 100000, coldMs: durations[0], warmMs: durations[1] }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await pool.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production knowledge reader starts independently and reconciles only changed documents", { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-knowledge-reader-performance-"));
  const memory = path.join(root, "memory", "recent");
  fs.mkdirSync(memory, { recursive: true });
  for (let index = 0; index < 1000; index++) {
    fs.writeFileSync(path.join(memory, `${index}.json`), JSON.stringify({ id: `synthetic-${index}`, title: "Synthetic memory",
      focus: "reader acceptance", content: "body", keywords: ["needle"], createdAt: "2026-01-01", updatedAt: "2026-01-01" }));
  }
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, timeoutMs: 30000 });
  try {
    const began = performance.now();
    const first = await pool.run({ type: "knowledge_search_delta", roleDir: root, previous: {} });
    assert.equal(first.errors, 0);
    assert.equal(first.filesRead, 1000);
    assert.equal(first.changes.length, 1000);
    const coldMs = Math.round(performance.now() - began);
    const second = await pool.run({ type: "knowledge_search_delta", roleDir: root, previous: first.inventory });
    assert.equal(second.filesRead, 0);
    assert.equal(second.changes.length, 0);
    console.log(JSON.stringify({ experiment: "production-knowledge-reader-1000", coldMs, unchangedReads: second.filesRead }));
  } finally {
    await pool.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
