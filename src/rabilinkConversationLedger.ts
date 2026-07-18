import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const RABILINK_CONVERSATION_LEDGER_FILE = "rabilink-conversation.jsonl";
export const RABILINK_CONVERSATION_ARCHIVE_DIR = "rabilink-conversations";
export const RABILINK_CONVERSATION_INDEX_FILE = "index.json";
export const DEFAULT_RABILINK_CONVERSATION_SPLIT_AFTER_MS = 6 * 60 * 60 * 1000;
const RABILINK_CONVERSATION_LOCK_FILE = ".rabilink-conversation.lock";
const RABILINK_CONVERSATION_LOCK_TIMEOUT_MS = 5000;
const RABILINK_CONVERSATION_LOCK_STALE_MS = 30000;

export type RabiLinkConversationDirection = "user_to_agent" | "agent_to_user" | "control";
export type RabiLinkConversationKind = "voice_transcript" | "agent_message" | "review_request";

export type RabiLinkConversationAttachment = {
  id?: string;
  kind?: "image" | "video" | "audio" | "file";
  fileName?: string;
  contentType?: string;
  size?: number;
  localPath?: string;
};

export type RabiLinkConversationEntry = {
  schemaVersion: 1;
  entryId: string;
  recordedAt: string;
  time: number;
  direction: RabiLinkConversationDirection;
  kind: RabiLinkConversationKind;
  channel: "rabilink";
  text: string;
  source?: string;
  sender?: string;
  messageId?: string;
  taskId?: string;
  deliveryId?: string;
  sessionId?: string;
  sourceDeviceId?: string;
  sourceDeviceName?: string;
  sourceDeviceKind?: string;
  transport?: string;
  targetDeviceIds?: string[];
  targetDeviceKinds?: string[];
  presentation?: string[];
  priority?: "quiet" | "normal" | "urgent";
  sequence?: number;
  capturedAt?: number;
  proactive?: boolean;
  final?: boolean;
  requiresReview?: boolean;
  reviewRequested?: boolean;
  attachments?: RabiLinkConversationAttachment[];
};

export type AppendRabiLinkConversationResult = {
  entry: RabiLinkConversationEntry;
  appended: boolean;
  archivedPath?: string;
};

export type RabiLinkConversationArchiveItem = {
  file: string;
  startedAt: string;
  endedAt: string;
  entryCount: number;
};

export type RabiLinkConversationArchiveIndex = {
  schemaVersion: 1;
  sessions: RabiLinkConversationArchiveItem[];
};

export type AppendRabiLinkConversationOptions = {
  splitAfterMs?: number;
  now?: number;
};

type LedgerIdCache = {
  size: number;
  ids: Set<string>;
};

