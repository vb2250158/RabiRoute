import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { KnowledgeSqlitePrototype, type SqliteKnowledgeQuery, type SqliteKnowledgeRow } from "./knowledgeSqlitePrototype.js";
import { syntheticKnowledgeRow } from "./knowledgeSqliteSyntheticFixture.js";
import { knowledgeSearchRecordText, normalizeKnowledgeSearchText as normalize } from "../../src/roleKnowledgeSearch.js";

// Isolated synthetic experiment only; not a production API/cursor acceptance test.
// Run with the actual Node 22 executable: --import tsx --test tests/performance/knowledgeSqlitePrototype.test.ts
// Only KNOWLEDGE_SQLITE_BENCHMARK=100000 enables the large benchmark.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "knowledge-sqlite-prototype-"));
  const file = join(directory, "synthetic.sqlite");
  const index = new KnowledgeSqlitePrototype(file);
  return { file, index, dispose() { index.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function row(id: string, text: string, extra: Partial<SqliteKnowledgeRow> = {}): SqliteKnowledgeRow {
  return { id, text: normalize(text), kind: "plan", status: "open", archived: false,
    updatedAt: "2026-01-01T00:00:00.000Z", tags: ["sample"], ...extra };
}
function expected(rows: SqliteKnowledgeRow[], query: SqliteKnowledgeQuery) {
  return rows.filter(r => r.text.includes(query.text) && (query.kind === undefined || r.kind === query.kind)
    && (query.status === undefined || r.status === query.status) && (query.archived === true || !r.archived)
    && (query.tag === undefined || r.tags.includes(query.tag)))
    .sort((a, b) => a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function compare(index: KnowledgeSqlitePrototype, rows: SqliteKnowledgeRow[], query: SqliteKnowledgeQuery) {
  const matches = expected(rows, query);
  const result = index.search(query, rows.length + 1);
  assert.equal(result.total, matches.length, JSON.stringify(query));
  assert.deepEqual(result.items.map(r => r.id), matches.map(r => r.id), JSON.stringify(query));
  const counts = new Map<string, number>();
  for (const r of matches) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  assert.deepEqual(result.facets.map(r => ({ status: r.status, count: Number(r.count) })),
    [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([status, count]) => ({ status, count })));
}

test("normalized nested strings and literal Unicode substring differential", () => {
  const f = fixture();
  try {
    const nested = { title: " ＡＢＣ 中文 ", content: ["Café", { body: ["e\u0301", "😀🚀", "100%_literal", "before\0after"] }],
      viewedAt: "ignored-view", deep: { storageRevision: "ignored-revision", value: "Nested" }, number: 123 };
    const text = knowledgeSearchRecordText(nested);
    assert.equal(text, normalize(" ＡＢＣ 中文 \nCafé\ne\u0301\n😀🚀\n100%_literal\nbefore\0after\nNested"));
    assert.ok(!text.includes("ignored"));
    const samples = [text, "你好世界 中文全文", "ABC abc a_b a%b a\\b", 'quote "and" OR NEAR * ()',
      "İ I ı ß Σ σ ς K ﬁ", "😀🚀星球𠮷", "x\0after-null-needle", "\0start", "end\0", "雪\n山\t海", "a\r\nb", "", "é e\u0301"];
    let seed = 42;
    const alphabet = ["a", "B", "中", "文", "%", "_", "\0", "😀", "é", "\n", '"'];
    for (let n = 0; n < 70; n++) {
      let value = "";
      for (let j = 0; j < 18; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; value += alphabet[seed % alphabet.length]; }
      samples.push(value);
    }
    const rows = samples.map((s, n) => row(String(n).padStart(3, "0"), s));
    f.index.transaction(() => rows.forEach(r => f.index.upsert(r)));
    const queries = new Set(["", "ABC", "中文", "中", "%", "_", "%_", "a_b", "a%b", "\0", "\0a", "after", "after-null", "before\0after", "😀", "😀🚀", "🚀星球", "é", '"and"', "NEAR", "\n", "\r\n", "missing"]);
    for (const r of rows) {
      const points = Array.from(r.text);
      for (let start = 0; start < points.length; start += 3) for (const length of [1, 2, 3, 5]) queries.add(points.slice(start, start + length).join(""));
    }
    for (const q of queries) compare(f.index, rows, { text: normalize(q) });
    console.log(JSON.stringify({ experiment: "substring-differential", rows: rows.length, queries: queries.size }));
  } finally { f.dispose(); }
});

test("structured filters, facets and stable keyset on tied timestamps", () => {
  const f = fixture();
  try {
    const rows = Array.from({ length: 45 }, (_, n) => row(`r${String(n).padStart(3, "0")}`, "common 中文", {
      kind: n % 2 ? "recent" : "plan", status: ["open", "done", "custom"][n % 3]!, archived: n % 4 === 0,
      tags: n % 2 ? ["x", "x", "special%_"] : ["y"], updatedAt: `2026-01-0${1 + n % 3}T00:00:00.000Z` }));
    f.index.transaction(() => rows.forEach(r => f.index.upsert(r)));
    for (const archived of [undefined, false, true]) for (const kind of [undefined, "plan", "recent", "absent"])
      for (const status of [undefined, "open", "done"]) for (const tag of [undefined, "x", "special%_", "absent"])
        compare(f.index, rows, { text: "common", archived, kind, status, tag });
    const query = { text: "common", archived: true };
    const ids: string[] = [];
    let after: { updatedAt: string; id: string } | undefined;
    for (;;) {
      const page = f.index.search(query, 4, after);
      assert.equal(page.total, rows.length);
      if (!page.items.length) break;
      ids.push(...page.items.map(r => String(r.id)));
      const last = page.items.at(-1)!;
      after = { updatedAt: String(last.updatedAt), id: String(last.id) };
      assert.ok(ids.length <= rows.length);
    }
    assert.deepEqual(ids, expected(rows, query).map(r => r.id));
    assert.equal(new Set(ids).size, rows.length);
  } finally { f.dispose(); }
});

test("committed insert/update/delete persist and failed batches roll back all indexes", () => {
  const f = fixture();
  try {
    const original = row("one", "oldneedle 中文", { tags: ["old"] });
    f.index.transaction(() => f.index.upsert(original));
    const snapshot = () => ["documents", "tags", "short_terms", "fulltext"].map(table => f.index.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
    const before = snapshot();
    assert.throws(() => f.index.transaction(() => {
      f.index.upsert(row("one", "newneedle 新词", { tags: ["new"] }));
      f.index.upsert(row("two", "inserted")); f.index.remove("one"); throw new Error("injected rollback");
    }), /injected rollback/);
    assert.deepEqual(snapshot(), before);
    const changed = row("one", "newneedle 新词", { tags: ["new"] });
    f.index.transaction(() => { f.index.upsert(changed); f.index.upsert(row("two", "deleted")); f.index.remove("two"); f.index.remove("missing"); });
    const reader = new KnowledgeSqlitePrototype(f.file);
    try {
      for (const text of ["oldneedle", "中文", "newneedle", "新", "新词", "deleted"]) compare(reader, [changed], { text });
      compare(reader, [changed], { text: "", tag: "old" }); compare(reader, [changed], { text: "", tag: "new" });
      const plan = reader.db.prepare("EXPLAIN QUERY PLAN DELETE FROM fulltext WHERE rowid=?").all(1);
      assert.match(JSON.stringify(plan), /INDEX .*=/);
      console.log(JSON.stringify({ experiment: "fts-rowid-delete-plan", plan }));
    } finally { reader.close(); }
  } finally { f.dispose(); }
});

const synthetic = syntheticKnowledgeRow;
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { count: values.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99) };
}
const workerSource = `
const { parentPort, workerData, threadId } = require('node:worker_threads');
(async () => {
  const { tsImport } = await import('tsx/esm/api');
  const { KnowledgeSqlitePrototype } = await tsImport(workerData.module, workerData.parent);
  const index = new KnowledgeSqlitePrototype(workerData.file);
  index.db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-2048');
  parentPort.postMessage({ ready: true, threadId });
  parentPort.once('message', () => {
    const samples = []; let errors = 0; const failures = [];
    const start = performance.now();
    for (let i = 0; i < workerData.iterations; i++) {
      const position = (i + workerData.ordinal) % workerData.cases.length;
      const item = workerData.cases[position]; const began = performance.now();
      try { const result = index.search(item.query); if (result.total !== item.total) throw Error('count mismatch: ' + result.total + ' != ' + item.total); }
      catch (error) { errors++; failures.push(String(error)); }
      samples.push({ position, ms: performance.now() - began });
    }
    index.close(); parentPort.postMessage({ threadId, samples, errors, failures, elapsedMs: performance.now() - start, rss: process.memoryUsage().rss });
    parentPort.close();
  });
})().catch(error => { throw error; });
`;

test("synthetic index benchmark and 20 genuine worker readers", { timeout: 600_000 }, async () => {
  const count = process.env.KNOWLEDGE_SQLITE_BENCHMARK === "100000" ? 100_000 : 300;
  const f = fixture();
  const workers: Worker[] = [];
  try {
    const rssBefore = process.memoryUsage().rss;
    let sampledRssMax = rssBefore, textBytes = 0, codePoints = 0, trigramOccurrences = 0;
    const began = performance.now();
    for (let offset = 0; offset < count; offset += 500) {
      f.index.transaction(() => {
        for (let n = offset; n < Math.min(count, offset + 500); n++) {
          const record = synthetic(n); textBytes += Buffer.byteLength(record.text); const length = Array.from(record.text).length;
          codePoints += length; trigramOccurrences += Math.max(0, length - 2); f.index.upsert(record);
        }
      });
      sampledRssMax = Math.max(sampledRssMax, process.memoryUsage().rss);
    }
    const buildMs = performance.now() - began;
    const fileBytes = () => Object.fromEntries(["", "-wal", "-shm"].map(suffix => { try { return [suffix || "database", statSync(f.file + suffix).size]; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return [suffix, 0]; } }));
    const afterBuildBytes = fileBytes();
    const shortTermRows = Number(f.index.db.prepare("SELECT count(*) AS n FROM short_terms").get()!.n);
    f.index.db.exec("CREATE VIRTUAL TABLE temp.gram_vocab USING fts5vocab(main, fulltext, instance)");
    const actualTrigramPostings = Number(f.index.db.prepare("SELECT count(*) AS n FROM temp.gram_vocab").get()!.n);
    const queries: SqliteKnowledgeQuery[] = [
      { text: "token-000123", archived: true }, { text: "bucket17", archived: true },
      { text: "中文", kind: "plan", status: "open", tag: "group2" },
      { text: "%_", archived: true }, { text: "not-present-anywhere" }, { text: "中", archived: true },
      { text: "synthetic", archived: true }, { text: "literal%_", kind: "recent" }
    ];
    const cases = queries.map(query => {
      let total = 0;
      for (let n = 0; n < count; n++) if (expected([synthetic(n)], query).length) total++;
      assert.equal(f.index.search(query).total, total);
      return { query, total };
    });
    const sequential = cases.map(item => {
      const values: number[] = [];
      for (let n = 0; n < 5; n++) { const start = performance.now(); assert.equal(f.index.search(item.query).total, item.total); values.push(performance.now() - start); }
      return { query: item.query, ...distribution(values) };
    });
    type WorkerResult = { threadId: number; samples: { position: number; ms: number }[]; errors: number; failures: string[]; elapsedMs: number; rss: number };
    const results: Promise<WorkerResult>[] = [];
    const ready: Promise<void>[] = [];
    for (let ordinal = 0; ordinal < 20; ordinal++) {
      const worker = new Worker(workerSource, { eval: true, workerData: { module: new URL("./knowledgeSqlitePrototype.ts", import.meta.url).href,
        parent: import.meta.url, file: f.file, ordinal, iterations: count === 100_000 ? 24 : 8, cases } });
      workers.push(worker);
      ready.push(new Promise((resolve, reject) => { worker.once("message", message => message.ready ? resolve() : reject(new Error("worker not ready"))); worker.once("error", reject); }));
      results.push(new Promise((resolve, reject) => {
        let received = false;
        worker.on("message", message => { if (!message.ready) { received = true; resolve(message); } });
        worker.once("error", reject); worker.once("exit", code => { if (!received) reject(new Error(`worker exited before result: ${code}`)); });
      }));
    }
    // Attach all rejection handlers before waiting for readiness.
    const completed = Promise.all(results);
    await Promise.race([Promise.all(ready), completed]);
    const concurrentBegan = performance.now();
    for (const worker of workers) worker.postMessage("start");
    const reports = await completed;
    const concurrentMs = performance.now() - concurrentBegan;
    assert.equal(new Set(reports.map(r => r.threadId)).size, 20);
    const errors = reports.reduce((sum, r) => sum + r.errors, 0);
    assert.equal(errors, 0, JSON.stringify(reports.flatMap(r => r.failures)));
    const samples = reports.flatMap(r => r.samples);
    const updates: number[] = [];
    for (let n = 0; n < 30; n++) {
      const start = performance.now();
      f.index.transaction(() => f.index.upsert({ ...synthetic(n), text: normalize(`replacement ${n} 改动`), tags: ["updated"] }));
      updates.push(performance.now() - start);
    }
    assert.equal(f.index.search({ text: "replacement", archived: true }).total, 30);
    console.log(JSON.stringify({ experiment: "sqlite-synthetic-only", node: process.version,
      sqlite: f.index.db.prepare("SELECT sqlite_version() AS version").get()!.version,
      count, buildMs, afterBuildBytes, afterUpdateBytes: fileBytes(), rssBefore,
      sampledRssMax: Math.max(sampledRssMax, ...reports.map(r => r.rss)), rssAfter: process.memoryUsage().rss,
      textBytes, codePoints, trigramOccurrences, actualTrigramPostings, shortTermRows,
      gramRowsPerCodePoint: (actualTrigramPostings + shortTermRows) / codePoints,
      storageBytesPerTextByte: Object.values(afterBuildBytes).reduce((a, b) => a + b, 0) / textBytes,
      sequential, workers: 20, concurrentMs, query: distribution(samples.map(s => s.ms)),
      queriesPerSecond: samples.length / (concurrentMs / 1000), errors,
      perQuery: cases.map((item, position) => ({ ...item, ...distribution(samples.filter(s => s.position === position).map(s => s.ms)) })),
      updateCommit: distribution(updates), caveats: ["Warm local synthetic database; includes total/facets/page per query", "RSS is process-wide sampled, not sum of worker RSS or true peak", "Keyset stability is tested on an unchanged snapshot; no production cursor contract"] }));
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    f.dispose();
  }
});
