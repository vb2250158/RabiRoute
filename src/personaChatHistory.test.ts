import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { appendPersonaChatReply, readPersonaChatHistory } from "./personaChatHistory.js";
import { CodexHookContextService } from "./manager/codexHookContext.js";
import { publishRoleKnowledgeCatalogSnapshot, readRoleKnowledgeCatalogSnapshot } from "./roleKnowledge.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-chat-history-"));
  const roleDir = path.join(root, "roles", "Example");
  await fs.mkdir(roleDir, { recursive: true });
  await fs.writeFile(path.join(roleDir, "persona.md"), "# Example");
  publishRoleKnowledgeCatalogSnapshot(roleDir, readRoleKnowledgeCatalogSnapshot(roleDir));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, roleDir };
}

test("history preserves full Unicode replies and byte cursors across new appends", async t => {
  const { roleDir } = await fixture(t);
  const texts = ["最早", "很长的最终回复🦊\n".repeat(12000), "最新"];
  for (const [i, text] of texts.entries()) await appendPersonaChatReply(roleDir, { sessionId: "task", turnId: String(i), text });
  const newest = await readPersonaChatHistory(roleDir, undefined, 1);
  assert.equal(newest.entries[0].text, texts[2]);
  await appendPersonaChatReply(roleDir, { sessionId: "task", turnId: "3", text: "刚到" });
  const older = await readPersonaChatHistory(roleDir, newest.nextCursor!, 1);
  assert.equal(older.entries[0].text, texts[1]);
  const oldest = await readPersonaChatHistory(roleDir, older.nextCursor!, 1);
  assert.deepEqual(oldest.entries.map(item => item.text), [texts[0]]);
  assert.equal(oldest.nextCursor, null);
  assert.deepEqual((await readPersonaChatHistory(roleDir)).entries.map(item => item.text), ["刚到", ...texts.slice().reverse()]);
});

test("concurrent replay is idempotent and changes within a turn remain visible", async t => {
  const { roleDir } = await fixture(t);
  const reply = { sessionId: "task", turnId: "turn", text: "最终回复" };
  const results = await Promise.all(Array.from({ length: 10 }, () => appendPersonaChatReply(roleDir, reply)));
  assert.equal(results.filter(Boolean).length, 1);
  await appendPersonaChatReply(roleDir, { ...reply, text: "继续处理后的最终回复" });
  assert.equal((await readPersonaChatHistory(roleDir)).entries.length, 2);
  assert.equal(await appendPersonaChatReply(roleDir, { ...reply, text: "  " }), null);
  const file = path.join(roleDir, "chat-history", "final-replies.jsonl");
  const content = await fs.readFile(file, "utf8");
  await fs.writeFile(file, content); // External rewrite invalidates the derived ID cache.
  assert.equal(await appendPersonaChatReply(roleDir, reply), null);
  assert.equal((await readPersonaChatHistory(path.join(roleDir, "Other"))).entries.length, 0);
});

test("history rejects invalid cursors, reports damaged rows and preserves valid reads", async t => {
  const { roleDir } = await fixture(t);
  await appendPersonaChatReply(roleDir, { sessionId: "task", turnId: "turn", text: "reply" });
  for (const cursor of [-1, 1.5, 1, Number.NaN, 99999]) await assert.rejects(readPersonaChatHistory(roleDir, cursor));
  await assert.rejects(readPersonaChatHistory(roleDir, undefined, 0));
  await fs.appendFile(path.join(roleDir, "chat-history", "final-replies.jsonl"), "bad\n");
  const partial = await readPersonaChatHistory(roleDir);
  assert.equal(partial.entries.length, 1);
  assert.equal(partial.invalidRecords, 1);
  await assert.rejects(appendPersonaChatReply(roleDir, { sessionId: "task", turnId: "next", text: "reply" }));
});

