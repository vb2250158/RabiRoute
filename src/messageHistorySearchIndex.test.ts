import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { refreshMessageHistoryIndex, searchMessageHistoryIndex, searchMessageHistoryIndexResult, probeMessageHistoryIndex } from "./messageHistorySearchIndex.js";
import { recentMessageContextItems, messageHistoryStorage, appendMessageContextToDir, type RecentMessageContextQuery, type MessageContextRecord } from "./messageContextStore.js";
import { messageHistoryAppendProof, discardMessageHistoryAppendProof } from "./messageHistorySourceVersion.js";
import { DatabaseSync } from "node:sqlite";
import { acquireMessageIndexLease } from "./messageHistoryIndexLifecycle.js";
import { MESSAGE_HISTORY_INDEX_RECORD_BYTES } from "./messageHistoryTail.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-search-index-"));
  const directory = path.join(root, "role");
  const archive = path.join(directory, "conversation/archive"); fs.mkdirSync(archive, { recursive: true });
  const record = (sequence: number, text: string, extra = {}) => ({ schemaVersion: 1, id: `record-${sequence}`, sequence, time: 1000 + sequence,
    recordedAt: new Date((1000 + sequence) * 1000).toISOString(), direction: "inbound", adapter: "synthetic", channel: "synthetic",
    kind: "group", sender: "Sender", target: "target", conversationKey: "room", messageId: String(sequence), text, ...extra });
  const historic = [record(1, "订单超时 74125 x%_ quote\" 中文😀"), record(2, "second needle", { id: "duplicate" }),
    record(3, "中文匹配 abc ABC", { conversationKey: "other" })];
  fs.writeFileSync(path.join(archive, "1~3.jsonl"), historic.map(r => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(archive, "index.json"), JSON.stringify({ schemaVersion: 1, nextSequence: 6, archives: [{ file: "1~3.jsonl",
    firstSequence: 1, lastSequence: 3, startedAt: historic[0].recordedAt, endedAt: historic[2].recordedAt, entryCount: 3 }] }));
  const current = path.join(directory, "conversation/current.jsonl");
  fs.writeFileSync(current, [record(4, "later conflict unique", { id: "duplicate" }), record(5, "last 超时")].map(r => JSON.stringify(r)).join("\n") + "\n");
  return { root, directory, current, record, index: path.join(root, "search.sqlite") };
}

test("bad and oversized source records remain local partial coverage while normal matches and old cursors recover", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const original = fs.readFileSync(f.current, "utf8");
  const raw = original + '{"id":"unproven-identity",broken\n[]\n'
    + JSON.stringify(f.record(6, "x".repeat(MESSAGE_HISTORY_INDEX_RECORD_BYTES + 256))) + "\n"
    + JSON.stringify(f.record(7, "normal after oversized")) + "\n{unfinished";
  fs.writeFileSync(f.current, raw);
  fs.appendFileSync(path.join(f.directory, "conversation/archive/1~3.jsonl"), "{bad archive row\n");
  refreshMessageHistoryIndex(f.directory, f.index);
  const query = { limit: 20, includeArchives: true, query: "normal after oversized" };
  const result = searchMessageHistoryIndexResult(f.directory, query, f.index);
  assert.deepEqual(result.entries.map(row => row.sequence), [7]);
  assert.equal(result.coverage.indexCoverage, "partial");
  assert.equal(result.coverage.sourceSnapshotIndexed, false);
  assert.equal(result.coverage.sourceRecordsSkipped, 4);
  assert.deepEqual(result.coverage.sourceRecordIssues, { malformed: 2, unrecognized: 1, oversized: 1 });
  assert.equal(result.coverage.pendingRecordBytes, Buffer.byteLength("{unfinished"));
  assert.equal(result.coverage.maxIndexedRecordBytes, MESSAGE_HISTORY_INDEX_RECORD_BYTES);
  const absent = searchMessageHistoryIndexResult(f.directory, { ...query, query: "unproven-identity" }, f.index);
  assert.deepEqual(absent.entries, []); assert.equal(absent.coverage.indexCoverage, "partial");
  assert.equal(searchMessageHistoryIndexResult(f.directory, { ...query, includeArchives: false }, f.index).coverage.sourceRecordsSkipped, 3);
  assert.equal(fs.readFileSync(f.current, "utf8"), raw);
  // An old derived cursor cannot claim that damage was counted before this format existed.
  const lease = acquireMessageIndexLease(f.index), db = new DatabaseSync(lease.databasePath);
  try {
    db.exec("DELETE FROM meta WHERE key='tailFormat'; UPDATE cursors SET cursor=json_remove(cursor,'$.format','$.issues','$.issueSamples','$.pendingBytes')");
  } finally { db.close(); lease.release(); }
  assert.throws(() => searchMessageHistoryIndexResult(f.directory, query, f.index), /INDEX_NOT_READY/);
  assert.equal(refreshMessageHistoryIndex(f.directory, f.index).filesRead, 2);
  const upgraded = searchMessageHistoryIndexResult(f.directory, query, f.index);
  assert.equal(upgraded.coverage.sourceRecordsSkipped, 4);
  assert.deepEqual(upgraded.entries, result.entries);
  assert.equal(refreshMessageHistoryIndex(f.directory, f.index).filesRead, 0);
});

