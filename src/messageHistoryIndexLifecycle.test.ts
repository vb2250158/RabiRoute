import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { acquireMessageIndexLease, collectMessageIndexGenerations, refreshManagedMessageIndex, rollbackMessageIndex } from "./messageHistoryIndexLifecycle.js";
import { refreshMessageHistoryIndex, searchMessageHistoryIndex } from "./messageHistorySearchIndex.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-index-lifecycle-"));
  const role = path.join(root, "role");
  fs.mkdirSync(path.join(role, "conversation"), { recursive: true });
  const source = path.join(role, "conversation/current.jsonl");
  fs.writeFileSync(source, JSON.stringify({ id: "record", sequence: 1, time: 1000, text: "中文 lifecycle", direction: "inbound", adapter: "synthetic" }) + "\n");
  return { root, role, source, index: path.join(root, "search.sqlite") };
}

test("ordinary refreshes avoid repeated generation scans while publication and explicit cleanup remain immediate", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.role, f.index);
  const versions = path.resolve(f.index + ".state", "versions");
  const original = fs.readdirSync; let scans = 0;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    if (path.resolve(String(args[0])) === versions) scans++;
    return Reflect.apply(original, fs, args);
  });
  for (let index = 0; index < 3; index++) refreshMessageHistoryIndex(f.role, f.index);
  assert.equal(scans, 0);
  collectMessageIndexGenerations(f.index); assert.equal(scans, 1);
  refreshMessageHistoryIndex(f.role, f.index, { rebuild: true }); assert.equal(scans, 2);
});

test("publication pins existing readers and retires only unleased generations beyond rollback", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.role, f.index);
  const first = acquireMessageIndexLease(f.index);
  const held = new DatabaseSync(first.databasePath, { readOnly: true });
  try {
    refreshMessageHistoryIndex(f.role, f.index, { rebuild: true });
    const second = acquireMessageIndexLease(f.index); second.release();
    refreshMessageHistoryIndex(f.role, f.index, { rebuild: true });
    const third = acquireMessageIndexLease(f.index); third.release();
    assert.notEqual(first.generation, second.generation); assert.notEqual(second.generation, third.generation);
    assert.equal(held.prepare("SELECT count(*) AS n FROM documents").get()!.n, 1);
    assert.equal(fs.existsSync(first.databasePath), true);
    assert.equal(searchMessageHistoryIndex(f.role, { limit: 10 }, f.index).length, 1);
  } finally { held.close(); first.release(); }
  collectMessageIndexGenerations(f.index);
  assert.equal(fs.existsSync(first.databasePath), false);
  assert.equal(fs.readdirSync(path.join(f.index + ".state", "versions")).length, 2);
});

test("corrupted derived database rebuilds without altering source or discarding damaged evidence", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const source = fs.readFileSync(f.source);
  refreshMessageHistoryIndex(f.role, f.index);
  const first = acquireMessageIndexLease(f.index); first.release();
  fs.writeFileSync(first.databasePath, "not a sqlite database");
  assert.throws(() => searchMessageHistoryIndex(f.role, { limit: 10 }, f.index));
  refreshMessageHistoryIndex(f.role, f.index);
  const next = acquireMessageIndexLease(f.index); next.release();
  assert.notEqual(first.generation, next.generation);
  assert.equal(searchMessageHistoryIndex(f.role, { limit: 10, query: "中文" }, f.index).length, 1);
  assert.equal(fs.existsSync(path.join(path.dirname(first.databasePath), "quarantine.json")), true);
  assert.equal(fs.readFileSync(first.databasePath, "utf8"), "not a sqlite database");
  assert.deepEqual(fs.readFileSync(f.source), source);
});

test("invalid derived projections quarantine their generation and recover from unchanged sources", t => {
  for (const failure of ["invalid_json", "null", "mismatch", "segments"]) {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const source = fs.readFileSync(f.source);
    refreshMessageHistoryIndex(f.role, f.index);
    const first = acquireMessageIndexLease(f.index); first.release();
    const damaged = new DatabaseSync(first.databasePath);
    const original = JSON.parse(String(damaged.prepare("SELECT payload FROM documents").get()!.payload));
    const payload = failure === "invalid_json" ? "{invalid-json" : failure === "null" ? "null"
      : JSON.stringify({ ...original, ...(failure === "mismatch" ? { text: "wrong text" } : { segments: {} }) });
    try { damaged.prepare("UPDATE documents SET payload=?").run(payload); } finally { damaged.close(); }
    assert.throws(() => searchMessageHistoryIndex(f.role, { limit: 10 }, f.index), /MESSAGE_HISTORY_INDEX_NOT_READY/);
    assert.equal(fs.existsSync(path.join(path.dirname(first.databasePath), "quarantine.json")), true);
    refreshMessageHistoryIndex(f.role, f.index);
    const next = acquireMessageIndexLease(f.index); next.release();
    assert.notEqual(next.generation, first.generation);
    assert.equal(searchMessageHistoryIndex(f.role, { limit: 10, query: "中文" }, f.index).length, 1);
    assert.deepEqual(fs.readFileSync(f.source), source);
    const evidence = new DatabaseSync(first.databasePath, { readOnly: true });
    try { assert.equal(evidence.prepare("SELECT payload FROM documents").get()!.payload, payload); } finally { evidence.close(); }
  }
});

