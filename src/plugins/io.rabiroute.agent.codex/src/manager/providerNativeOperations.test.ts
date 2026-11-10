import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import * as zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { listCodexNativeSessionPage } from "../codexDesktopBridge.js";
import { CodexNativeHistoryReader, createCodexNativeOperations } from "./providerNativeOperations.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "../../../../manager/connectionRequestAccess.js";
import { nativeHttpTestFetch as request } from "../../../../manager/nativeHttpTestClient.js";

const sessionId = "fixture-native-codex";
const metadata = JSON.stringify({ type: "session_meta", payload: { id: sessionId } });
function temporary(t: { after(fn: () => unknown): void }, text: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-history-"));
  const rollout = path.join(root, "native.jsonl");
  fs.writeFileSync(rollout, text);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    rollout,
    reader: new CodexNativeHistoryReader(id => id === sessionId ? { id, rolloutPath: rollout } : undefined)
  };
}

test("Codex history pages preserve native message/tool IDs, seek plain byte cursors and continue appended events", async t => {
  const records = [metadata, JSON.stringify({
    type: "response_item",
    payload: { id: "native-message-1", role: "user", content: [{ type: "input_text", text: "original" }] }
  }), JSON.stringify({
    type: "response_item",
    payload: { id: "native-tool-1", type: "function_call", call_id: "call-1", arguments: "{}" }
  })];
  const f = temporary(t, records.join("\r\n") + "\r\n");
  const starts: Array<number | undefined> = [], open = fs.promises.open;
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    const handle = await open(...args), create = handle.createReadStream;
    handle.createReadStream = function(options) { starts.push(options?.start); return create.call(handle, options); };
    return handle;
  }) as typeof open;
  t.after(() => { fs.promises.open = open; });
  const first = await f.reader.read(sessionId, { limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.equal((first.entries[1]!.record as any).payload.id, "native-message-1");
  assert(first.nextCursor);
  const second = await f.reader.read(sessionId, { limit: 2, cursor: first.nextCursor });
  assert.equal((second.entries[0]!.record as any).payload.call_id, "call-1");
  assert.equal(second.entries[0]!.sequence, 3);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(starts, [0, JSON.parse(Buffer.from(first.nextCursor, "base64url").toString()).offset]);
  fs.appendFileSync(f.rollout, JSON.stringify({ type: "response_item", payload: { id: "native-tool-result", call_id: "call-1", output: "kept" } }) + "\n");
  const appended = await f.reader.read(sessionId, { cursor: second.resumeCursor });
  assert.equal(appended.entries.length, 1);
  assert.equal(appended.entries[0]!.sequence, 4);
  assert.equal((appended.entries[0]!.record as any).payload.id, "native-tool-result");
});

test("Codex invalid rows stay local and an incomplete tail retains its exact restart cursor", async t => {
  const f = temporary(t, metadata + "\n" + "invalid-native-row".repeat(100) + "\n" + JSON.stringify({ type: "response_item", payload: { id: "kept" } }) + "\n" + '{"type":"response_item"');
  const page = await f.reader.read(sessionId, { maxBytes: 512 });
  assert.equal(page.entries.length, 2);
  assert.deepEqual(page.warnings, [{ sequence: 2, errorCode: "CODEX_HISTORY_ROW_INVALID" }]);
  assert.equal(page.coverage.pendingTail, true);
  assert.equal(page.coverage.lastSequence, 3);
  fs.appendFileSync(f.rollout, ',"payload":{"id":"finished"}}\n');
  const next = await f.reader.read(sessionId, { cursor: page.resumeCursor });
  assert.equal((next.entries[0]!.record as any).payload.id, "finished");
  assert.equal(next.entries[0]!.sequence, 4);
});