test("indexed search preserves literal substring, source-scoped dedupe, filters and budgets", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.directory, f.index);
  for (const includeArchives of [false, true]) {
    for (const query of [undefined, "超", "超时", "订单超", "412", "x%_", 'quote"', "😀", "ABC", "unique", "needle", "中文,ABC", "missing", "Sender"]) {
      for (const queryMatch of ["any", "all"] as const) {
        const input = { limit: 10, includeArchives, query, queryMatch };
        assert.deepEqual(searchMessageHistoryIndex(f.directory, input, f.index), JSON.parse(JSON.stringify(recentMessageContextItems([f.directory], input))), JSON.stringify(input));
      }
    }
  }
  const filters: Partial<RecentMessageContextQuery>[] = [{ from: 1003 }, { to: 1002 }, { afterSequence: 2 }, { beforeSequence: 3 },
    { adapter: "wrong" }, { target: "target" }, { sender: "Sender" }, { channel: "synthetic" }, { kind: "group" }, { conversationKey: "other" },
    { maxChars: 1 }, { maxChars: 400 }, { limit: 1 }, { excludedMessageIds: ["5"] }];
  for (const includeArchives of [false, true]) for (const filter of filters) {
    const input = { limit: 10, includeArchives, ...filter };
    assert.deepEqual(searchMessageHistoryIndex(f.directory, input, f.index), JSON.parse(JSON.stringify(recentMessageContextItems([f.directory], input))), JSON.stringify(input));
  }
});

test("an allowed oversize first result ends retrieval without walking older matches", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(f.current, [...Array.from({ length: 1000 }, (_, i) => f.record(i + 10, "needle")),
    f.record(1010, "needle ".repeat(2000))].map(row => JSON.stringify(row)).join("\n") + "\n");
  refreshMessageHistoryIndex(f.directory, f.index);
  for (const query of [undefined, "needle"]) {
    const input = { limit: 10, maxChars: 50, includeArchives: true, query };
    const result = searchMessageHistoryIndexResult(f.directory, input, f.index);
    assert.deepEqual(result.entries, JSON.parse(JSON.stringify(recentMessageContextItems([f.directory], input))));
    assert.equal(result.entries.length, 1);
    assert.ok(result.metrics.candidates <= 3, `retrieved ${result.metrics.candidates} candidates after budget exhaustion`);
  }
});

test("a positive remainder below the minimum record cost also ends retrieval", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(f.current, Array.from({ length: 1000 }, (_, i) => JSON.stringify(f.record(i + 10, "needle"))).join("\n") + "\n");
  refreshMessageHistoryIndex(f.directory, f.index);
  for (const query of [undefined, "needle"]) {
    const input = { limit: 10, maxChars: 300, includeArchives: false, query };
    const result = searchMessageHistoryIndexResult(f.directory, input, f.index);
    assert.deepEqual(result.entries, JSON.parse(JSON.stringify(recentMessageContextItems([f.directory], input))));
    assert.equal(result.entries.length, 1);
    assert.ok(result.metrics.candidates <= 3, `scanned ${result.metrics.candidates} rows with no record able to fit`);
  }
});

test("query never reads source bodies; unchanged sources are not reparsed and drift fails explicitly", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  assert.throws(() => searchMessageHistoryIndex(f.directory, { limit: 10 }, f.index), /NOT_READY/);
  assert.equal(refreshMessageHistoryIndex(f.directory, f.index).filesRead, 2);
  assert.equal(refreshMessageHistoryIndex(f.directory, f.index).filesRead, 0);
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).startsWith(f.directory)) throw new Error("online source body read");
    return Reflect.apply(originalRead, fs, args);
  }) as typeof fs.readFileSync);
  assert.equal(searchMessageHistoryIndex(f.directory, { limit: 10, query: "超时", includeArchives: true }, f.index).length, 2);
  t.mock.restoreAll();
  fs.appendFileSync(f.current, JSON.stringify(f.record(6, "fresh record")) + "\n");
  assert.throws(() => searchMessageHistoryIndex(f.directory, { limit: 10 }, f.index), /LAGGING/);
  assert.equal(refreshMessageHistoryIndex(f.directory, f.index).filesRead, 1);
  assert.equal(searchMessageHistoryIndex(f.directory, { limit: 10, query: "fresh" }, f.index).length, 1);
});