test("a retained live lease avoids disk churn but still rejects quarantine and released leases", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.role, f.index);
  const first = acquireMessageIndexLease(f.index);
  t.mock.method(fs, "writeFileSync", () => { throw new Error("unexpected new lease write"); });
  assert.equal(acquireMessageIndexLease(f.index, [first]), first);
  t.mock.restoreAll();
  const quarantine = path.join(path.dirname(first.databasePath), "quarantine.json");
  fs.writeFileSync(quarantine, "{}");
  assert.throws(() => acquireMessageIndexLease(f.index, [first]), /NOT_READY/);
  fs.unlinkSync(quarantine); first.release();
  const next = acquireMessageIndexLease(f.index, [first]);
  assert.notEqual(next, first); next.release();
});

test("new readers never open the flat cache retained for a previous package rollback", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(f.index, "previous flat cache evidence");
  assert.throws(() => acquireMessageIndexLease(f.index), /NOT_READY/);
  refreshMessageHistoryIndex(f.role, f.index);
  assert.equal(fs.readFileSync(f.index, "utf8"), "previous flat cache evidence");
  const lease = acquireMessageIndexLease(f.index); lease.release();
  assert.match(lease.generation, /^[a-f0-9-]{36}$/);
});

test("failed candidate leaves the active pointer intact and resumes its checkpoint", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.role, f.index);
  const old = acquireMessageIndexLease(f.index); old.release();
  const pointer = fs.readFileSync(path.join(f.index + ".state", "active.json"));
  assert.throws(() => refreshManagedMessageIndex(f.index, database => {
    const copy = new DatabaseSync(old.databasePath, { readOnly: true });
    try { copy.prepare("VACUUM INTO ?").run(database); } finally { copy.close(); }
    throw new Error("MESSAGE_HISTORY_INDEX_LAGGING: simulated interrupted checkpoint");
  }, { rebuild: true }), /LAGGING/);
  const building = JSON.parse(fs.readFileSync(path.join(f.index + ".state", "building.json"), "utf8"));
  assert.deepEqual(fs.readFileSync(path.join(f.index + ".state", "active.json")), pointer);
  assert.equal(searchMessageHistoryIndex(f.role, { limit: 10 }, f.index).length, 1);
  const resumed = refreshMessageHistoryIndex(f.role, f.index, { rebuild: true });
  assert.equal(resumed.filesRead, 0);
  const next = acquireMessageIndexLease(f.index); next.release();
  assert.equal(next.generation, building.generation);
});

test("invalid pointer is preserved before a complete replacement is published", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.role, f.index);
  const pointer = path.join(f.index + ".state", "active.json");
  fs.writeFileSync(pointer, "invalid-pointer-evidence");
  refreshMessageHistoryIndex(f.role, f.index);
  assert.equal(searchMessageHistoryIndex(f.role, { limit: 10 }, f.index).length, 1);
  const evidence = fs.readdirSync(f.index + ".state").find(file => file.startsWith("pointer-quarantine-"))!;
  assert.equal(fs.readFileSync(path.join(f.index + ".state", evidence), "utf8"), "invalid-pointer-evidence");
});

test("a generation that is a directory link cannot be published or overwritten", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.role, f.index);
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
  const generation = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  fs.symlinkSync(outside, path.join(f.index + ".state", "versions", generation), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(f.index + ".state", "active.json"), JSON.stringify({ schemaVersion: 1, generation, publishedAt: new Date().toISOString() }));
  assert.throws(() => acquireMessageIndexLease(f.index), /POINTER_INVALID/);
  assert.equal(fs.readdirSync(outside).length, 0);
});

test("a malformed candidate pointer is quarantined before another candidate is created", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.mkdirSync(f.index + ".state");
  fs.writeFileSync(path.join(f.index + ".state", "building.json"), "damaged-building-pointer");
  refreshMessageHistoryIndex(f.role, f.index);
  assert.equal(searchMessageHistoryIndex(f.role, { limit: 10 }, f.index).length, 1);
  const evidence = fs.readdirSync(f.index + ".state").find(file => file.startsWith("pointer-quarantine-"))!;
  assert.equal(fs.readFileSync(path.join(f.index + ".state", evidence), "utf8"), "damaged-building-pointer");
});