test("Codex complete large events require an explicit larger page budget without losing the event", async t => {
  const f = temporary(t, metadata + "\n" + JSON.stringify({ type: "response_item", payload: { id: "large", content: "x".repeat(2000) } }) + "\n");
  const first = await f.reader.read(sessionId, { limit: 1 });
  await assert.rejects(f.reader.read(sessionId, { cursor: first.nextCursor!, maxBytes: 500 }), /requires .* bytes/);
  const next = await f.reader.read(sessionId, { cursor: first.nextCursor!, maxBytes: 4000 });
  assert.equal((next.entries[0]!.record as any).payload.content.length, 2000);
  await assert.rejects(f.reader.read("another-session", { cursor: first.nextCursor! }), /not found/);
  await assert.rejects(f.reader.read(sessionId, { signal: AbortSignal.abort() }), /abort/i);
  fs.writeFileSync(f.rollout, JSON.stringify({ type: "session_meta", payload: { id: "wrong-task" } }) + "\n");
  await assert.rejects(f.reader.read(sessionId), /does not belong/);
});

test("Codex compressed native histories reuse the same decoded archive for subsequent pages", { skip: !(zlib as any).zstdCompressSync }, async t => {
  const f = temporary(t, metadata + "\n"), archived = f.rollout + ".zst";
  fs.writeFileSync(archived, (zlib as any).zstdCompressSync(Buffer.from(metadata + "\n" + JSON.stringify({ type: "response_item", payload: { id: "archive-original" } }) + "\n")));
  fs.unlinkSync(f.rollout);
  const open = fs.promises.open;
  let archiveReads = 0;
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]) === archived) archiveReads++;
    return handle;
  }) as typeof open;
  t.after(() => { fs.promises.open = open; });
  const first = await f.reader.read(sessionId, { limit: 1 });
  const second = await f.reader.read(sessionId, { cursor: first.nextCursor! });
  assert.equal((second.entries[0]!.record as any).payload.id, "archive-original");
  assert.equal(second.coverage.lastSequence, 2);
  assert.equal(archiveReads, 1);
});

test("Codex public operations expose real history through the normal registered HTTP contract", async t => {
  const f = temporary(t, metadata + "\n" + JSON.stringify({ type: "response_item", payload: { id: "http-native" } }) + "\n");
  const registry = new ManagerPluginRouteRegistry();
  const operations = createCodexNativeOperations({ history: f.reader, listSessions: () => ({ items: [{ id: sessionId }], nextOffset: 1 }) });
  const registration = registry.registerOperations("fixture.codex", operations);
  const server = http.createServer(async (req, res) => {
    markAuthenticatedConnectionRequest(req);
    if (!await registry.handle(req, new URL(req.url!, "http://localhost"), res)) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await registration.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent/providers/codex/sessions`;
  const listed = await request(root + "?limit=1");
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).data.nextOffset, 1);
  const response = await request(root + `/${sessionId}/history?limit=1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.source, "codex-native-rollout");
  assert(body.data.nextCursor);
  const next = await request(root + `/${sessionId}/history?cursor=${encodeURIComponent(body.data.nextCursor)}`);
  assert.equal(next.status, 200);
  assert.equal((await next.json()).data.entries[0].record.payload.id, "http-native");
  const missing = await request(root + "/missing/history");
  assert.equal(missing.status, 404);
});


test("Codex native session pages reach rows beyond the legacy ten-thousand scan budget", t => {
  const f = temporary(t, metadata + "\n");
  const databasePath = path.join(f.root, "native-state.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT,
    updated_at INTEGER, updated_at_ms INTEGER, recency_at INTEGER, recency_at_ms INTEGER,
    archived INTEGER, first_user_message TEXT)`);
  const insert = db.prepare("INSERT INTO threads VALUES (?, 'native title', 'fixture', '', 1, ?, 1, ?, 0, '')");
  db.exec("BEGIN");
  for (let index = 0; index < 10003; index++) insert.run(`native-session-${index}`, 20000 - index, 20000 - index);
  db.exec("COMMIT"); db.close();
  const page = listCodexNativeSessionPage({ databasePath, sessionIndexPath: path.join(f.root, "no-sidebar-index"), offset: 10000, limit: 2 });
  assert.deepEqual(page.items.map(row => row.id), ["native-session-10000", "native-session-10001"]);
  assert.equal(page.nextOffset, 10002);
  const last = listCodexNativeSessionPage({ databasePath, sessionIndexPath: path.join(f.root, "no-sidebar-index"), offset: page.nextOffset!, limit: 2 });
  assert.deepEqual(last.items.map(row => row.id), ["native-session-10002"]); assert.equal(last.nextOffset, null);
});