test("mixed missing sequences and duplicate conflicts match the existing storage oracle", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.appendFileSync(f.current, [f.record(6, "not matching", { sequence: undefined, time: 1002 }),
    f.record(7, "中文 matching", { sequence: undefined, time: 1005 }), f.record(8, "中文", { id: "duplicate" })].map(r => JSON.stringify(r)).join("\n") + "\n");
  refreshMessageHistoryIndex(f.directory, f.index);
  for (const query of [undefined, "中文", "unique", "not", "matching"]) {
    const input = { limit: 3, includeArchives: true, query };
    assert.deepEqual(searchMessageHistoryIndex(f.directory, input, f.index), JSON.parse(JSON.stringify(recentMessageContextItems([f.directory], input))));
  }
});

test("query planning streams common terms and uses postings for selective terms", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(f.current, Array.from({ length: 3000 }, (_, i) => JSON.stringify(f.record(10 + i,
    `通用 common phrase ${i === 100 ? "selective-needle" : "regular"}`))).join("\n") + "\n");
  refreshMessageHistoryIndex(f.directory, f.index);
  const common = searchMessageHistoryIndexResult(f.directory, { limit: 10, query: "common", includeArchives: true }, f.index);
  assert.equal(common.metrics.strategy, "ordered");
  assert.equal(common.entries.length, 10);
  assert.ok(common.metrics.candidates <= 20, "common terms must not materialize every match before collecting latest results");
  const rare = searchMessageHistoryIndexResult(f.directory, { limit: 10, query: "selective-needle", includeArchives: true }, f.index);
  assert.equal(rare.metrics.strategy, "postings"); assert.equal(rare.entries.length, 1);
  assert.match(common.coverage.indexVersion, /^[a-f0-9]{64}$/);
  assert.equal(common.coverage.sourceVersion, rare.coverage.sourceVersion);
});

test("index generation changes remain distinct from the source snapshot version", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.directory, f.index);
  const before = searchMessageHistoryIndexResult(f.directory, { limit: 10 }, f.index);
  refreshMessageHistoryIndex(f.directory, f.index, { rebuild: true });
  const after = searchMessageHistoryIndexResult(f.directory, { limit: 10 }, f.index);
  assert.notEqual(before.coverage.indexVersion, after.coverage.indexVersion);
  assert.equal(before.coverage.sourceVersion, after.coverage.sourceVersion);
  assert.deepEqual(before.entries, after.entries);
});

test("gram conjunction candidates still require the original literal substring", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(f.current, [f.record(10, "abc bca cab aaa"), f.record(11, "literal abcabc aaaaa")]
    .map(record => JSON.stringify(record)).join("\n") + "\n");
  refreshMessageHistoryIndex(f.directory, f.index);
  for (const query of ["abcabc", "aaaaa", "ABCABC"]) {
    const input = { limit: 10, query };
    assert.deepEqual(searchMessageHistoryIndex(f.directory, input, f.index), JSON.parse(JSON.stringify(recentMessageContextItems([f.directory], input))));
    assert.equal(searchMessageHistoryIndex(f.directory, input, f.index).length, 1);
  }
});

test("new commits during a query do not invalidate its already verified read snapshot", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.directory, f.index);
  const expected = searchMessageHistoryIndexResult(f.directory, { limit: 10 }, f.index);
  const original = messageHistoryStorage.matches;
  let committed = false;
  t.mock.method(messageHistoryStorage, "matches", (...args: Parameters<typeof original>) => {
    if (!committed) { committed = true; fs.appendFileSync(f.current, JSON.stringify(f.record(6, "committed after query snapshot")) + "\n"); }
    return original(...args);
  });
  const actual = searchMessageHistoryIndexResult(f.directory, { limit: 10 }, f.index);
  assert.equal(committed, true); assert.deepEqual(actual.entries, expected.entries);
  assert.equal(actual.coverage.sourceVersion, expected.coverage.sourceVersion);
  assert.throws(() => searchMessageHistoryIndexResult(f.directory, { limit: 10 }, f.index), /LAGGING/);
});

