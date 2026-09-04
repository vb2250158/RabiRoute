import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { roleFolderPath } from "../shared/routePaths.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

export const BILIBILI_HISTORY_RUNTIME_DIR = "bilibili-history";
export const BILIBILI_HISTORY_DAILY_DIR = "daily";
export const BILIBILI_HISTORY_INDEX_FILE = "index.json";

export type BilibiliHistoryApiItem = {
  [key: string]: unknown;
  title?: unknown;
  long_title?: unknown;
  show_title?: unknown;
  cover?: unknown;
  covers?: unknown;
  uri?: unknown;
  author_name?: unknown;
  author_face?: unknown;
  author_mid?: unknown;
  view_at?: unknown;
  progress?: unknown;
  duration?: unknown;
  badge?: unknown;
  tag_name?: unknown;
  videos?: unknown;
  current?: unknown;
  total?: unknown;
  new_desc?: unknown;
  is_finish?: unknown;
  is_fav?: unknown;
  kid?: unknown;
  live_status?: unknown;
  history?: unknown;
};

export type BilibiliHistoryDailyRecord = {
  schemaVersion: 1;
  recordId: string;
  localDate: string;
  timezoneOffsetMinutes: number;
  firstCapturedAt: string;
  lastCapturedAt: string;
  sourceJobIds: string[];
  title?: string;
  longTitle?: string;
  showTitle?: string;
  cover?: string;
  covers?: string[];
  uri?: string;
  authorName?: string;
  authorFace?: string;
  authorMid?: number | string;
  viewedAt: number;
  progress?: number;
  duration?: number;
  badge?: string;
  tagName?: string;
  videos?: number;
  current?: string;
  total?: number;
  newDescription?: string;
  isFinished?: boolean;
  isFavorite?: boolean;
  kid?: number | string;
  liveStatus?: number;
  history?: {
    business?: string;
    oid?: number | string;
    kid?: number | string;
    bvid?: string;
    cid?: number | string;
    epid?: number | string;
    page?: number;
    part?: string;
    dt?: number;
  };
};

export type BilibiliHistoryDayIndexEntry = {
  date: string;
  file: string;
  recordCount: number;
  firstViewedAt: number;
  lastViewedAt: number;
};

export type BilibiliHistoryDailyIndex = {
  schemaVersion: 1;
  recordClass: "private-bilibili-history-date-shards";
  action: "date-partition";
  updatedAt: string;
  totalRecordCount: number;
  days: BilibiliHistoryDayIndexEntry[];
};

export type PersistBilibiliHistoryItemsResult = {
  acceptedRecordCount: number;
  insertedRecordCount: number;
  updatedRecordCount: number;
  acceptedRecords: Array<{ recordId: string; localDate: string }>;
  days: BilibiliHistoryDayIndexEntry[];
};

function optionalText(value: unknown): string | undefined {
  const text = value == null ? "" : String(value).trim();
  return text || undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function optionalId(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return optionalText(value);
}

function optionalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.map(optionalText).filter((item): item is string => Boolean(item));
  return strings.length > 0 ? strings : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === "0") return false;
  if (value === 1 || value === "1") return true;
  return undefined;
}

function historyObject(value: unknown): BilibiliHistoryDailyRecord["history"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const history = value as Record<string, unknown>;
  const sanitized: NonNullable<BilibiliHistoryDailyRecord["history"]> = {
    business: optionalText(history.business),
    oid: optionalId(history.oid),
    kid: optionalId(history.kid),
    bvid: optionalText(history.bvid),
    cid: optionalId(history.cid),
    epid: optionalId(history.epid),
    page: optionalInteger(history.page),
    part: optionalText(history.part),
    dt: optionalInteger(history.dt)
  };
  return Object.values(sanitized).some(value => value !== undefined) ? sanitized : undefined;
}

function localDate(viewedAt: number, timezoneOffsetMinutes: number): string {
  const localEpoch = viewedAt - timezoneOffsetMinutes * 60;
  return new Date(localEpoch * 1000).toISOString().slice(0, 10);
}

function contentIdentity(item: BilibiliHistoryApiItem, history: BilibiliHistoryDailyRecord["history"]): string {
  return optionalText(history?.bvid)
    || optionalText(history?.epid)
    || optionalText(history?.oid)
    || optionalText(history?.kid)
    || optionalText(item.uri)
    || `${optionalText(item.author_mid) ?? ""}:${optionalText(item.title) ?? ""}`;
}