const ledgerIdCaches = new Map<string, LedgerIdCache>();
const archiveEntryCaches = new Map<string, { signature: string; entries: Map<string, RabiLinkConversationEntry> }>();
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function optionalText(value: unknown): string | undefined {
  const text = value == null ? "" : String(value).trim();
  return text || undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalTextList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = [...new Set(value.map(optionalText).filter((item): item is string => Boolean(item)))];
  return result.length > 0 ? result : undefined;
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function waitForConversationLock(delayMs: number): void {
  Atomics.wait(lockWaitBuffer, 0, 0, Math.max(1, delayMs));
}

function acquireConversationLock(dataDir: string): () => void {
  const lockPath = path.join(path.resolve(dataDir), RABILINK_CONVERSATION_LOCK_FILE);
  const deadline = Date.now() + RABILINK_CONVERSATION_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.unlinkSync(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (ageMs >= RABILINK_CONVERSATION_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for RabiLink conversation lock: ${lockPath}`);
      }
      waitForConversationLock(10);
    }
  }
}

function parseLedger(text: string): RabiLinkConversationEntry[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const entry = value as RabiLinkConversationEntry;
        return typeof entry.entryId === "string" && typeof entry.text === "string" ? [entry] : [];
      } catch {
        return [];
      }
    });
}

function knownEntryIds(filePath: string): LedgerIdCache {
  const size = fileSize(filePath);
  const cached = ledgerIdCaches.get(filePath);
  if (cached && cached.size === size) return cached;
  const entries = fs.existsSync(filePath) ? parseLedger(fs.readFileSync(filePath, "utf8")) : [];
  const next = {
    size,
    ids: new Set(entries.map((entry) => entry.entryId))
  };
  ledgerIdCaches.set(filePath, next);
  return next;
}

export function rabiLinkConversationLedgerPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), RABILINK_CONVERSATION_LEDGER_FILE);
}

export function rabiLinkConversationArchiveDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), RABILINK_CONVERSATION_ARCHIVE_DIR);
}

export function rabiLinkConversationArchiveIndexPath(dataDir: string): string {
  return path.join(rabiLinkConversationArchiveDir(dataDir), RABILINK_CONVERSATION_INDEX_FILE);
}

function localDateName(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown-date";
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function archiveFilePath(dataDir: string, startedAt: string): string {
  const archiveDir = rabiLinkConversationArchiveDir(dataDir);
  fs.mkdirSync(archiveDir, { recursive: true });
  const baseName = localDateName(startedAt);
  for (let index = 1; index < 10000; index += 1) {
    const suffix = index === 1 ? "" : `-${String(index).padStart(2, "0")}`;
    const candidate = path.join(archiveDir, `${baseName}${suffix}.jsonl`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(archiveDir, `${baseName}-${Date.now()}.jsonl`);
}

function archiveItemFromFile(filePath: string): RabiLinkConversationArchiveItem | undefined {
  const entries = parseLedger(fs.readFileSync(filePath, "utf8"));
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (!first || !last) return undefined;
  return {
    file: path.basename(filePath),
    startedAt: first.recordedAt,
    endedAt: last.recordedAt,
    entryCount: entries.length
  };
}

function discoveredArchiveItems(dataDir: string): RabiLinkConversationArchiveItem[] {
  const archiveDir = rabiLinkConversationArchiveDir(dataDir);
  if (!fs.existsSync(archiveDir)) return [];
  return fs.readdirSync(archiveDir, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.toLowerCase().endsWith(".jsonl"))
    .flatMap((item) => {
      try {
        const archive = archiveItemFromFile(path.join(archiveDir, item.name));
        return archive ? [archive] : [];
      } catch {
        return [];
      }
    });
}

function archiveStateSignature(dataDir: string): string {
  const archiveDir = rabiLinkConversationArchiveDir(dataDir);
  if (!fs.existsSync(archiveDir)) return "";
  return fs.readdirSync(archiveDir, { withFileTypes: true })
    .filter((item) => item.isFile() && (item.name === RABILINK_CONVERSATION_INDEX_FILE || item.name.toLowerCase().endsWith(".jsonl")))
    .map((item) => {
      try {
        const stat = fs.statSync(path.join(archiveDir, item.name));
        return `${item.name}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${item.name}:missing`;
      }
    })
    .sort()
    .join("|");
}

function sortArchiveItems(items: RabiLinkConversationArchiveItem[]): RabiLinkConversationArchiveItem[] {
  return [...items].sort((left, right) => {
    const timeDelta = Date.parse(left.startedAt) - Date.parse(right.startedAt);
    return Number.isFinite(timeDelta) && timeDelta !== 0 ? timeDelta : left.file.localeCompare(right.file);
  });
}

export function readRabiLinkConversationArchiveIndex(dataDir: string): RabiLinkConversationArchiveIndex {
  let indexed: RabiLinkConversationArchiveItem[] = [];
  try {
    const value = JSON.parse(fs.readFileSync(rabiLinkConversationArchiveIndexPath(dataDir), "utf8")) as Partial<RabiLinkConversationArchiveIndex>;
    indexed = Array.isArray(value.sessions)
      ? value.sessions.filter((item): item is RabiLinkConversationArchiveItem => Boolean(
        item
        && typeof item.file === "string"
        && typeof item.startedAt === "string"
        && typeof item.endedAt === "string"
        && Number.isFinite(item.entryCount)
      ))
      : [];
  } catch {
    indexed = [];
  }
  const byFile = new Map(indexed.map((item) => [path.basename(item.file), { ...item, file: path.basename(item.file) }]));
  for (const item of discoveredArchiveItems(dataDir)) {
    if (!byFile.has(item.file)) byFile.set(item.file, item);
  }
  return { schemaVersion: 1, sessions: sortArchiveItems([...byFile.values()]) };
}

function archivedEntriesById(dataDir: string): Map<string, RabiLinkConversationEntry> {
  const cacheKey = path.resolve(dataDir);
  const signature = archiveStateSignature(dataDir);
  const cached = archiveEntryCaches.get(cacheKey);
  if (cached && cached.signature === signature) return cached.entries;
  const entries = new Map<string, RabiLinkConversationEntry>();
  const archiveDir = rabiLinkConversationArchiveDir(dataDir);
  for (const session of readRabiLinkConversationArchiveIndex(dataDir).sessions) {
    const filePath = path.join(archiveDir, path.basename(session.file));
    if (!fs.existsSync(filePath)) continue;
    for (const entry of parseLedger(fs.readFileSync(filePath, "utf8"))) entries.set(entry.entryId, entry);
  }
  archiveEntryCaches.set(cacheKey, { signature, entries });
  return entries;
}

function writeArchiveIndex(dataDir: string, index: RabiLinkConversationArchiveIndex): void {
  const indexPath = rabiLinkConversationArchiveIndexPath(dataDir);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const temporaryPath = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, indexPath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function recordArchive(dataDir: string, archivedPath: string, entries: RabiLinkConversationEntry[]): void {
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (!first || !last) return;
  const index = readRabiLinkConversationArchiveIndex(dataDir);
  const file = path.basename(archivedPath);
  if (!index.sessions.some((item) => path.basename(item.file) === file)) {
    index.sessions.push({
      file,
      startedAt: first.recordedAt,
      endedAt: last.recordedAt,
      entryCount: entries.length
    });
  }
  index.sessions = sortArchiveItems(index.sessions);
  writeArchiveIndex(dataDir, index);
  archiveEntryCaches.delete(path.resolve(dataDir));
}

function rotateConversationIfNeeded(dataDir: string, recordedAt: string, splitAfterMs: number): string | undefined {
  const filePath = rabiLinkConversationLedgerPath(dataDir);
  if (!fs.existsSync(filePath)) return undefined;
  const entries = readRabiLinkConversationEntries(dataDir);
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (!first || !last) return undefined;
  const nextAt = Date.parse(recordedAt);
  const lastAt = Date.parse(last.recordedAt);
  const crossedLocalDate = localDateName(first.recordedAt) !== localDateName(recordedAt);
  const exceededIdleGap = Number.isFinite(nextAt)
    && Number.isFinite(lastAt)
    && Math.max(0, nextAt - lastAt) >= splitAfterMs;
  if (!crossedLocalDate && !exceededIdleGap) return undefined;

  const archivedPath = archiveFilePath(dataDir, first.recordedAt);
  try {
    fs.renameSync(filePath, archivedPath);
  } catch (error) {
    if (!fs.existsSync(filePath)) return undefined;
    throw error;
  }
  ledgerIdCaches.delete(filePath);
  recordArchive(dataDir, archivedPath, entries);
  return archivedPath;
}

export function readRabiLinkConversationEntries(dataDir: string): RabiLinkConversationEntry[] {
  const filePath = rabiLinkConversationLedgerPath(dataDir);
  if (!fs.existsSync(filePath)) return [];
  return parseLedger(fs.readFileSync(filePath, "utf8"));
}

export function readRabiLinkConversationTimeline(dataDir: string): RabiLinkConversationEntry[] {
  const entries: RabiLinkConversationEntry[] = [];
  const seen = new Set<string>();
  for (const entry of archivedEntriesById(dataDir).values()) {
    if (seen.has(entry.entryId)) continue;
    seen.add(entry.entryId);
    entries.push(entry);
  }
  for (const entry of readRabiLinkConversationEntries(dataDir)) {
    if (seen.has(entry.entryId)) continue;
    seen.add(entry.entryId);
    entries.push(entry);
  }
  return entries;
}

export function appendRabiLinkConversationEntry(
  dataDir: string,
  input: Omit<Partial<RabiLinkConversationEntry>, "schemaVersion" | "channel"> & Pick<RabiLinkConversationEntry, "direction" | "kind" | "text">,
  options: AppendRabiLinkConversationOptions = {}
): AppendRabiLinkConversationResult {
  const text = String(input.text || "").trim();
  if (!text) throw new Error("RabiLink conversation entry text is empty.");

  const dir = path.resolve(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const releaseLock = acquireConversationLock(dir);
  try {
    const filePath = rabiLinkConversationLedgerPath(dir);
    const entryId = optionalText(input.entryId) || `rabilink-ledger-${randomUUID()}`;
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const recordedAt = optionalText(input.recordedAt) || new Date(now).toISOString();
    const splitAfterMs = Math.max(60 * 1000, Number(options.splitAfterMs) || DEFAULT_RABILINK_CONVERSATION_SPLIT_AFTER_MS);
    let cache = knownEntryIds(filePath);
    if (cache.ids.has(entryId)) {
      const existing = readRabiLinkConversationEntries(dir).find((entry) => entry.entryId === entryId);
      if (existing) return { entry: existing, appended: false };
    }
    const archivedExisting = archivedEntriesById(dir).get(entryId);
    if (archivedExisting) return { entry: archivedExisting, appended: false };
    const archivedPath = rotateConversationIfNeeded(dir, recordedAt, splitAfterMs);
    cache = knownEntryIds(filePath);

    const parsedRecordedAt = Date.parse(recordedAt);
    const entry: RabiLinkConversationEntry = {
      schemaVersion: 1,
      entryId,
      recordedAt,
      time: optionalNumber(input.time) ?? (Number.isFinite(parsedRecordedAt) ? Math.floor(parsedRecordedAt / 1000) : Math.floor(Date.now() / 1000)),
      direction: input.direction,
      kind: input.kind,
      channel: "rabilink",
      text,
      source: optionalText(input.source),
      sender: optionalText(input.sender),
      messageId: optionalText(input.messageId),
      taskId: optionalText(input.taskId),
      deliveryId: optionalText(input.deliveryId),
      sessionId: optionalText(input.sessionId),
      sourceDeviceId: optionalText(input.sourceDeviceId),
      sourceDeviceName: optionalText(input.sourceDeviceName),
      sourceDeviceKind: optionalText(input.sourceDeviceKind),
      transport: optionalText(input.transport),
      targetDeviceIds: optionalTextList(input.targetDeviceIds),
      targetDeviceKinds: optionalTextList(input.targetDeviceKinds),
      presentation: optionalTextList(input.presentation),
      priority: input.priority === "quiet" || input.priority === "normal" || input.priority === "urgent"
        ? input.priority
        : undefined,
      sequence: optionalNumber(input.sequence),
      capturedAt: optionalNumber(input.capturedAt),
      proactive: typeof input.proactive === "boolean" ? input.proactive : undefined,
      final: typeof input.final === "boolean" ? input.final : undefined,
      requiresReview: typeof input.requiresReview === "boolean" ? input.requiresReview : undefined,
      reviewRequested: typeof input.reviewRequested === "boolean" ? input.reviewRequested : undefined,
      attachments: Array.isArray(input.attachments) ? input.attachments.slice(0, 8) as RabiLinkConversationAttachment[] : undefined
    };
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFileSync(filePath, line, "utf8");
    cache.ids.add(entryId);
    cache.size += Buffer.byteLength(line);
    return { entry, appended: true, archivedPath };
  } finally {
    releaseLock();
  }
}