test("a lagging query freezes its target and excludes later owner commits after the index catches up", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const catalogFile = path.join(f.directory, "conversation/archive/index.json");
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  fs.writeFileSync(catalogFile, JSON.stringify({ ...catalog, legacyImportedAt: new Date().toISOString() }));
  refreshMessageHistoryIndex(f.directory, f.index);
  appendMessageContextToDir(f.directory, f.record(6, "target commit") as MessageContextRecord, { archiveCheck: false });
  const query = { limit: 10, includeArchives: true };
  const expected = JSON.parse(JSON.stringify(recentMessageContextItems([f.directory], query)));
  const lag = probeMessageHistoryIndex(f.directory, query, f.index, { proof: messageHistoryAppendProof(f.directory) });
  assert.equal(lag.ready, false); if (lag.ready) return;
  assert.ok(lag.target);
  appendMessageContextToDir(f.directory, f.record(7, "future commit") as MessageContextRecord, { archiveCheck: false });
  appendMessageContextToDir(f.directory, f.record(8, "another future commit") as MessageContextRecord, { archiveCheck: false });
  refreshMessageHistoryIndex(f.directory, f.index);
  const ready = probeMessageHistoryIndex(f.directory, query, f.index, { target: lag.target, proof: messageHistoryAppendProof(f.directory) });
  assert.equal(ready.ready, true); if (!ready.ready) return;
  assert.deepEqual(ready.result.entries, expected);
  assert.equal(ready.result.coverage.sourceSnapshotIndexed, true);
  // Uncontrolled rewrites cannot use an old owner's append chain as evidence.
  fs.writeFileSync(f.current, fs.readFileSync(f.current, "utf8").replace("target commit", "rewritten source"));
  refreshMessageHistoryIndex(f.directory, f.index);
  assert.equal(probeMessageHistoryIndex(f.directory, query, f.index, { target: lag.target, proof: messageHistoryAppendProof(f.directory) }).ready, false);
});

test("an external append without a notification is reconciled against the same frozen target", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.directory, f.index);
  fs.appendFileSync(f.current, JSON.stringify(f.record(6, "external complete append")) + "\n");
  const lag = probeMessageHistoryIndex(f.directory, { limit: 10 }, f.index);
  assert.equal(lag.ready, false); if (lag.ready) return;
  refreshMessageHistoryIndex(f.directory, f.index);
  const ready = probeMessageHistoryIndex(f.directory, { limit: 10 }, f.index, { target: lag.target });
  assert.equal(ready.ready, true); if (ready.ready) assert.equal(ready.result.entries.at(-1)?.sequence, 6);
});

test("a source checkpoint cannot serve under the previous global snapshot tag", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.directory, f.index);
  const lease = acquireMessageIndexLease(f.index);
  const db = new DatabaseSync(lease.databasePath);
  try { db.prepare("UPDATE sources SET fingerprint=? WHERE current=1").run("unpublished-checkpoint"); }
  finally { db.close(); lease.release(); }
  assert.throws(() => searchMessageHistoryIndexResult(f.directory, { limit: 10 }, f.index), /LAGGING/);
});

test("index publication can freeze a verified prefix while the owner keeps appending", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const catalogFile = path.join(f.directory, "conversation/archive/index.json");
  fs.writeFileSync(catalogFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(catalogFile, "utf8")), legacyImportedAt: new Date().toISOString() }));
  refreshMessageHistoryIndex(f.directory, f.index);
  appendMessageContextToDir(f.directory, f.record(6, "frozen target") as MessageContextRecord, { archiveCheck: false });
  const query = { limit: 10 };
  const lag = probeMessageHistoryIndex(f.directory, query, f.index);
  assert.equal(lag.ready, false); if (lag.ready) return;
  const original = messageHistoryStorage.normalizeStored;
  let appended = false;
  t.mock.method(messageHistoryStorage, "normalizeStored", (...args: Parameters<typeof original>) => {
    if (!appended) {
      appended = true;
      appendMessageContextToDir(f.directory, f.record(7, "written during indexing") as MessageContextRecord, { archiveCheck: false });
    }
    return original(...args);
  });
  refreshMessageHistoryIndex(f.directory, f.index);
  const ready = probeMessageHistoryIndex(f.directory, query, f.index, { target: lag.target, proof: messageHistoryAppendProof(f.directory) });
  assert.equal(appended, true); assert.equal(ready.ready, true);
  if (ready.ready) assert.equal(ready.result.entries.at(-1)?.sequence, 6);
  assert.equal(probeMessageHistoryIndex(f.directory, query, f.index).ready, false, "the next request still requires the later commit");
});

test("format four migrates without reparsing sources and retires the vocabulary statistics table", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.directory, f.index);
  const expected = searchMessageHistoryIndex(f.directory, { limit: 10 }, f.index);
  const lease = acquireMessageIndexLease(f.index);
  const db = new DatabaseSync(lease.databasePath);
  db.exec("UPDATE meta SET value='4' WHERE key='schema'; CREATE VIRTUAL TABLE term_counts USING fts5vocab(terms,'col')");
  db.close(); lease.release();
  assert.equal(refreshMessageHistoryIndex(f.directory, f.index).filesRead, 0);
  assert.deepEqual(searchMessageHistoryIndex(f.directory, { limit: 10 }, f.index), expected);
  const check = new DatabaseSync(lease.databasePath, { readOnly: true });
  try { assert.equal(check.prepare("SELECT name FROM sqlite_schema WHERE name='term_counts'").get(), undefined); }
  finally { check.close(); }
});

