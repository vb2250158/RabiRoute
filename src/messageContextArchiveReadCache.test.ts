import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageContextArchiveReadCache } from "./messageContextArchiveReadCache.js";
import { recentMessageContextItems, type MessageContextRecord } from "./messageContextStore.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-read-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "first.jsonl");
  const record = (text: string, sequence = 1): MessageContextRecord => ({ id: `record-${sequence}`, sequence,
    time: 1767225600 + sequence, recordedAt: "2026-01-01T00:00:00Z", direction: "inbound", adapter: "synthetic", text });
  const write = (target: string, text: string, sequence = 1) => fs.writeFileSync(target, JSON.stringify(record(text, sequence)) + "\n");
  const load = (target: string): MessageContextRecord[] => {
    try { return [JSON.parse(fs.readFileSync(target, "utf8"))]; } catch { return []; }
  };
  write(file, "first");
  return { root, file, record, write, load };
}

test("unchanged archives are reused; edits, replacements and deletion invalidate cached records", t => {
  const { file, write, load } = fixture(t);
  const cache = new MessageContextArchiveReadCache();
  let reads = 0;
  const read = (target: string) => { reads++; return load(target); };
  assert.equal(cache.read(file, read)[0].text, "first");
  assert.equal(cache.read(file, read)[0].text, "first");
  assert.equal(reads, 1);
  write(file, "edited-longer");
  assert.equal(cache.read(file, read)[0].text, "edited-longer");
  const replacement = file + ".replacement";
  write(replacement, "replacement");
  fs.renameSync(replacement, file);
  assert.equal(cache.read(file, read)[0].text, "replacement");
  fs.unlinkSync(file);
  assert.deepEqual(cache.read(file, read), []);
  assert.equal(reads, 4);
});

test("expiry, file limit and estimated byte budget bound retained archive data", t => {
  const { root, file, write, load } = fixture(t);
  const other = path.join(root, "other.jsonl");
  write(other, "other");
  let now = 0;
  let reads = 0;
  const read = (target: string) => { reads++; return load(target); };
  const cache = new MessageContextArchiveReadCache(8192, 1, 10, () => now);
  cache.read(file, read); cache.read(file, read);
  assert.equal(reads, 1);
  now = 10;
  cache.read(file, read);
  assert.equal(reads, 2);
  cache.read(other, read); cache.read(file, read);
  assert.equal(reads, 4);
  const small = new MessageContextArchiveReadCache(1);
  small.read(file, read); small.read(file, read);
  assert.equal(reads, 6);
});

test("a file that changes while loading is not cached", t => {
  const { file, write, load } = fixture(t);
  const cache = new MessageContextArchiveReadCache();
  cache.read(file, target => { const old = load(target); write(target, "changed-during-read"); return old; });
  assert.equal(cache.read(file, load)[0].text, "changed-during-read");
});

test("cached searches preserve dedupe before filtering and reread current messages; returned values cannot poison the cache", t => {
  const { root, record, write } = fixture(t);
  const archive = path.join(root, "conversation", "archive");
  fs.mkdirSync(archive, { recursive: true });
  const archived = path.join(archive, "1~1.jsonl");
  write(archived, "old winner");
  fs.writeFileSync(path.join(archive, "index.json"), JSON.stringify({ schemaVersion: 1, nextSequence: 3,
    archives: [{ file: "1~1.jsonl", firstSequence: 1, lastSequence: 1, entryCount: 1,
      startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:00Z" }] }));
  const current = path.join(root, "conversation", "current.jsonl");
  fs.writeFileSync(current, JSON.stringify({ ...record("new matching copy", 2), id: "record-1" }) + "\n");
  const cache = new MessageContextArchiveReadCache();
  const query = { includeArchives: true, limit: 10 };
  const result = recentMessageContextItems([root], query, {}, cache);
  assert.deepEqual(result.map(item => item.text), ["old winner"]);
  result[0].text = "poisoned";
  assert.equal(recentMessageContextItems([root], query, {}, cache)[0].text, "old winner");
  assert.deepEqual(recentMessageContextItems([root], { ...query, query: "matching" }, {}, cache), []);
  write(current, "fresh current", 3);
  assert.deepEqual(recentMessageContextItems([root], query, {}, cache).map(item => item.text), ["old winner", "fresh current"]);
});