function recordId(item: BilibiliHistoryApiItem, viewedAt: number, history: BilibiliHistoryDailyRecord["history"]): string {
  const business = optionalText(history?.business) ?? "unknown";
  const identity = contentIdentity(item, history);
  return `bilibili-history-${createHash("sha256").update(`${business}\0${identity}\0${viewedAt}`).digest("hex")}`;
}

function sanitizeRecord(
  item: BilibiliHistoryApiItem,
  context: { jobId: string; capturedAt: string; timezoneOffsetMinutes: number }
): BilibiliHistoryDailyRecord | undefined {
  const viewedAt = optionalInteger(item.view_at);
  if (!viewedAt || viewedAt <= 0) return undefined;
  const history = historyObject(item.history);
  return {
    schemaVersion: 1,
    recordId: recordId(item, viewedAt, history),
    localDate: localDate(viewedAt, context.timezoneOffsetMinutes),
    timezoneOffsetMinutes: context.timezoneOffsetMinutes,
    firstCapturedAt: context.capturedAt,
    lastCapturedAt: context.capturedAt,
    sourceJobIds: [context.jobId],
    title: optionalText(item.title),
    longTitle: optionalText(item.long_title),
    showTitle: optionalText(item.show_title),
    cover: optionalText(item.cover),
    covers: optionalStringList(item.covers),
    uri: optionalText(item.uri),
    authorName: optionalText(item.author_name),
    authorFace: optionalText(item.author_face),
    authorMid: optionalId(item.author_mid),
    viewedAt,
    progress: optionalNumber(item.progress),
    duration: optionalNumber(item.duration),
    badge: optionalText(item.badge),
    tagName: optionalText(item.tag_name),
    videos: optionalInteger(item.videos),
    current: optionalText(item.current),
    total: optionalInteger(item.total),
    newDescription: optionalText(item.new_desc),
    isFinished: optionalBoolean(item.is_finish),
    isFavorite: optionalBoolean(item.is_fav),
    kid: optionalId(item.kid),
    liveStatus: optionalInteger(item.live_status),
    history
  };
}

function parseDailyRecords(filePath: string): BilibiliHistoryDailyRecord[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Invalid Bilibili history JSONL at ${path.basename(filePath)}:${index + 1}`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid Bilibili history record at ${path.basename(filePath)}:${index + 1}`);
      }
      const record = parsed as BilibiliHistoryDailyRecord;
      if (record.schemaVersion !== 1 || !record.recordId || !record.localDate || !Number.isSafeInteger(record.viewedAt)) {
        throw new Error(`Invalid Bilibili history schema at ${path.basename(filePath)}:${index + 1}`);
      }
      return record;
    });
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    recordDataMutationAudit({
      group: "bilibili-history",
      event: "bilibili_history_file_written",
      owner: "bilibili-history-records",
      action: "replace",
      target: { type: "history-file", id: path.basename(filePath) },
      dataSource: { kind: "file", id: `bilibili-history/${path.basename(filePath)}` },
      outcome: "committed",
      after: { digest: createHash("sha256").update(content).digest("hex") }
    });
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: "bilibili-history",
      event: "bilibili_history_file_write_failed",
      owner: "bilibili-history-records",
      action: "replace",
      target: { type: "history-file", id: path.basename(filePath) },
      dataSource: { kind: "file", id: `bilibili-history/${path.basename(filePath)}` },
      outcome: "failed",
      error
    });
    throw error;
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function sortRecords(records: BilibiliHistoryDailyRecord[]): BilibiliHistoryDailyRecord[] {
  return [...records].sort((left, right) => right.viewedAt - left.viewedAt || left.recordId.localeCompare(right.recordId));
}

function mergeRecord(existing: BilibiliHistoryDailyRecord, incoming: BilibiliHistoryDailyRecord): BilibiliHistoryDailyRecord {
  return {
    ...incoming,
    firstCapturedAt: existing.firstCapturedAt || incoming.firstCapturedAt,
    sourceJobIds: [...new Set([...(existing.sourceJobIds ?? []), ...incoming.sourceJobIds])]
  };
}

export class BilibiliHistoryRecordStore {
  constructor(private readonly rolesRoot: string | (() => string)) {}

  private currentRolesRoot(): string {
    return typeof this.rolesRoot === "function" ? this.rolesRoot() : this.rolesRoot;
  }

  private roleRuntimeDir(roleId: string): string {
    const roleDir = roleFolderPath(this.currentRolesRoot(), roleId);
    if (!fs.existsSync(roleDir) || !fs.statSync(roleDir).isDirectory()) {
      throw new Error("BILIBILI_HISTORY_ROLE_NOT_FOUND");
    }
    return path.join(roleDir, "runtime", BILIBILI_HISTORY_RUNTIME_DIR);
  }