test("incremental physical record counts survive appends and source truncation", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  assert.equal(refreshMessageHistoryIndex(f.directory, f.index).records, 5);
  fs.appendFileSync(f.current, JSON.stringify(f.record(6, "append")) + "\n");
  assert.equal(refreshMessageHistoryIndex(f.directory, f.index).records, 6);
  fs.writeFileSync(f.current, JSON.stringify(f.record(7, "replacement")) + "\n");
  assert.equal(refreshMessageHistoryIndex(f.directory, f.index).records, 4);
});

test("bounded query estimates handle non-round corpus sizes", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(f.current, Array.from({ length: 11001 }, (_, i) => JSON.stringify(f.record(i + 10, "common query"))).join("\n") + "\n");
  refreshMessageHistoryIndex(f.directory, f.index);
  const result = searchMessageHistoryIndexResult(f.directory, { limit: 10, includeArchives: true, query: "common" }, f.index);
  assert.equal(result.entries.length, 10); assert.ok(result.metrics.candidates <= 20);
});

test("the owner's request-start target survives a newer commit before the worker observes files", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const catalogFile = path.join(f.directory, "conversation/archive/index.json");
  fs.writeFileSync(catalogFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(catalogFile, "utf8")), legacyImportedAt: new Date().toISOString() }));
  refreshMessageHistoryIndex(f.directory, f.index);
  appendMessageContextToDir(f.directory, f.record(6, "request start") as MessageContextRecord, { archiveCheck: false });
  refreshMessageHistoryIndex(f.directory, f.index);
  const expected = searchMessageHistoryIndex(f.directory, { limit: 10 }, f.index);
  const initial = messageHistoryAppendProof(f.directory)!; const commit = initial.commits.at(-1)!;
  const ownerTarget = { stamp: commit.stamp, records: commit.records, layoutVersion: initial.layoutVersion, catalogStamp: commit.catalogStamp };
  appendMessageContextToDir(f.directory, f.record(7, "newer while queued") as MessageContextRecord, { archiveCheck: false });
  const lag = probeMessageHistoryIndex(f.directory, { limit: 10 }, f.index, { proof: initial, ownerTarget });
  assert.equal(lag.ready, false); if (lag.ready) return;
  const ready = probeMessageHistoryIndex(f.directory, { limit: 10 }, f.index,
    { proof: messageHistoryAppendProof(f.directory), ownerTarget, target: lag.target });
  assert.equal(ready.ready, true); if (ready.ready) assert.deepEqual(ready.result.entries, expected);
});

test("a metadata-only replay preserves a proven owner target without reparsing messages", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const catalog = path.join(f.directory, "conversation/archive/index.json");
  fs.writeFileSync(catalog, JSON.stringify({ ...JSON.parse(fs.readFileSync(catalog, "utf8")), legacyImportedAt: new Date().toISOString() }));
  const record = f.record(6, "replayed commit") as MessageContextRecord;
  appendMessageContextToDir(f.directory, record, { archiveCheck: false });
  refreshMessageHistoryIndex(f.directory, f.index);
  appendMessageContextToDir(f.directory, record, { archiveCheck: false });
  assert.equal(refreshMessageHistoryIndex(f.directory, f.index).filesRead, 0);
  const proof = messageHistoryAppendProof(f.directory)!; const commit = proof.commits.at(-1)!;
  const ready = probeMessageHistoryIndex(f.directory, { limit: 10 }, f.index, { proof,
    ownerTarget: { stamp: commit.stamp, records: commit.records, layoutVersion: proof.layoutVersion } });
  assert.equal(ready.ready, true);
});

test("an external catalog edit cannot borrow an earlier owner's append proof", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const catalog = path.join(f.directory, "conversation/archive/index.json");
  fs.writeFileSync(catalog, JSON.stringify({ ...JSON.parse(fs.readFileSync(catalog, "utf8")), legacyImportedAt: new Date().toISOString() }));
  appendMessageContextToDir(f.directory, f.record(6, "owner commit") as MessageContextRecord, { archiveCheck: false });
  refreshMessageHistoryIndex(f.directory, f.index);
  const proof = messageHistoryAppendProof(f.directory)!; const commit = proof.commits.at(-1)!;
  fs.writeFileSync(catalog, JSON.stringify({ ...JSON.parse(fs.readFileSync(catalog, "utf8")), revisionTag: "external-change" }));
  refreshMessageHistoryIndex(f.directory, f.index);
  const result = probeMessageHistoryIndex(f.directory, { limit: 10 }, f.index, { proof,
    ownerTarget: { stamp: commit.stamp, records: commit.records, layoutVersion: proof.layoutVersion, catalogStamp: commit.catalogStamp } });
  assert.equal(result.ready, false); if (!result.ready) assert.equal(result.diagnostic, "owner_target_stale");
  assert.equal(probeMessageHistoryIndex(f.directory, { limit: 10 }, f.index).ready, true);
});

