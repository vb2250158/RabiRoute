import { getTimeoutMs } from "./shared/timeoutSettings.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { refreshManagedMessageIndex, quarantineMessageIndexProjection } from "./messageHistoryIndexLifecycle.js";
import { openMessageHistoryReader } from "./messageHistoryIndexReaders.js";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import { readMessageHistoryTail, verifyMessageHistoryPrefix, hasNormalizedMessageHistoryRecord, MESSAGE_HISTORY_TAIL_FORMAT, MESSAGE_HISTORY_INDEX_RECORD_BYTES, type MessageHistoryCursor, type MessageHistoryTailRow } from "./messageHistoryTail.js";
import { messageHistoryFileVersion as fingerprint, messageHistoryLayoutVersion, messageHistoryObservationProven, messageHistoryCatalogObservationProven,
  type MessageHistoryAppendProof, type MessageHistoryOwnerTarget } from "./messageHistorySourceVersion.js";
import { messageHistoryStorage, MESSAGE_CONTEXT_RECORD_OVERHEAD_CHARS, messageContextCurrentPath, messageContextArchiveIndexPath,
  messageContextArchiveDir, type MessageContextRecord, type RecentMessageContextQuery } from "./messageContextStore.js";

const SCHEMA_VERSION = "7";
const ANALYZER_VERSION = `utf16-grams-v1:${process.versions.unicode}:${Intl.DateTimeFormat().resolvedOptions().locale}`;
export type MessageHistorySearchResult = {
  entries: MessageContextRecord[];
  coverage: { indexVersion: string; sourceVersion: string; indexedAt: string; sourceSnapshotIndexed: boolean;
    indexCoverage?: "complete" | "partial"; sourceRecordsSkipped?: number; pendingRecordBytes?: number; maxIndexedRecordBytes?: number;
    legacyCoverageUnknown?: boolean;
    sourceRecordIssues?: { malformed: number; oversized: number; unrecognized: number } };
  metrics: { strategy: "postings" | "ordered"; candidates: number; elapsedMs: number; snapshotMs?: number; projectionMs?: number; candidateMs?: number };
};
type Source = { file: string; current: number; ordinal: number; first: number; last: number; start: number; end: number; fingerprint: string };
type Snapshot = { sources: Source[]; guards: Record<string, string>; legacy: boolean; layoutVersion: string };
export type MessageHistorySearchTarget = { guards: Record<string, string>; currentEpoch?: string;
  owner?: MessageHistoryOwnerTarget; observedStamp?: string; observedAt?: number; observedCatalogStamp?: string; observedCatalogAt?: number };
export type MessageHistorySearchProbe = { ready: true; result: MessageHistorySearchResult }
  | { ready: false; reason: string; target?: MessageHistorySearchTarget; diagnostic?: string; elapsedMs?: number };
class MessageHistoryIndexLag extends Error {
  constructor(readonly target: MessageHistorySearchTarget, readonly diagnostic = "source_checkpoint") { super("MESSAGE_HISTORY_INDEX_LAGGING"); }
}
type SearchRow = { rowid: number; recordKey: string; seq: number; time: number; id: string; sourceOrder: number; position: number; chars: number };
export type MessageHistoryIndexRefreshResult = { records: number; filesRead: number; walBytes: number; sourceFiles: number;
  currentRecords?: number; currentVersion: string; layoutVersion: string };