  dailyDir(roleId: string): string {
    return path.join(this.roleRuntimeDir(roleId), BILIBILI_HISTORY_DAILY_DIR);
  }

  dailyFilePath(roleId: string, date: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("INVALID_BILIBILI_HISTORY_DATE");
    return path.join(this.dailyDir(roleId), `${date}.jsonl`);
  }

  indexPath(roleId: string): string {
    return path.join(this.roleRuntimeDir(roleId), BILIBILI_HISTORY_INDEX_FILE);
  }

  readDay(roleId: string, date: string): BilibiliHistoryDailyRecord[] {
    return parseDailyRecords(this.dailyFilePath(roleId, date));
  }

  readIndex(roleId: string): BilibiliHistoryDailyIndex {
    return this.buildIndex(roleId);
  }

  private buildIndex(roleId: string, updatedAt = new Date().toISOString()): BilibiliHistoryDailyIndex {
    const dailyDir = this.dailyDir(roleId);
    const days = fs.existsSync(dailyDir)
      ? fs.readdirSync(dailyDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
        .map(entry => {
          const records = parseDailyRecords(path.join(dailyDir, entry.name));
          const viewedAt = records.map(record => record.viewedAt);
          return {
            date: entry.name.slice(0, 10),
            file: `${BILIBILI_HISTORY_DAILY_DIR}/${entry.name}`,
            recordCount: records.length,
            firstViewedAt: viewedAt.length > 0 ? Math.min(...viewedAt) : 0,
            lastViewedAt: viewedAt.length > 0 ? Math.max(...viewedAt) : 0
          } satisfies BilibiliHistoryDayIndexEntry;
        })
        .sort((left, right) => left.date.localeCompare(right.date))
      : [];
    const index: BilibiliHistoryDailyIndex = {
      schemaVersion: 1,
      recordClass: "private-bilibili-history-date-shards",
      action: "date-partition",
      updatedAt,
      totalRecordCount: days.reduce((total, day) => total + day.recordCount, 0),
      days
    };
    return index;
  }

  rebuildIndex(roleId: string, updatedAt = new Date().toISOString()): BilibiliHistoryDailyIndex {
    const index = this.buildIndex(roleId, updatedAt);
    atomicWrite(this.indexPath(roleId), `${JSON.stringify(index, null, 2)}\n`);
    return index;
  }

  recordDatesForJob(roleId: string, jobId: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const day of this.buildIndex(roleId).days) {
      for (const record of this.readDay(roleId, day.date)) {
        if (record.sourceJobIds.includes(jobId)) result[record.recordId] = record.localDate;
      }
    }
    return result;
  }

  persist(
    roleId: string,
    items: BilibiliHistoryApiItem[],
    context: { jobId: string; capturedAt?: string; timezoneOffsetMinutes: number }
  ): PersistBilibiliHistoryItemsResult {
    const capturedAt = context.capturedAt || new Date().toISOString();
    const records = items.flatMap(item => {
      const record = sanitizeRecord(item, { ...context, capturedAt });
      return record ? [record] : [];
    });
    const byDate = new Map<string, BilibiliHistoryDailyRecord[]>();
    for (const record of records) {
      const bucket = byDate.get(record.localDate) ?? [];
      bucket.push(record);
      byDate.set(record.localDate, bucket);
    }

    let insertedRecordCount = 0;
    let updatedRecordCount = 0;
    for (const [date, incoming] of byDate) {
      const filePath = this.dailyFilePath(roleId, date);
      const existing = new Map(this.readDay(roleId, date).map(record => [record.recordId, record]));
      for (const record of incoming) {
        const previous = existing.get(record.recordId);
        if (previous) {
          existing.set(record.recordId, mergeRecord(previous, record));
          updatedRecordCount += 1;
        } else {
          existing.set(record.recordId, record);
          insertedRecordCount += 1;
        }
      }
      const content = sortRecords([...existing.values()]).map(record => JSON.stringify(record)).join("\n");
      atomicWrite(filePath, content ? `${content}\n` : "");
    }

    const index = this.rebuildIndex(roleId, capturedAt);
    return {
      acceptedRecordCount: records.length,
      insertedRecordCount,
      updatedRecordCount,
      acceptedRecords: records.map(record => ({ recordId: record.recordId, localDate: record.localDate })),
      days: index.days.filter(day => byDate.has(day.date))
    };
  }
}