test("Stop records bound final replies even when plan notifications are disabled; other events do not", async t => {
  const { root, roleDir } = await fixture(t);
  const events: string[] = [];
  const options = {
    rolesRoot: () => path.join(root, "roles"), storePath: path.join(root, "sessions.json"),
    hookEnabled: () => false, onChatHistoryChanged: (roleId: string) => events.push(roleId)
  };
  const service = new CodexHookContextService(options);
  service.bindSession("task", "Example");
  const request = { sessionId: "task", turnId: "turn", lastAssistantMessage: "完整最终回复", eventName: "Stop" as const };
  await service.handleHook({ ...request, eventName: "PostToolUse" });
  assert.equal((await readPersonaChatHistory(roleDir)).entries.length, 0);
  await service.handleHook(request);
  await new CodexHookContextService(options).handleHook(request);
  assert.deepEqual(events, ["Example"]);
  assert.equal((await readPersonaChatHistory(roleDir)).entries[0].text, request.lastAssistantMessage);
  await service.handleHook({ ...request, sessionId: "unbound" });
  await service.handleHook({ ...request, turnId: "" });
  assert.equal((await readPersonaChatHistory(roleDir)).entries.length, 1);
});

test("managed task ownership records unbound sessions and refuses ambiguous persona ownership", async t => {
  const { root, roleDir } = await fixture(t);
  const candidates = ["Example"];
  const service = new CodexHookContextService({
    rolesRoot: () => path.join(root, "roles"), storePath: path.join(root, "sessions.json"),
    hookEnabled: () => false, chatHistoryRoleIds: () => candidates
  });
  await service.handleHook({ sessionId: "managed-task", turnId: "1", eventName: "Stop", lastAssistantMessage: "Plan or primary task" });
  candidates.push("Other");
  await service.handleHook({ sessionId: "managed-task", turnId: "2", eventName: "Stop", lastAssistantMessage: "Ambiguous" });
  assert.equal((await readPersonaChatHistory(roleDir)).entries.length, 1);
});


test("summary and forward recovery page without building the complete identity projection", async t => {
  const { roleDir } = await fixture(t);
  const directory = path.join(roleDir, 'chat-history'); await fs.mkdir(directory);
  const file = path.join(directory, 'final-replies.jsonl');
  const records = Array.from({ length: 500 }, (_, number) => ({ id: String(number), sessionId: 'session', turnId: String(number), receivedAt: '2026-10-31T00:00:00Z', text: number === 499 ? 'long body'.repeat(3000) : 'reply' }));
  await fs.writeFile(file, records.map(record => JSON.stringify(record) + '\n').join(''));
  const newest = await readPersonaChatHistory(roleDir, undefined, 50, { summary: true });
  assert.equal(newest.entries.length, 50); assert.equal(newest.entries[0].text.length, 2000);
  assert.equal(newest.entries[0].textTruncated, true);
  await assert.rejects(fs.stat(file + '.index.sqlite'), { code: 'ENOENT' });
  const older = await readPersonaChatHistory(roleDir, newest.nextCursor!, 50, { summary: true });
  const recovered = await readPersonaChatHistory(roleDir, older.entries[0].historyEndCursor!, 50, { summary: true, direction: 'newer' });
  assert.deepEqual(recovered.entries.map(row => row.id), newest.entries.map(row => row.id));
  const full = await readPersonaChatHistory(roleDir, newest.entries[0].historyCursor!, 1, { direction: 'newer', id: '499' });
  assert.equal(full.entries[0].text, records[499].text);
  await assert.rejects(readPersonaChatHistory(roleDir, newest.entries[0].historyCursor!, 1, { direction: 'newer', id: 'wrong-id' }), /identity changed/);
});


test("incomplete final row leaves complete replies readable and writes uncertain", async t => {
  const { roleDir } = await fixture(t);
  await appendPersonaChatReply(roleDir, { sessionId: 'task', turnId: 'complete', text: 'retained' });
  const file = path.join(roleDir, 'chat-history', 'final-replies.jsonl');
  await fs.appendFile(file, '{"id":"unfinished');
  const page = await readPersonaChatHistory(roleDir, undefined, 50, { summary: true });
  assert.equal(page.entries[0].text, 'retained'); assert.equal(page.invalidRecords, 1); assert.equal(page.newerCursor, null);
  await assert.rejects(appendPersonaChatReply(roleDir, { sessionId: 'task', turnId: 'next', text: 'not safely deduplicated' }), /unknown identity/);
});