function writeProgress(database: string, value: { phase: string; records: number; completedSources: number; totalSources: number }, force = false): void {
  const file = path.join(path.dirname(database), "index-progress.json");
  let due = true;
  try { due = Date.now() - fs.statSync(file).mtimeMs >= 5_000; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (force || due) atomicWriteFileSync(file, JSON.stringify({ ...value, updatedAt: new Date().toISOString() }), { mode: 0o600 });
}

function describeRefresh(db: DatabaseSync, database: string, captured: Snapshot, records: number, filesRead: number): MessageHistoryIndexRefreshResult {
  const source = captured.sources.find(item => item.current)!;
  const cursor = db.prepare("SELECT cursor FROM cursors WHERE file=?").get(source.file)?.cursor;
  let walBytes = 0;
  try { walBytes = fs.statSync(database + "-wal").size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  writeProgress(database, { phase: "ready", records, completedSources: captured.sources.length, totalSources: captured.sources.length });
  return { records, filesRead, walBytes, sourceFiles: captured.sources.length, currentVersion: source.fingerprint,
    currentRecords: cursor ? (JSON.parse(String(cursor)) as MessageHistoryCursor).records : undefined, layoutVersion: captured.layoutVersion };
}

export function messageHistoryIndexPath(directory: string): string {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache");
  const identity = process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory);
  return path.join(root, "RabiRoute", "Cache", "message-search", createHash("sha256").update(identity).digest("hex") + ".sqlite");
}

function snapshot(directory: string): Snapshot {
  const current = messageContextCurrentPath(directory);
  const catalog = messageContextArchiveIndexPath(directory);
  const archiveDirectory = messageContextArchiveDir(directory);
  const catalogBefore = fingerprint(catalog);
  const currentBefore = catalogBefore === "missing" ? fingerprint(current) : undefined;
  const archiveDirectoryBefore = catalogBefore === "missing" ? fingerprint(archiveDirectory) : undefined;
  const archives = messageHistoryStorage.readArchives(directory);
  const legacy = catalogBefore === "missing" && (currentBefore === "missing" || Number(currentBefore?.split(":")[2]) === 0
    || !hasNormalizedMessageHistoryRecord(current));
  const sources: Source[] = archives.map((item, ordinal) => ({ file: path.join(messageContextArchiveDir(directory), item.file),
    current: 0, ordinal, first: item.firstSequence, last: item.lastSequence,
    start: Date.parse(item.startedAt) / 1000, end: Date.parse(item.endedAt) / 1000, fingerprint: "" }));
  sources.push({ file: current, current: 1, ordinal: sources.length, first: 0, last: 0, start: 0, end: 0, fingerprint: "" });
  const guards: Record<string, string> = {};
  const guarded = [current, messageContextArchiveIndexPath(directory), messageContextArchiveDir(directory), ...sources.map(item => item.file)];
  if (legacy) {
    guarded.push(...["message-context.jsonl", "group-messages.jsonl", "private-messages.jsonl", "wecom-messages.jsonl", "weixin-messages.jsonl",
      "feishu-messages.jsonl", "voice-transcripts.jsonl", "heartbeat-events.jsonl", "manual-trigger-events.jsonl", "outbox-adapter.log.jsonl",
      "role-panel/messages.jsonl", "rabilink-conversation.jsonl", "rabilink-conversations"].map(file => path.join(directory, file)));
  }
  for (const file of guarded) guards[file] = fingerprint(file);
  if (guards[catalog] !== catalogBefore || (catalogBefore === "missing"
    && (guards[current] !== currentBefore || guards[archiveDirectory] !== archiveDirectoryBefore))) {
    throw new Error("MESSAGE_HISTORY_INDEX_LAGGING");
  }
  for (const item of sources) item.fingerprint = guards[item.file];
  return { sources, guards, legacy, layoutVersion: messageHistoryLayoutVersion(archives) };
}

function currentGuards(guards: Record<string, string>): boolean {
  return Object.entries(guards).every(([file, stamp]) => fingerprint(file) === stamp);
}

/** Encode UTF-16 grams as ASCII tokens: punctuation, short CJK and surrogates stay literal. */
export function messageSearchGrams(text: string, length: number): string {
  const grams: string[] = [];
  for (let i = 0; i + length <= text.length; i++) {
    let token = "x";
    for (let offset = 0; offset < length; offset++) token += text.charCodeAt(i + offset).toString(16).padStart(4, "0");
    grams.push(token);
  }
  return [...new Set(grams)].join(" ");
}

function initialize(db: DatabaseSync): void {
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=${getTimeoutMs("history.sqliteWriteWait", 100)};
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources(file TEXT PRIMARY KEY,current INTEGER,ordinal INTEGER,first REAL,last REAL,start REAL,end REAL,fingerprint TEXT);
    CREATE TABLE IF NOT EXISTS cursors(file TEXT PRIMARY KEY,cursor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents(rowid INTEGER PRIMARY KEY,source TEXT,position INTEGER,sourceOrder INTEGER NOT NULL DEFAULT 0,recordKey TEXT,seq REAL,time REAL,id TEXT,
      adapter TEXT,channel TEXT,kind TEXT,sender TEXT,target TEXT,conversationKey TEXT,chars INTEGER,payload TEXT);
    CREATE INDEX IF NOT EXISTS document_source ON documents(source);
    CREATE INDEX IF NOT EXISTS document_identity ON documents(recordKey);
    CREATE INDEX IF NOT EXISTS document_sequence ON documents(seq DESC,time DESC);
    CREATE INDEX IF NOT EXISTS document_conversation ON documents(conversationKey,seq DESC);
    CREATE INDEX IF NOT EXISTS document_time ON documents(time,seq DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS terms USING fts5(g1,g2,g3,content='',contentless_delete=1,detail=column,tokenize='ascii');`);
  const version = db.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value;
  if (version && version !== SCHEMA_VERSION && version !== "4" && version !== "5" && version !== "6") throw new Error("MESSAGE_HISTORY_INDEX_VERSION_MISMATCH");
  const analyzer = db.prepare("SELECT value FROM meta WHERE key='analyzer'").get()?.value;
  if (version && analyzer !== ANALYZER_VERSION) throw new Error("MESSAGE_HISTORY_INDEX_VERSION_MISMATCH");
  if (!db.prepare("PRAGMA table_info(documents)").all().some(column => column.name === "sourceOrder")) {
    db.exec("ALTER TABLE documents ADD COLUMN sourceOrder INTEGER NOT NULL DEFAULT 0");
  }
  if (version && version !== SCHEMA_VERSION) {
    // Repeat safely after interruption between adding the derived column and
    // publishing the new schema. Original payloads and ledgers never change.
    db.exec("UPDATE documents SET sourceOrder=COALESCE((SELECT ordinal FROM sources WHERE sources.file=documents.source),0)");
  }
  db.exec("CREATE INDEX IF NOT EXISTS document_write_order ON documents(sourceOrder DESC,position DESC,rowid DESC)");
  if (version === "4" || version === "5" || version === "6") {
    // Metadata-only upgrades retain documents/postings; obsolete vocabulary
    // statistics are retired without a source or posting rebuild.
    db.exec("BEGIN IMMEDIATE; DROP TABLE IF EXISTS term_counts");
    try { db.prepare("INSERT OR REPLACE INTO meta VALUES('schema',?)").run(SCHEMA_VERSION);
      db.prepare("INSERT OR REPLACE INTO meta VALUES('comparator','source-write-order-v2')").run(); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}

/** Background-only indexing. Changed source bodies and their checkpoints commit together. */
export function refreshMessageHistoryIndex(directory: string, indexPath = messageHistoryIndexPath(directory), options: { rebuild?: boolean } = {}): MessageHistoryIndexRefreshResult {
  return refreshManagedMessageIndex(indexPath, databasePath => refreshMessageHistoryDatabase(directory, databasePath), options);
}

function refreshMessageHistoryDatabase(directory: string, indexPath: string): MessageHistoryIndexRefreshResult {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const db = new DatabaseSync(indexPath);
  try {
    initialize(db);
    const captured = snapshot(directory);
    const previous = new Map(db.prepare("SELECT file,fingerprint FROM sources").all().map(row => [String(row.file), String(row.fingerprint)]));
    const oldGuards = db.prepare("SELECT value FROM meta WHERE key='snapshot'").get()?.value;
    const publishedCount = db.prepare("SELECT value FROM meta WHERE key='records'").get()?.value;
    const checkpointCount = db.prepare("SELECT value FROM meta WHERE key='checkpointRecords'").get()?.value;
    if (oldGuards && publishedCount === undefined) throw new Error("MESSAGE_HISTORY_INDEX_INTEGRITY: missing record count");
    for (const count of [publishedCount, checkpointCount]) if (count !== undefined && (!Number.isSafeInteger(Number(count)) || Number(count) < 0)) {
      throw new Error("MESSAGE_HISTORY_INDEX_INTEGRITY: invalid record count");
    }
    const layoutChanged = db.prepare("SELECT value FROM meta WHERE key='layout'").get()?.value !== captured.layoutVersion;
    const tailFormatChanged = db.prepare("SELECT value FROM meta WHERE key='tailFormat'").get()?.value !== String(MESSAGE_HISTORY_TAIL_FORMAT);
    if (!tailFormatChanged && oldGuards === JSON.stringify(captured.guards)) {
      const sources = db.prepare("SELECT file,fingerprint FROM sources").all();
      if (sources.length === captured.sources.length && sources.every(row => captured.guards[String(row.file)] === row.fingerprint)) {
        db.prepare("INSERT OR REPLACE INTO meta VALUES('layout',?)").run(captured.layoutVersion);
        if (checkpointCount === undefined) db.prepare("INSERT OR REPLACE INTO meta VALUES('checkpointRecords',?)").run(String(publishedCount));
        return describeRefresh(db, indexPath, captured, Number(publishedCount), 0);
      }
    }
    const legacyChanged = captured.legacy && (!oldGuards || String(oldGuards) !== JSON.stringify(captured.guards));
    let filesRead = 0;
    let recordsCount = checkpointCount === undefined ? Number(db.prepare("SELECT count(*) AS n FROM documents").get()!.n) : Number(checkpointCount);
    let currentPrefix: ReturnType<typeof readMessageHistoryTail>["snapshot"] | undefined;
    db.exec("BEGIN IMMEDIATE");
    try {
      const removeTerms = db.prepare("DELETE FROM terms WHERE rowid IN (SELECT rowid FROM documents WHERE source=?)");
      const removeDocs = db.prepare("DELETE FROM documents WHERE source=?");
      const remove = (file: string) => { removeTerms.run(file); recordsCount -= Number(removeDocs.run(file).changes); db.prepare("DELETE FROM sources WHERE file=?").run(file); db.prepare("DELETE FROM cursors WHERE file=?").run(file); };
      const insert = db.prepare("INSERT INTO documents(source,position,sourceOrder,recordKey,seq,time,id,adapter,channel,kind,sender,target,conversationKey,chars,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      const insertTerms = db.prepare("INSERT INTO terms(rowid,g1,g2,g3) VALUES(?,?,?,?)");
      for (const file of previous.keys()) if (!captured.sources.some(item => item.file === file)) remove(file);
      for (const source of captured.sources) {
        const oldCursor = db.prepare("SELECT cursor FROM cursors WHERE file=?").get(source.file)?.cursor;
        const cursor = oldCursor ? JSON.parse(String(oldCursor)) as MessageHistoryCursor : undefined;
        const sourceChanged = previous.get(source.file) !== source.fingerprint || (source.current && legacyChanged)
          || (tailFormatChanged && (!cursor || cursor.format !== MESSAGE_HISTORY_TAIL_FORMAT));
        if (sourceChanged) {
          const tail = !(source.current && captured.legacy) ? readMessageHistoryTail(source.file,
            cursor, source.fingerprint, source.current ? "valid" : true, Boolean(source.current)) : undefined;
          const legacyDiagnostics = source.current && captured.legacy ? readMessageHistoryTail(source.file, undefined, source.fingerprint, "valid") : undefined;
          if (tail && source.current) currentPrefix = tail.snapshot;
          const priorRows = !tail && source.current && previous.has(source.file)
            ? db.prepare("SELECT rowid,position,payload FROM documents WHERE source=?").all(source.file) : [];
          const prior = new Map(priorRows.map(row => [Number(row.position), row]));
          if (tail?.reset || !previous.has(source.file)) remove(source.file);
          const rows: MessageHistoryTailRow[] = tail?.rows ?? (captured.legacy && source.current ? messageHistoryStorage.readLegacy(directory) : messageHistoryStorage.readRecords(source.file))
            .map((record, position) => ({ record, position }));
          filesRead++;
          for (const { position, record, checkpoint } of rows) {
            const serialized = JSON.stringify(record);
            const old = prior.get(position);
            prior.delete(position);
            if (old && old.payload === serialized) continue;
            if (old) {
              db.prepare("DELETE FROM terms WHERE rowid=?").run(old.rowid!);
              recordsCount -= Number(db.prepare("DELETE FROM documents WHERE rowid=?").run(old.rowid!).changes);
            }
            const result = insert.run(source.file, position, source.ordinal, messageHistoryStorage.recordKey(record), record.sequence ?? 0, record.time, record.id ?? "",
              record.adapter, record.channel ?? "", record.kind ?? "", record.sender ?? "", record.target ?? "", record.conversationKey ?? "",
              messageHistoryStorage.charCost(record), serialized);
            recordsCount++;
            const normalized = [record.text, record.sender, record.target].filter(Boolean).join(" ").toLocaleLowerCase();
            insertTerms.run(result.lastInsertRowid, messageSearchGrams(normalized, 1), messageSearchGrams(normalized, 2), messageSearchGrams(normalized, 3));
            if (rows.length > 5000 && position !== rows.at(-1)!.position && (checkpoint || (!tail && (position + 1) % 5000 === 0))) {
              if (checkpoint) db.prepare("INSERT OR REPLACE INTO cursors VALUES(?,?)").run(source.file, JSON.stringify(checkpoint));
              db.prepare("INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?,?,?,?)")
                .run(source.file, source.current, source.ordinal, source.first, source.last, source.start, source.end, `pending:${source.fingerprint}`);
              db.prepare("INSERT OR REPLACE INTO meta VALUES('unpublished','1')").run();
              db.prepare("INSERT OR REPLACE INTO meta VALUES('checkpointRecords',?)").run(String(recordsCount));
              db.exec("COMMIT; BEGIN IMMEDIATE");
              writeProgress(indexPath, { phase: "building", records: recordsCount, completedSources: source.ordinal, totalSources: captured.sources.length }, true);
            }
          }
          for (const old of prior.values()) {
            db.prepare("DELETE FROM terms WHERE rowid=?").run(old.rowid!);
            recordsCount -= Number(db.prepare("DELETE FROM documents WHERE rowid=?").run(old.rowid!).changes);
          }
          if (tail) db.prepare("INSERT OR REPLACE INTO cursors VALUES(?,?)").run(source.file, JSON.stringify(tail.cursor));
          // Legacy rows are supplied by the existing legacy owner, not this byte cursor.
          // Retain current-file diagnostics without permitting it to resume legacy row positions.
          if (legacyDiagnostics) db.prepare("INSERT OR REPLACE INTO cursors VALUES(?,?)").run(source.file, JSON.stringify({ ...legacyDiagnostics.cursor, format: 0 }));
        }
        if (sourceChanged || layoutChanged) db.prepare("INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?,?,?,?)")
          .run(source.file, source.current, source.ordinal, source.first, source.last, source.start, source.end, source.fingerprint);
        if (layoutChanged) db.prepare("UPDATE documents SET sourceOrder=? WHERE source=? AND sourceOrder<>?").run(source.ordinal, source.file, source.ordinal);
        // Checkpoint each immutable source independently. A changing current file
        // must not discard minutes of completed historical indexing.
        if (!source.current && (sourceChanged || layoutChanged)) {
          db.prepare("INSERT OR REPLACE INTO meta VALUES('unpublished','1')").run();
          db.prepare("INSERT OR REPLACE INTO meta VALUES('checkpointRecords',?)").run(String(recordsCount));
          db.exec("COMMIT; BEGIN IMMEDIATE");
          writeProgress(indexPath, { phase: "building", records: recordsCount, completedSources: source.ordinal + 1, totalSources: captured.sources.length }, true);
        }
      }
      // Reused SHA state saves a duplicate prefix pass; it never substitutes for
      // validating the complete captured bytes before their rows become visible.
      if (currentPrefix && !verifyMessageHistoryPrefix(messageContextCurrentPath(directory), currentPrefix)) {
        throw new Error("MESSAGE_HISTORY_INDEX_LAGGING: captured prefix changed during indexing");
      }
      if (!currentGuards(captured.guards)) {
        const after = captured.legacy ? undefined : snapshot(directory);
        const stableArchives = after && captured.layoutVersion === after.layoutVersion
          && captured.sources.filter(item => !item.current).every(item => item.fingerprint === after.guards[item.file]);
        if (!stableArchives || !currentPrefix) {
          throw new Error("MESSAGE_HISTORY_INDEX_LAGGING: source changed during indexing");
        }
      }
      const set = db.prepare("INSERT OR REPLACE INTO meta VALUES(?,?)");
      if (!Number.isSafeInteger(recordsCount) || recordsCount < 0) throw new Error("MESSAGE_HISTORY_INDEX_INTEGRITY: invalid checkpoint count");
      set.run("schema", SCHEMA_VERSION); set.run("analyzer", ANALYZER_VERSION); set.run("comparator", "source-write-order-v2");
      set.run("tailFormat", String(MESSAGE_HISTORY_TAIL_FORMAT));
      set.run("legacyCoverageUnknown", captured.legacy ? "1" : "0");
      set.run("layout", captured.layoutVersion);
      set.run("records", String(recordsCount)); set.run("checkpointRecords", String(recordsCount));
      set.run("unpublished", "0");
      set.run("snapshot", JSON.stringify(captured.guards)); set.run("updatedAt", new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back a full disk. */ } throw error; }
    return describeRefresh(db, indexPath, captured, recordsCount, filesRead);
  } finally { db.close(); }
}

function sourceClause(query: RecentMessageContextQuery, alias: string, _args: (string | number)[]): string {
  // Archive endpoints describe physical writes, not min/max event time or
  // legacy sequence. Filter indexed documents, never prune an entire archive
  // using endpoint timestamps that can run backwards.
  return query.includeArchives ? "1" : `${alias}.current=1`;
}

/** Online path: fingerprints and indexed candidates only; never loads source bodies. */
export function searchMessageHistoryIndex(directory: string, query: RecentMessageContextQuery, indexPath = messageHistoryIndexPath(directory)): MessageContextRecord[] {
  if (query.limit <= 0) return [];
  return searchMessageHistoryIndexResult(directory, query, indexPath).entries;
}

/** Versioned result metadata is separate from the existing entries-only storage helper. */
export function searchMessageHistoryIndexResult(directory: string, query: RecentMessageContextQuery, indexPath = messageHistoryIndexPath(directory),
  options: { target?: MessageHistorySearchTarget; proof?: MessageHistoryAppendProof; visibilityDeadlineAt?: number; ownerTarget?: MessageHistoryOwnerTarget } = {}): MessageHistorySearchResult {
  const began = performance.now();
  let candidates = 0;
  let strategy: "postings" | "ordered" = "postings";
  let projectionMs = 0;
  const reader = openMessageHistoryReader(indexPath);
  const db = reader.db;
  try {
    db.exec(`PRAGMA busy_timeout=${getTimeoutMs("history.sqliteReadWait", 50)}; PRAGMA temp_store=FILE; BEGIN`);
    const meta = new Map(db.prepare("SELECT key,value FROM meta").all().map(row => [String(row.key), String(row.value)]));
    if (meta.get("schema") !== SCHEMA_VERSION || meta.get("analyzer") !== ANALYZER_VERSION || !meta.has("snapshot")
      || meta.get("tailFormat") !== String(MESSAGE_HISTORY_TAIL_FORMAT)) throw new Error("MESSAGE_HISTORY_INDEX_NOT_READY");
    const guards = JSON.parse(meta.get("snapshot")!) as Record<string, string>;
    const currentFile = messageContextCurrentPath(directory);
    const cursorText = db.prepare("SELECT cursor FROM cursors WHERE file=?").get(currentFile)?.cursor;
    const epoch = cursorText ? (JSON.parse(String(cursorText)) as MessageHistoryCursor).epoch : undefined;
    const target = options.target ?? (() => {
      const observedStamp = fingerprint(currentFile); const observedAt = Date.now();
      let observedCatalogStamp: string | undefined; let observedCatalogAt: number | undefined;
      const targetGuards = Object.fromEntries(Object.keys(guards).map(file => {
        if (file === currentFile) return [file, options.ownerTarget?.stamp ?? observedStamp];
        const stamp = fingerprint(file);
        if (file === messageContextArchiveIndexPath(directory)) {
          observedCatalogStamp = stamp; observedCatalogAt = Date.now();
          return [file, options.ownerTarget?.catalogStamp ?? stamp];
        }
        return [file, stamp];
      }));
      return { guards: targetGuards, currentEpoch: epoch, owner: options.ownerTarget,
        observedStamp, observedAt, observedCatalogStamp, observedCatalogAt };
    })();
    if (target.owner) {
      const proof = options.proof;
      const requested = proof?.commits.findIndex(commit => commit.stamp === target.owner!.stamp) ?? -1;
      let pending: string | undefined = "owner_proof_pending";
      if (proof && requested >= 0 && proof.layoutVersion === target.owner.layoutVersion) {
        pending = !messageHistoryObservationProven(proof, target.observedStamp!, target.observedAt!, requested) ? "owner_current_pending"
          : !messageHistoryCatalogObservationProven(proof, target.observedCatalogStamp ?? target.guards[messageContextArchiveIndexPath(directory)],
            target.observedCatalogAt ?? target.observedAt!, requested) ? "owner_catalog_pending" : undefined;
      }
      if (pending) {
        const stale = guards[currentFile] === target.observedStamp && currentGuards(guards);
        throw new MessageHistoryIndexLag(target, stale ? "owner_target_stale" : pending);
      }
    }
    const sourceRows = db.prepare("SELECT file,fingerprint FROM sources").all();
    if (meta.get("unpublished") === "1") throw new MessageHistoryIndexLag(target);
    const expectedSources = Object.keys(guards).filter(file => file === currentFile
      || (path.dirname(file) === messageContextArchiveDir(directory) && file.endsWith(".jsonl")));
    if (sourceRows.length !== expectedSources.length || sourceRows.some(row => guards[String(row.file)] !== row.fingerprint)) {
      // Archive checkpoints may commit before the global snapshot publishes.
      // Never combine their new rows with the previous snapshot's version tag.
      throw new MessageHistoryIndexLag(target);
    }
    const exact = Object.keys(guards).length === Object.keys(target.guards).length
      && Object.entries(guards).every(([file, stamp]) => target.guards[file] === stamp);
    let currentRecordLimit: number | undefined;
    if (!exact) {
      const proof = options.proof;
      const indexed = proof?.commits.findIndex(commit => commit.stamp === guards[currentFile]) ?? -1;
      const requested = proof?.commits.findIndex(commit => commit.stamp === target.guards[currentFile]) ?? -1;
      const ignored = new Set([currentFile, messageContextArchiveIndexPath(directory), messageContextArchiveDir(directory)]);
      const archiveKeys = Object.keys(guards).filter(file => !ignored.has(file));
      const sameArchives = archiveKeys.length === Object.keys(target.guards).filter(file => !ignored.has(file)).length
        && archiveKeys.every(file => guards[file] === target.guards[file]);
      if (!proof) throw new MessageHistoryIndexLag(target, "unproven_append");
      const diagnostic = !sameArchives ? "archive_changed" : proof.layoutVersion !== meta.get("layout") ? "layout_changed"
        : target.currentEpoch !== epoch ? "epoch_changed" : requested < 0 ? "unproven_target_version" : indexed < 0 ? "unproven_index_version"
        : indexed < requested ? "index_behind" : undefined;
      if (diagnostic) throw new MessageHistoryIndexLag(target, diagnostic);
      currentRecordLimit = proof.commits[requested].records;
    }
    if (options.target && options.visibilityDeadlineAt !== undefined && Date.now() >= options.visibilityDeadlineAt) throw new MessageHistoryIndexLag(target, "target_deadline");
    const snapshotMs = performance.now() - began;
    const terms = messageHistoryStorage.terms(query);
    const issues = db.prepare(`SELECT COALESCE(SUM(json_extract(c.cursor,'$.issues.malformed')),0) AS malformed,
      COALESCE(SUM(json_extract(c.cursor,'$.issues.oversized')),0) AS oversized,
      COALESCE(SUM(json_extract(c.cursor,'$.issues.unrecognized')),0) AS unrecognized,
      COALESCE(SUM(json_extract(c.cursor,'$.pendingBytes')),0) AS pending
      FROM cursors c JOIN sources s ON s.file=c.file WHERE ${sourceClause(query, "s", [])}`).get()!;
    const sourceRecordIssues = { malformed: Number(issues.malformed), oversized: Number(issues.oversized), unrecognized: Number(issues.unrecognized) };
    const sourceRecordsSkipped = sourceRecordIssues.malformed + sourceRecordIssues.oversized + sourceRecordIssues.unrecognized;
    const pendingRecordBytes = Number(issues.pending);
    const legacyCoverageUnknown = meta.get("legacyCoverageUnknown") === "1";
    const partial = sourceRecordsSkipped > 0 || pendingRecordBytes > 0 || legacyCoverageUnknown;
    const finish = (entries: MessageContextRecord[]): MessageHistorySearchResult => ({ entries,
      coverage: {
        indexVersion: createHash("sha256").update(`${reader.generation}:${SCHEMA_VERSION}:${ANALYZER_VERSION}:${meta.get("updatedAt")}:${meta.get("snapshot")}`).digest("hex"),
        sourceVersion: createHash("sha256").update(JSON.stringify({ layout: target.owner?.layoutVersion ?? meta.get("layout"),
          sources: Object.fromEntries(Object.entries(target.guards).filter(([file]) => file !== messageContextArchiveIndexPath(directory) && file !== messageContextArchiveDir(directory))) })).digest("hex"),
        indexedAt: meta.get("updatedAt")!, sourceSnapshotIndexed: !partial,
        indexCoverage: partial ? "partial" : "complete", sourceRecordsSkipped, sourceRecordIssues, pendingRecordBytes,
        maxIndexedRecordBytes: MESSAGE_HISTORY_INDEX_RECORD_BYTES, ...(legacyCoverageUnknown ? { legacyCoverageUnknown } : {})
      }, metrics: { strategy, candidates, elapsedMs: performance.now() - began, snapshotMs, projectionMs,
        candidateMs: Math.max(0, performance.now() - began - snapshotMs - projectionMs) } });
    const matchExpression = terms.map(term => { const size = Math.min(3, term.length); return `(g${size}: (${messageSearchGrams(term, size).split(" ").map(gram => `"${gram}"`).join(" AND ")}))`; }).join(query.queryMatch === "all" ? " AND " : " OR ");
    let orderedMembership = false;
    if (terms.length) {
      const corpus = Number(meta.get("records") || 0);
      const threshold = Math.floor(Math.max(512, Math.min(20_000, corpus * .05)));
      const frequency = db.prepare("SELECT count(*) AS n FROM (SELECT rowid FROM terms WHERE terms MATCH ? LIMIT ?)");
      // Count a bounded sample of the complete expression. Individual grams can
      // be common even when their intersection identifies just one document.
      const estimate = Number(frequency.get(matchExpression, threshold + 1)?.n || 0);
      if (!estimate) return finish([]);
      if (estimate > threshold) strategy = "ordered";
      else orderedMembership = estimate >= 512;
    } else strategy = "ordered";
    const args: (string | number)[] = [];
    const eligible = sourceClause(query, "s", args);
    const filters: string[] = [];
    if (currentRecordLimit !== undefined) { filters.push("(s.current=0 OR d.position<?)"); args.push(currentRecordLimit); }
    if (terms.length) {
      filters.push(strategy === "ordered"
        ? "EXISTS (SELECT 1 FROM terms WHERE terms MATCH ? AND terms.rowid=d.rowid)"
        : "d.rowid IN (SELECT rowid FROM terms WHERE terms MATCH ?)");
      args.push(matchExpression);
    }
    for (const field of ["adapter", "channel", "kind", "sender", "target", "conversationKey"] as const) {
      if (query[field]) { filters.push(`d.${field}=?`); args.push(query[field]!); }
    }
    if (Number.isFinite(query.from)) { filters.push("d.time>=?"); args.push(Number(query.from)); }
    if (Number.isFinite(query.to)) { filters.push("d.time<=?"); args.push(Number(query.to)); }
    if (query.afterSequence !== undefined) { filters.push("d.seq>?"); args.push(query.afterSequence); }
    if (query.beforeSequence !== undefined) { filters.push("d.seq<=?"); args.push(query.beforeSequence); }
    // Mid-sized postings use indexed write-order traversal with a membership set;
    // this avoids sorting every matching document before yielding the first K.
    const select = `SELECT d.rowid,d.recordKey,d.seq,d.time,d.id,s.ordinal AS sourceOrder,d.position,d.chars
      FROM documents d${(orderedMembership || strategy === "ordered") ? " INDEXED BY document_write_order" : ""} JOIN sources s ON s.file=d.source WHERE ${eligible} ${filters.length ? "AND " + filters.join(" AND ") : ""}`;
    const duplicateQueryArgs: (string | number)[] = [];
    const duplicateClause = sourceClause(query, "s", duplicateQueryArgs);
    if (currentRecordLimit !== undefined) duplicateQueryArgs.push(currentRecordLimit);
    const duplicates = db.prepare(`SELECT d.rowid,d.recordKey,d.seq,d.time,d.id,s.ordinal AS sourceOrder,d.position,d.chars
      FROM documents d JOIN sources s ON s.file=d.source WHERE d.recordKey=? AND ${duplicateClause}
      ${currentRecordLimit === undefined ? "" : "AND (s.current=0 OR d.position<?)"} ORDER BY s.ordinal,d.position,d.rowid LIMIT 1`);
    const payload = db.prepare("SELECT payload FROM documents WHERE rowid=?");
    const result: MessageContextRecord[] = [];
    let chars = 0;
    const maxChars = Math.max(1, Math.floor(query.maxChars ?? Number.MAX_SAFE_INTEGER));
    // Every record includes the shared storage overhead, even an empty body.
    // Stop when the remaining budget cannot fit another normalized record.
    const complete = () => result.length >= query.limit
      || (result.length > 0 && chars + MESSAGE_CONTEXT_RECORD_OVERHEAD_CHARS > maxChars);
    const collect = (row: SearchRow) => {
      const beganProjection = performance.now();
      try {
      if (result.length && chars + row.chars > maxChars) return;
      let record: MessageContextRecord;
      const serialized = payload.get(row.rowid)?.payload;
      try {
        record = JSON.parse(String(serialized)) as MessageContextRecord;
        if (!record || typeof record.text !== "string" || record.id !== row.id || record.time !== row.time
          || (record.sequence ?? 0) !== row.seq || messageHistoryStorage.recordKey(record) !== row.recordKey
          || messageHistoryStorage.charCost(record) !== row.chars) throw new Error();
      } catch {
        // Never propagate parser excerpts containing private message text.
        throw new Error("MESSAGE_HISTORY_INDEX_INTEGRITY: invalid_projection");
      }
      if (!messageHistoryStorage.matches(record, query, terms)) return;
      result.push(record); chars += row.chars;
      } finally { projectionMs += performance.now() - beganProjection; }
    };
    // The source catalog and physical record positions define one stable write
    // order, including legacy rows without a sequence. Duplicate identity belongs
    // to the first write in the eligible source scope, before query filtering.
    // SQLite streams the index (or spills selective posting sorts to disk); JS
    // retains only the requested result window, never a corpus-sized map or array.
    const iterator = db.prepare(select + " ORDER BY d.sourceOrder DESC,d.position DESC,d.rowid DESC").iterate(...args) as Iterable<SearchRow>;
    for (const row of iterator) {
      candidates++;
      const winner = duplicates.get(row.recordKey, ...duplicateQueryArgs);
      if (winner?.rowid !== row.rowid) continue;
      collect(row);
      if (complete()) break;
    }
    return finish(result.reverse());
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("MESSAGE_HISTORY_INDEX_INTEGRITY"))) {
      // Keep the damaged generation as evidence. The ordinary NOT_READY path
      // wakes the single background owner to rebuild from authoritative files.
      quarantineMessageIndexProjection(indexPath, reader.generation);
      throw new Error("MESSAGE_HISTORY_INDEX_NOT_READY: invalid_projection");
    }
    throw error;
  } finally {
    try { db.exec("ROLLBACK"); } catch { /* BEGIN may itself have failed. */ }
    reader.finish();
  }
}

/** Typed IPC response preserves the first target while a bounded service barrier waits for indexing. */
export function probeMessageHistoryIndex(directory: string, query: RecentMessageContextQuery, indexPath = messageHistoryIndexPath(directory),
  options: { target?: MessageHistorySearchTarget; proof?: MessageHistoryAppendProof; visibilityDeadlineAt?: number; ownerTarget?: MessageHistoryOwnerTarget } = {}): MessageHistorySearchProbe {
  const began = performance.now();
  try { return { ready: true, result: searchMessageHistoryIndexResult(directory, query, indexPath, options) }; }
  catch (error) {
    if (error instanceof MessageHistoryIndexLag) return { ready: false, reason: error.message, target: error.target, diagnostic: error.diagnostic, elapsedMs: performance.now() - began };
    if (error instanceof Error && error.message.startsWith("MESSAGE_HISTORY_INDEX_NOT_READY")) return { ready: false, reason: "MESSAGE_HISTORY_INDEX_NOT_READY", target: options.target, elapsedMs: performance.now() - began };
    throw error;
  }
}