test("a frozen owner catalog survives a transient replacement only inside a proven commit window", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const catalog = path.join(f.directory, "conversation/archive/index.json");
  fs.writeFileSync(catalog, JSON.stringify({ ...JSON.parse(fs.readFileSync(catalog, "utf8")), legacyImportedAt: new Date().toISOString() }));
  appendMessageContextToDir(f.directory, f.record(6, "request target") as MessageContextRecord, { archiveCheck: false });
  refreshMessageHistoryIndex(f.directory, f.index);
  const expected = searchMessageHistoryIndex(f.directory, { limit: 10 }, f.index);
  const initial = messageHistoryAppendProof(f.directory)!; const commit = initial.commits.at(-1)!;
  const ownerTarget = { stamp: commit.stamp, records: commit.records, layoutVersion: initial.layoutVersion, catalogStamp: commit.catalogStamp };
  appendMessageContextToDir(f.directory, f.record(7, "later commit") as MessageContextRecord, { archiveCheck: false });
  const proof = messageHistoryAppendProof(f.directory)!; const later = proof.commits.at(-1)!;
  t.mock.method(Date, "now", () => later.startedAt!);
  const stat = fs.statSync; let gap = true;
  t.mock.method(fs, "statSync", ((...args: Parameters<typeof stat>) => {
    if (gap && path.resolve(String(args[0])) === catalog) {
      gap = false; throw Object.assign(new Error("simulated catalog replacement"), { code: "ENOENT" });
    }
    return Reflect.apply(stat, fs, args);
  }) as typeof stat);
  const pending = probeMessageHistoryIndex(f.directory, { limit: 10 }, f.index, { proof: initial, ownerTarget });
  assert.equal(pending.ready, false); assert.equal(gap, false); if (pending.ready) return;
  t.mock.restoreAll();
  const ready = probeMessageHistoryIndex(f.directory, { limit: 10 }, f.index, { proof, ownerTarget, target: pending.target });
  assert.equal(ready.ready, true); if (ready.ready) assert.deepEqual(ready.result.entries, expected);
  const unproven = probeMessageHistoryIndex(f.directory, { limit: 10 }, f.index, { proof, ownerTarget,
    target: { ...pending.target!, observedCatalogAt: later.committedAt! + 1 } });
  assert.equal(unproven.ready, false);
});

test("discarding stale evidence cannot remove a newer metadata-only replay", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const catalog = path.join(f.directory, "conversation/archive/index.json");
  fs.writeFileSync(catalog, JSON.stringify({ ...JSON.parse(fs.readFileSync(catalog, "utf8")), legacyImportedAt: new Date().toISOString() }));
  const record = f.record(6, "replay") as MessageContextRecord;
  appendMessageContextToDir(f.directory, record, { archiveCheck: false });
  const before = messageHistoryAppendProof(f.directory)!.commits.at(-1)!;
  appendMessageContextToDir(f.directory, record, { archiveCheck: false });
  const after = messageHistoryAppendProof(f.directory)!.commits.at(-1)!;
  assert.equal(before.stamp, after.stamp); assert.notEqual(before.catalogStamp, after.catalogStamp);
  assert.equal(discardMessageHistoryAppendProof(f.directory, before.stamp, before.catalogStamp), false);
  assert.equal(messageHistoryAppendProof(f.directory)!.commits.at(-1)!.catalogStamp, after.catalogStamp);
  assert.equal(discardMessageHistoryAppendProof(f.directory, after.stamp, after.catalogStamp), true);
});

test("source metadata and its catalog fingerprint cannot come from different versions", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.directory, f.index);
  const catalog = path.join(f.directory, "conversation/archive/index.json");
  const original = messageHistoryStorage.readArchives; let changed = false;
  t.mock.method(messageHistoryStorage, "readArchives", (directory: string) => {
    const result = original(directory);
    if (!changed) {
      changed = true; const record = f.record(6, "new archive during source capture");
      fs.writeFileSync(path.join(f.directory, "conversation/archive/6~6.jsonl"), JSON.stringify(record) + "\n");
      const value = JSON.parse(fs.readFileSync(catalog, "utf8"));
      value.archives.push({ file: "6~6.jsonl", firstSequence: 6, lastSequence: 6, startedAt: record.recordedAt, endedAt: record.recordedAt, entryCount: 1 });
      value.nextSequence = 7; fs.writeFileSync(catalog, JSON.stringify(value));
    }
    return result;
  });
  assert.throws(() => refreshMessageHistoryIndex(f.directory, f.index), /LAGGING/);
  t.mock.restoreAll();
  assert.equal(refreshMessageHistoryIndex(f.directory, f.index).records, 6);
  const input = { limit: 10, includeArchives: true };
  assert.deepEqual(searchMessageHistoryIndex(f.directory, input, f.index), JSON.parse(JSON.stringify(recentMessageContextItems([f.directory], input))));
});