test("rollback is fenced to the expected generation and stale source data is rejected", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.role, f.index);
  const first = acquireMessageIndexLease(f.index); first.release();
  refreshMessageHistoryIndex(f.role, f.index, { rebuild: true });
  const second = acquireMessageIndexLease(f.index); second.release();
  assert.throws(() => rollbackMessageIndex(f.index, first.generation), /ROLLBACK_CONFLICT/);
  assert.equal(rollbackMessageIndex(f.index, second.generation), first.generation);
  assert.equal(searchMessageHistoryIndex(f.role, { limit: 10 }, f.index).length, 1);
  fs.appendFileSync(f.source, JSON.stringify({ id: "new", sequence: 2, time: 1001, text: "new", adapter: "synthetic" }) + "\n");
  assert.throws(() => searchMessageHistoryIndex(f.role, { limit: 10 }, f.index), /LAGGING/);
  refreshMessageHistoryIndex(f.role, f.index);
  assert.equal(searchMessageHistoryIndex(f.role, { limit: 10 }, f.index).length, 2);
});

test("a terminated indexing process resumes committed archives without changing original files", { timeout: 20_000 }, async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const archive = path.join(f.role, "conversation/archive"); fs.mkdirSync(archive);
  const source = fs.readFileSync(f.source);
  for (const number of [1, 2]) fs.writeFileSync(path.join(archive, `${number}~${number}.jsonl`),
    JSON.stringify({ id: `archive-${number}`, sequence: number, time: number, text: `archive-${number}`, adapter: "synthetic" }) + "\n");
  fs.writeFileSync(path.join(archive, "index.json"), JSON.stringify({ schemaVersion: 1, nextSequence: 4,
    archives: [1, 2].map(number => ({ file: `${number}~${number}.jsonl`, firstSequence: number, lastSequence: number,
      startedAt: new Date(number * 1000).toISOString(), endedAt: new Date(number * 1000).toISOString(), entryCount: 1 })) }));
  const sourceExtension = path.extname(import.meta.filename);
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "messageHistorySearchIndex" + sourceExtension)).href;
  const code = `import fs from 'node:fs';
    const read = fs.openSync;
    fs.openSync = function(file, ...args) {
      if (String(file).endsWith('2~2.jsonl')) {
        process.stdout.write('CHECKPOINT_READY\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return read.call(fs, file, ...args);
    };
    const { refreshMessageHistoryIndex } = await import(${JSON.stringify(moduleUrl)});
    refreshMessageHistoryIndex(${JSON.stringify(f.role)}, ${JSON.stringify(f.index)});`;
  const child = spawn(process.execPath, [...(sourceExtension === ".ts" ? ["--import", "tsx"] : []), "--input-type=module", "--eval", code], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let diagnostics = ""; child.stderr.on("data", chunk => { diagnostics += String(chunk).slice(0, 2000); });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); if (output.includes("CHECKPOINT_READY")) resolve(); });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Fixture exited before checkpoint (${code}): ${diagnostics}`)));
  });
  const exited = once(child, "exit"); child.kill(); await exited;
  const building = JSON.parse(fs.readFileSync(path.join(f.index + ".state", "building.json"), "utf8"));
  const database = path.join(f.index + ".state", "versions", building.generation, "index.sqlite");
  const checkpoint = new DatabaseSync(database, { readOnly: true });
  try { assert.equal(checkpoint.prepare("SELECT count(*) AS n FROM sources").get()!.n, 1); }
  finally { checkpoint.close(); }
  const result = refreshMessageHistoryIndex(f.role, f.index);
  assert.equal(result.filesRead, 2, "only the second archive and current should be consumed after termination");
  const lease = acquireMessageIndexLease(f.index); lease.release();
  assert.equal(lease.generation, building.generation);
  assert.equal(searchMessageHistoryIndex(f.role, { limit: 10, includeArchives: true }, f.index).length, 3);
  assert.deepEqual(fs.readFileSync(f.source), source);
});

for (const archived of [false, true]) test(`a terminated large ${archived ? "archive" : "current"} resumes its durable byte cursor`, { timeout: 30_000 }, async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const rows = Array.from({ length: 6000 }, (_, i) => JSON.stringify({ id: `large-${i}`, sequence: i + 1,
    time: i + 1, text: "checkpoint", adapter: "synthetic" })).join("\n") + "\n";
  let sourceFile = f.source;
  if (archived) {
    const archive = path.join(f.role, "conversation/archive"); fs.mkdirSync(archive);
    sourceFile = path.join(archive, "1~6000.jsonl");
    fs.writeFileSync(f.source, "");
    fs.writeFileSync(path.join(archive, "index.json"), JSON.stringify({ schemaVersion: 1, nextSequence: 6001,
      archives: [{ file: "1~6000.jsonl", firstSequence: 1, lastSequence: 6000, startedAt: new Date(1000).toISOString(),
        endedAt: new Date(6000000).toISOString(), entryCount: 6000 }] }));
  }
  fs.writeFileSync(sourceFile, rows);
  const extension = path.extname(import.meta.filename);
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "messageHistorySearchIndex" + extension)).href;
  const code = `import fs from 'node:fs'; const rename = fs.renameSync;
    fs.renameSync = function(from, to) { const result = rename.call(fs, from, to);
      if (String(to).endsWith('index-progress.json') && JSON.parse(fs.readFileSync(to, 'utf8')).phase === 'building') {
        process.stdout.write('CHECKPOINT_READY\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      } return result; };
    const { refreshMessageHistoryIndex } = await import(${JSON.stringify(moduleUrl)});
    refreshMessageHistoryIndex(${JSON.stringify(f.role)}, ${JSON.stringify(f.index)});`;
  const child = spawn(process.execPath, [...(extension === ".ts" ? ["--import", "tsx"] : []), "--input-type=module", "--eval", code], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let diagnostics = ""; child.stderr.on("data", chunk => { diagnostics += String(chunk).slice(0, 1000); });
  await new Promise<void>((resolve, reject) => {
    let output = ""; child.stdout.on("data", chunk => { output += String(chunk); if (output.includes("CHECKPOINT_READY")) resolve(); });
    child.once("error", reject); child.once("exit", code => reject(new Error(`No durable checkpoint (${code}): ${diagnostics}`)));
  });
  const exited = once(child, "exit"); child.kill(); await exited;
  const building = JSON.parse(fs.readFileSync(path.join(f.index + ".state", "building.json"), "utf8"));
  const database = path.join(f.index + ".state", "versions", building.generation, "index.sqlite");
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM documents").get()!.n, 5000);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='unpublished'").get()!.value, "1");
    assert.equal(JSON.parse(String(db.prepare("SELECT cursor FROM cursors").get()!.cursor)).records, 5000);
  } finally { db.close(); }
  assert.equal(refreshMessageHistoryIndex(f.role, f.index).records, 6000);
  const lease = acquireMessageIndexLease(f.index); lease.release(); assert.equal(lease.generation, building.generation);
  assert.equal(fs.readFileSync(sourceFile, "utf8"), rows);
});

test("SQLite FULL rolls back an incomplete source batch and resumes after the quota is removed", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.role, f.index);
  const lease = acquireMessageIndexLease(f.index); lease.release();
  const beforePointer = fs.readFileSync(path.join(f.index + ".state", "active.json"));
  fs.appendFileSync(f.source, JSON.stringify({ id: "large", sequence: 2, time: 1001, text: "quota test ".repeat(20_000), adapter: "synthetic" }) + "\n");
  const source = fs.readFileSync(f.source);
  const original = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    const result = original.call(this, sql);
    if (sql.startsWith("PRAGMA journal_mode=WAL")) {
      const pages = this.prepare("PRAGMA page_count").get()!.page_count;
      original.call(this, `PRAGMA max_page_count=${pages}`);
    }
    return result;
  });
  assert.throws(() => refreshMessageHistoryIndex(f.role, f.index), error => /database or disk is full/i.test(String(error)));
  t.mock.restoreAll();
  assert.deepEqual(fs.readFileSync(path.join(f.index + ".state", "active.json")), beforePointer);
  const check = new DatabaseSync(lease.databasePath, { readOnly: true });
  try { assert.equal(check.prepare("SELECT count(*) AS n FROM documents").get()!.n, 1); }
  finally { check.close(); }
  assert.deepEqual(fs.readFileSync(f.source), source);
  assert.equal(refreshMessageHistoryIndex(f.role, f.index).records, 2);
});

test("a quarantined generation cannot be reopened and its next refresh builds a clean generation", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.role, f.index);
  const first = acquireMessageIndexLease(f.index); first.release();
  fs.writeFileSync(path.join(path.dirname(first.databasePath), "quarantine.json"), JSON.stringify({ reason: "simulated detected corruption" }));
  assert.throws(() => acquireMessageIndexLease(f.index), /NOT_READY/);
  refreshMessageHistoryIndex(f.role, f.index);
  const next = acquireMessageIndexLease(f.index); next.release();
  assert.notEqual(next.generation, first.generation);
  assert.equal(searchMessageHistoryIndex(f.role, { limit: 10 }, f.index).length, 1);
});