test("oversized damaged row and failed writer do not hide unrelated replies", async t => {
  const { roleDir } = await fixture(t);
  await appendPersonaChatReply(roleDir, { sessionId: 'task', turnId: 'valid', text: 'retained' });
  const file = path.join(roleDir, 'chat-history', 'final-replies.jsonl');
  await fs.appendFile(file, 'x'.repeat(3 * 1024 * 1024) + '\n');
  const failingWrite = appendPersonaChatReply(roleDir, { sessionId: 'task', turnId: 'next', text: 'unverified' });
  const read = readPersonaChatHistory(roleDir, undefined, 50, { summary: true });
  await assert.rejects(failingWrite, /unknown identity/);
  const page = await read; assert.equal(page.entries.length, 0); assert.equal(page.invalidRecords, 1);
  const continuation = await readPersonaChatHistory(roleDir, page.nextCursor!, 50, { summary: true });
  assert.equal(continuation.entries[0].text, 'retained');
  const forward = await readPersonaChatHistory(roleDir, 0, 50, { summary: true, direction: 'newer' });
  assert.equal(forward.entries[0].text, 'retained'); assert.equal(forward.invalidRecords, 1);
});


test("known damaged identity is not reported as a successful replay", async t => {
  const { roleDir } = await fixture(t);
  const input = { sessionId: 'task', turnId: 'record', text: 'original' };
  const record = await appendPersonaChatReply(roleDir, input);
  const file = path.join(roleDir, 'chat-history', 'final-replies.jsonl');
  await fs.writeFile(file, JSON.stringify({ id: record!.id }) + '\n');
  await assert.rejects(appendPersonaChatReply(roleDir, input), /identity is damaged/);
  const other = await appendPersonaChatReply(roleDir, { ...input, turnId: 'independent' });
  assert.ok(other); assert.equal((await readPersonaChatHistory(roleDir)).entries[0].id, other!.id);
});


test("checkpoint transaction failure preserves durable ledger and process restart reconciles the original identity", async t => {
  const { root, roleDir } = await fixture(t);
  await appendPersonaChatReply(roleDir, { sessionId: 'task', turnId: 'before', text: 'first' });
  const file = path.join(roleDir, 'chat-history', 'final-replies.jsonl');
  const indexFile = file + '.index.sqlite';
  const beforeSize = (await fs.stat(file)).size;
  const db = new DatabaseSync(indexFile);
  db.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON checkpoint BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END");
  db.close();
  const input = { sessionId: 'task', turnId: 'original-operation', text: 'durably appended before projection failed' };
  await assert.rejects(appendPersonaChatReply(roleDir, input), /injected checkpoint failure/);
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 2); assert.equal(rows[1].text, input.text);
  const failedProjection = new DatabaseSync(indexFile);
  assert.equal(Number(failedProjection.prepare('SELECT count(*) AS total FROM history').get()!.total), 1);
  assert.equal(JSON.parse(String(failedProjection.prepare('SELECT value FROM checkpoint').get()!.value)).size, beforeSize);
  assert.equal(failedProjection.prepare('SELECT id FROM history WHERE id=?').get(rows[1].id), undefined);
  // The failure was after durable ledger append: valid reads and another role remain available.
  assert.equal((await readPersonaChatHistory(roleDir)).entries[0].id, rows[1].id);
  assert.ok(await appendPersonaChatReply(path.join(root, 'Independent'), { sessionId: 'other', turnId: 'turn', text: 'unaffected' }));
  failedProjection.exec('DROP TRIGGER fail_checkpoint'); failedProjection.close();
  const child = path.join(root, 'replay.mts');
  const ownerModule = pathToFileURL(path.resolve('src/personaChatHistory.ts')).href;
  await fs.writeFile(child, `import {appendPersonaChatReply} from ${JSON.stringify(ownerModule)};\nconst result=await appendPersonaChatReply(${JSON.stringify(roleDir)},${JSON.stringify(input)});\nconsole.log(JSON.stringify({deduplicated:result===null}));\n`);
  const restarted = await promisify(execFile)(process.execPath, ['--import', 'tsx', child], { cwd: process.cwd(), timeout: 30000 });
  assert.deepEqual(JSON.parse(restarted.stdout.trim()), { deduplicated: true });
  const recovered = new DatabaseSync(indexFile);
  try {
    assert.equal(Number(recovered.prepare('SELECT count(*) AS total FROM history').get()!.total), 2);
    assert.equal(JSON.parse(String(recovered.prepare('SELECT value FROM checkpoint').get()!.value)).size, (await fs.stat(file)).size);
    assert.equal((await fs.readFile(file, 'utf8')).trim().split('\n').length, 2);
  } finally { recovered.close(); }
});