test("cached tail proposals never publish stale records after a rewrite plus append", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  refreshMessageHistoryIndex(f.directory, f.index);
  fs.writeFileSync(f.current, [f.record(4, "later conflict unique", { id: "duplicate" }),
    f.record(5, "edit 超时"), f.record(6, "new tail record")].map(row => JSON.stringify(row)).join("\n") + "\n");
  try { refreshMessageHistoryIndex(f.directory, f.index); }
  catch (error) {
    assert.match((error as Error).message, /MESSAGE_HISTORY_INDEX_LAGGING/);
    assert.equal(probeMessageHistoryIndex(f.directory, { limit: 10 }, f.index).ready, false);
    refreshMessageHistoryIndex(f.directory, f.index);
  }
  for (const includeArchives of [false, true]) for (const query of [undefined, "edit", "new tail", "last"]) {
    const input = { limit: 10, includeArchives, query };
    assert.deepEqual(searchMessageHistoryIndex(f.directory, input, f.index), JSON.parse(JSON.stringify(recentMessageContextItems([f.directory], input))));
  }
});

test("a valid current EOF record without a newline keeps the original query semantics", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(f.current, JSON.stringify(f.record(6, "valid EOF 中文😀")));
  refreshMessageHistoryIndex(f.directory, f.index);
  for (const includeArchives of [false, true]) {
    const input = { limit: 10, includeArchives };
    assert.deepEqual(searchMessageHistoryIndex(f.directory, input, f.index), JSON.parse(JSON.stringify(recentMessageContextItems([f.directory], input))));
  }
  fs.appendFileSync(f.current, "\n" + JSON.stringify(f.record(7, "next complete record")) + "\n");
  refreshMessageHistoryIndex(f.directory, f.index);
  const input = { limit: 10, includeArchives: false };
  assert.deepEqual(searchMessageHistoryIndex(f.directory, input, f.index), JSON.parse(JSON.stringify(recentMessageContextItems([f.directory], input))));
  assert.equal(searchMessageHistoryIndex(f.directory, input, f.index).length, 2);
});

test("a nonempty current file with no normalized rows retains the legacy fallback", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.unlinkSync(path.join(f.directory, "conversation/archive/index.json"));
  fs.writeFileSync(f.current, "\n   \r\n");
  fs.writeFileSync(path.join(f.directory, "message-context.jsonl"), JSON.stringify(f.record(8, "legacy-only record")) + "\n");
  const input = { limit: 10, includeArchives: false };
  const original = JSON.parse(JSON.stringify(recentMessageContextItems([f.directory], input)));
  assert.ok(original.some((record: MessageContextRecord) => record.text === "legacy-only record"));
  refreshMessageHistoryIndex(f.directory, f.index);
  assert.deepEqual(searchMessageHistoryIndex(f.directory, input, f.index), original);
});

test("an oversized malformed current row cannot hide valid legacy records", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.unlinkSync(path.join(f.directory, "conversation/archive/index.json"));
  const raw = "{broken" + "x".repeat(MESSAGE_HISTORY_INDEX_RECORD_BYTES) + "\n";
  fs.writeFileSync(f.current, raw);
  fs.writeFileSync(path.join(f.directory, "message-context.jsonl"), JSON.stringify(f.record(8, "legacy-only record")) + "\n");
  refreshMessageHistoryIndex(f.directory, f.index);
  const result = searchMessageHistoryIndexResult(f.directory, { limit: 10, includeArchives: false }, f.index);
  assert.ok(result.entries.some(row => row.text === "legacy-only record"));
  assert.equal(result.coverage.indexCoverage, "partial");
  assert.equal(result.coverage.sourceRecordIssues?.oversized, 1);
  assert.equal(result.coverage.legacyCoverageUnknown, true);
  assert.equal(fs.readFileSync(f.current, "utf8"), raw);
});


test("mixed legacy rows follow physical writes without materializing the matching corpus", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const rows = Array.from({ length: 12_000 }, (_, index) => f.record(index + 10, "common write " + index,
    { sequence: index % 3 ? undefined : 12000 - index, time: 20000 - index }));
  const original = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  fs.writeFileSync(f.current, original);
  refreshMessageHistoryIndex(f.directory, f.index);
  for (const query of [undefined, "common", "write 11999"]) {
    const result = searchMessageHistoryIndexResult(f.directory, { limit: 10, query, queryMatch: "all" }, f.index);
    assert.deepEqual(result.entries.map(row => row.id), query === "write 11999"
      ? [rows.at(-1)!.id] : rows.slice(-10).map(row => row.id));
    assert.ok(result.metrics.candidates <= 10, `visited ${result.metrics.candidates} matches`);
  }
  assert.equal(fs.readFileSync(f.current, "utf8"), original);
});

