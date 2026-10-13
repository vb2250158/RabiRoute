import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendMessageContextToDir, messageContextArchiveIndexPath, messageContextCurrentPath, messageContextLockPath } from "./messageContextStore.js";
import { acquireFileLockSync } from "./shared/filePersistence.js";

test("message append prepares legacy archive duplicate summaries outside the lock and skips archive bodies thereafter", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-append-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archiveDir = path.dirname(messageContextArchiveIndexPath(root));
  fs.mkdirSync(archiveDir, { recursive: true });
  const archives = [];
  for (let sequence = 1; sequence <= 3; sequence++) {
    const record = { id: `old-${sequence}`, sequence, recordedAt: "2026-01-01T00:00:00.000Z", time: 10, direction: "inbound", adapter: "fixture", text: "old" };
    const file = `${sequence}~${sequence}.jsonl`;
    fs.writeFileSync(path.join(archiveDir, file), JSON.stringify(record) + "\n");
    archives.push({ file, firstSequence: sequence, lastSequence: sequence, entryCount: 1, startedAt: record.recordedAt, endedAt: record.recordedAt });
  }
  fs.writeFileSync(messageContextCurrentPath(root), "");
  fs.writeFileSync(messageContextArchiveIndexPath(root), JSON.stringify({ schemaVersion: 1, nextSequence: 4, legacyImportedAt: "2026-01-01", archives }));
  const originalRead = fs.readFileSync;
  let archiveReads = 0;
  let lockedReads = 0;
  t.mock.method(fs, "readFileSync", ((...arguments_: Parameters<typeof fs.readFileSync>) => {
    if (/\d+~\d+\.jsonl$/.test(String(arguments_[0]))) {
      archiveReads++;
      if (fs.existsSync(messageContextLockPath(root))) lockedReads++;
    }
    return Reflect.apply(originalRead, fs, arguments_);
  }) as typeof fs.readFileSync);
  const append = (id: string) => appendMessageContextToDir(root, { id, time: 20, direction: "inbound", adapter: "fixture", text: "new" }, { archiveCheck: false });
  assert.equal(append("new-1")?.appended, true);
  assert.equal(lockedReads, 0, "Initial historical duplicate-index migration must not hold the writer lock");
  assert.equal(archiveReads, 3);
  archiveReads = 0;
  assert.equal(append("new-2")?.appended, true);
  assert.equal(archiveReads, 0, "A unique message must not parse every historical archive");
  assert.equal(append("old-2")?.appended, false);
  assert.equal(archiveReads, 1, "Positive duplicate hints still verify the original full-fidelity record");
  assert.equal(fs.readFileSync(messageContextCurrentPath(root), "utf8").trim().split("\n").length, 2);
  const saved = JSON.parse(fs.readFileSync(messageContextArchiveIndexPath(root), "utf8"));
  saved.archives[1].duplicateFilter.bits = "AAAA";
  fs.writeFileSync(messageContextArchiveIndexPath(root), JSON.stringify(saved));
  archiveReads = 0;
  assert.equal(append("old-2")?.appended, false, "Corrupt hints rebuild instead of silently accepting a duplicate");
  assert.equal(archiveReads, 2);
  assert.equal(lockedReads, 2, "Only positive record verification holds the lock, never hint rebuilding");
  fs.writeFileSync(messageContextArchiveIndexPath(root), "broken index");
  assert.equal(append("old-1")?.appended, false, "Missing index rebuild preserves historical identity");
  assert.equal(fs.readFileSync(messageContextCurrentPath(root), "utf8").trim().split("\n").length, 2);
});

test("file-lock release never removes a replacement owner's token", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-lock-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, "writer.lock");
  const release = acquireFileLockSync(lock);
  const replacement = { owner: "replacement", host: os.hostname(), pid: process.pid, createdAt: Date.now() };
  fs.writeFileSync(lock, JSON.stringify(replacement));
  release(); release();
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, "utf8")), replacement);
});

test("an old-mtime legacy lock with a live local pid is not reclaimed", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-lock-live-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, "writer.lock");
  const record = { pid: process.pid, createdAt: Date.now() - 60000 };
  fs.writeFileSync(lock, JSON.stringify(record));
  fs.utimesSync(lock, new Date(0), new Date(0));
  assert.throws(() => acquireFileLockSync(lock, { timeoutMs: 100, staleMs: 100 }), /Timed out waiting/);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, "utf8")), record);
});