test("new write-order projection upgrades schema six and keeps the first physical identity", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const writes = [f.record(9, "first write", { id: "same", time: 300 }),
    f.record(8, "second write", { sequence: undefined, time: 100 }),
    f.record(1, "later duplicate", { id: "same", time: 1 }),
    f.record(7, "third write", { time: 200 })];
  fs.writeFileSync(f.current, writes.map(row => JSON.stringify(row)).join("\n") + "\n");
  refreshMessageHistoryIndex(f.directory, f.index);
  const lease = acquireMessageIndexLease(f.index);
  const db = new DatabaseSync(lease.databasePath);
  db.exec("DROP INDEX document_write_order; ALTER TABLE documents DROP COLUMN sourceOrder; UPDATE meta SET value='6' WHERE key='schema'");
  db.close(); lease.release();
  assert.throws(() => searchMessageHistoryIndex(f.directory, { limit: 10 }, f.index), /NOT_READY/);
  assert.equal(refreshMessageHistoryIndex(f.directory, f.index).filesRead, 0);
  const migrated = new DatabaseSync(lease.databasePath, { readOnly: true });
  assert.equal(migrated.prepare("SELECT value FROM meta WHERE key='comparator'").get()?.value, "source-write-order-v2"); migrated.close();
  const result = searchMessageHistoryIndex(f.directory, { limit: 10 }, f.index);
  assert.deepEqual(result.map(row => row.text), ["first write", "second write", "third write"]);
  assert.deepEqual(searchMessageHistoryIndex(f.directory, { limit: 10, query: "later" }, f.index), []);
  assert.deepEqual(recentMessageContextItems([f.directory], { limit: 10 }).map(row => row.text), result.map(row => row.text));
});


test("archive endpoint ranges never hide interior out-of-order writes", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const archive = path.join(f.directory, "conversation/archive/1~3.jsonl");
  const rows = [f.record(1, "first", { time: 100 }), f.record(99, "middle", { time: 300 }), f.record(3, "last", { time: 200 })];
  fs.writeFileSync(archive, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  fs.writeFileSync(path.join(f.directory, "conversation/archive/index.json"), JSON.stringify({ schemaVersion: 1, nextSequence: 100,
    legacyImportedAt: "2026-01-01T00:00:00Z", archives: [{ file: "1~3.jsonl", firstSequence: 1, lastSequence: 3,
      startedAt: new Date(100000).toISOString(), endedAt: new Date(200000).toISOString(), entryCount: 3 }] }));
  refreshMessageHistoryIndex(f.directory, f.index);
  for (const filter of [{ from: 250, to: 350 }, { afterSequence: 90 }]) {
    const query = { limit: 10, includeArchives: true, ...filter };
    assert.deepEqual(searchMessageHistoryIndex(f.directory, query, f.index).map(row => row.text), ["middle"]);
    assert.deepEqual(recentMessageContextItems([f.directory], query).map(row => row.text), ["middle"]);
  }
});

test("append replay returns the same first write as queries without changing ledgers", t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const catalog = path.join(f.directory, "conversation/archive/index.json");
  fs.writeFileSync(catalog, JSON.stringify({ ...JSON.parse(fs.readFileSync(catalog, "utf8")), legacyImportedAt: "2026-01-01T00:00:00Z" }));
  const archive = path.join(f.directory, "conversation/archive/1~3.jsonl");
  const before = [fs.readFileSync(archive, "utf8"), fs.readFileSync(f.current, "utf8")];
  const replay = appendMessageContextToDir(f.directory, f.record(40, "replay", { id: "duplicate" }) as MessageContextRecord, { archiveCheck: false });
  assert.ok(replay); assert.equal(replay.appended, false); assert.equal(replay.record.text, "second needle");
  assert.deepEqual([fs.readFileSync(archive, "utf8"), fs.readFileSync(f.current, "utf8")], before);
});


test("cross-directory filtering cannot replace an earlier archived identity", t => {
  const first = fixture(), second = fixture();
  t.after(() => { fs.rmSync(first.root, { recursive: true, force: true }); fs.rmSync(second.root, { recursive: true, force: true }); });
  const catalog = path.join(first.directory, "conversation/archive/index.json");
  fs.writeFileSync(catalog, JSON.stringify({ ...JSON.parse(fs.readFileSync(catalog, "utf8")), legacyImportedAt: "2026-01-01T00:00:00Z" }));
  appendMessageContextToDir(first.directory, first.record(10, "archive preparation", { time: 1500 }) as MessageContextRecord,
    { now: Date.UTC(2026, 0, 1) });
  assert.doesNotMatch(fs.readFileSync(first.current, "utf8"), /duplicate/);
  fs.writeFileSync(second.current, JSON.stringify(second.record(11, "later duplicate", { id: "duplicate", time: 3000 })) + "\n");
  assert.deepEqual(recentMessageContextItems([first.directory, second.directory], { limit: 10, includeArchives: true, from: 2500 }), []);
});
