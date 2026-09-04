import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import {
  BilibiliHistoryRecordStore,
  type BilibiliHistoryApiItem
} from "./bilibiliHistoryRecordStore.js";

const API_ENDPOINT = "https://api.bilibili.com/x/web-interface/history/cursor";
const MAX_PAGE_ITEMS = 30;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_PAGE_DELAY_MS = 650;
const MAX_JOB_PAGES = 20_000;

type Cursor = {
  max: number | string;
  view_at: number;
  business: string;
};

export type BilibiliHistorySummary = {
  itemCount: number;
  consumedSeconds: number;
  completedCount: number;
  activeDays: Record<string, number>;
  businessCounts: Record<string, number>;
  tagCounts: Record<string, number>;
  authorCounts: Record<string, number>;
  themeCounts: Record<string, number>;
};

type HistoryJobStatus = "queued" | "running" | "completed" | "failed" | "paused";

export type BilibiliHistoryJob = {
  id: string;
  roleId?: string;
  createdAt: string;
  updatedAt: string;
  sinceEpoch: number;
  untilEpoch: number;
  timezoneOffsetMinutes: number;
  status: HistoryJobStatus;
  cursor: Cursor;
  pagesProcessed: number;
  pageDelayMs: number;
  lastPageKey: string;
  lastError: string;
  summary: BilibiliHistorySummary;
  persistence?: {
    recordCount: number;
    activeDays: Record<string, number>;
    lastPersistedAt: string;
    recordDates?: Record<string, string>;
  };
};

type PersistedState = {
  version: 1;
  bridge?: {
    extensionId: string;
    token: string;
    pairedAt: string;
    lastSeenAt: string;
  };
  jobs: BilibiliHistoryJob[];
};

type PageSubmission = {
  jobId?: string;
  pageKey?: string;
  code?: number;
  message?: string;
  items?: BilibiliHistoryApiItem[];
  nextCursor?: Partial<Cursor>;
};

function emptySummary(): BilibiliHistorySummary {
  return {
    itemCount: 0,
    consumedSeconds: 0,
    completedCount: 0,
    activeDays: {},
    businessCounts: {},
    tagCounts: {},
    authorCounts: {},
    themeCounts: {}
  };
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function readJson<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function epoch(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 0;
}

function safeCursor(value: Partial<Cursor> | undefined): Cursor {
  return {
    max: typeof value?.max === "string" || typeof value?.max === "number" ? value.max : 0,
    view_at: Number.isSafeInteger(value?.view_at) ? Number(value?.view_at) : 0,
    business: typeof value?.business === "string" ? value.business.slice(0, 32) : ""
  };
}

function increment(target: Record<string, number>, key: string, amount = 1): void {
  const normalized = key.trim().slice(0, 80) || "unknown";
  target[normalized] = (target[normalized] ?? 0) + amount;
}

function accumulate(summary: BilibiliHistorySummary, item: BilibiliHistoryApiItem, timezoneOffsetMinutes: number): void {
  const duration = Math.max(0, Number(item.duration) || 0);
  const progress = Number(item.progress);
  const consumed = progress === -1
    ? duration
    : Math.min(duration, Math.max(0, Number.isFinite(progress) ? progress : 0));
  summary.itemCount += 1;
  summary.consumedSeconds += consumed;
  if (duration > 0 && (progress === -1 || consumed / duration >= 0.9)) summary.completedCount += 1;
  const viewedAt = Number(item.view_at);
  if (Number.isSafeInteger(viewedAt) && viewedAt > 0) {
    const localEpoch = viewedAt - timezoneOffsetMinutes * 60;
    increment(summary.activeDays, new Date(localEpoch * 1000).toISOString().slice(0, 10));
  }
  const history = item.history && typeof item.history === "object" && !Array.isArray(item.history)
    ? item.history as Record<string, unknown>
    : {};
  increment(summary.businessCounts, String(history.business ?? "unknown"));
  increment(summary.tagCounts, String(item.tag_name ?? "unknown"));
  if (item.author_name) increment(summary.authorCounts, String(item.author_name));
  const text = `${item.title ?? ""} ${item.tag_name ?? ""}`;
  const themes: Array<[string, RegExp]> = [
    ["二次元与游戏", /游戏|手游|主机|二游|绝区零|鸣潮|星穹铁道|崩坏|原神|妮姬|异环|终末地|卡厄思|动森/i],
    ["AI与软件技术", /人工智能|AI|Agent|GPT|Claude|Gemini|编程|代码|软件|模型|大模型/i],
    ["数码与硬件", /数码|电脑|手机|显卡|屏幕|显示器|硬件|家电|耳机|相机/i],
    ["影视与动漫", /电影|影视|动漫|番剧|预告|漫威|复仇者|电视剧/i],
    ["商业与社会", /商业|经济|公司|职场|老板|运营|社会|财经/i],
    ["生活与见闻", /生活|旅行|美食|装修|日常|科普|宠物/i]
  ];
  for (const [theme, pattern] of themes) {
    if (pattern.test(text)) increment(summary.themeCounts, theme);
  }
}

function publicJob(job: BilibiliHistoryJob): Record<string, unknown> {
  const { lastPageKey: _privateIdempotencyKey, ...result } = job;
  if (!result.persistence) return result;
  const { recordDates: _privateRecordDates, ...persistence } = result.persistence;
  return { ...result, persistence };
}

function isLoopback(request: http.IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export class BilibiliHistoryBridge {
  private state: PersistedState;
  private readonly recordStore: BilibiliHistoryRecordStore;

  constructor(
    private readonly statePath: string,
    rolesRoot: string | (() => string),
    options: { readOnly?: boolean } = {}
  ) {
    this.recordStore = new BilibiliHistoryRecordStore(rolesRoot);
    this.state = this.load();
    const migrated = this.pauseLegacyActiveJobs();
    if (migrated && !options.readOnly) this.save();
  }

  private pauseLegacyActiveJobs(): boolean {
    let changed = false;
    const updatedAt = new Date().toISOString();
    for (const job of this.state.jobs) {
      if ((job.status === "queued" || job.status === "running") && !sanitizeRoleId(job.roleId)) {
        job.status = "paused";
        job.updatedAt = updatedAt;
        job.lastError = "This legacy job has no roleId; choose a persona and create a replacement job.";
        changed = true;
      }
    }
    return changed;
  }

  private load(): PersistedState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as PersistedState;
      if (parsed.version === 1 && Array.isArray(parsed.jobs)) return parsed;
    } catch {
      // First run or an invalid private runtime file starts from a safe empty state.
    }
    return { version: 1, jobs: [] };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, this.statePath);
    } catch (error) {
      recordDataMutationAudit({
        level: "error",
        group: "bilibili-history",
        event: "bilibili_history_bridge_state_write_failed",
        owner: "bilibili-history-bridge",
        action: "persist-state",
        target: { type: "bridge-state", id: "bilibili-history" },
        dataSource: { kind: "file", id: "bilibili-history/state.json" },
        outcome: "failed",
        error
      });
      throw error;
    }
    recordDataMutationAudit({
      group: "bilibili-history",
      event: "bilibili_history_bridge_state_written",
      owner: "bilibili-history-bridge",
      action: "persist-state",
      target: { type: "bridge-state", id: "bilibili-history" },
      dataSource: { kind: "file", id: "bilibili-history/state.json" },
      outcome: "committed",
      changes: [{ field: "jobCount", to: this.state.jobs.length }]
    });
  }

  private tokenMatches(request: http.IncomingMessage): boolean {
    const expected = this.state.bridge?.token ?? "";
    const supplied = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!expected || expected.length !== supplied.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  }

  private touchBridge(): void {
    if (!this.state.bridge) return;
    this.state.bridge.lastSeenAt = new Date().toISOString();
    this.save();
  }

  private queuedJob(): BilibiliHistoryJob | undefined {
    return this.state.jobs.find(job => job.status === "running")
      ?? this.state.jobs.find(job => job.status === "queued");
  }

  handle(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): boolean {
    if (!requestUrl.pathname.startsWith("/api/bilibili-history/")) return false;
    if (!isLoopback(request)) {
      json(response, 403, { code: -1, error: "LOOPBACK_ONLY" });
      return true;
    }
    if (request.method === "OPTIONS") {
      json(response, 204, {});
      return true;
    }
    void this.handleAsync(request, requestUrl, response).catch(error => {
      if (!response.headersSent) {
        json(response, 400, { code: -1, error: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    });
    return true;
  }

  private async handleAsync(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): Promise<void> {
    const pathname = requestUrl.pathname;

    if (request.method === "POST" && pathname === "/api/bilibili-history/bridge/pair") {
      const body = await readJson<{ extensionId?: string }>(request);
      const extensionId = String(body.extensionId ?? "").trim();
      if (!/^[a-p]{32}$/.test(extensionId)) {
        json(response, 400, { code: -1, error: "INVALID_EXTENSION_ID" });
        return;
      }
      const origin = String(request.headers.origin ?? "").trim();
      if (origin && origin !== `chrome-extension://${extensionId}`) {
        json(response, 403, { code: -1, error: "EXTENSION_ORIGIN_MISMATCH" });
        return;
      }
      if (this.state.bridge && this.state.bridge.extensionId !== extensionId) {
        json(response, 409, { code: -1, error: "BRIDGE_ALREADY_PAIRED" });
        return;
      }
      if (!this.state.bridge) {
        const now = new Date().toISOString();
        this.state.bridge = {
          extensionId,
          token: randomBytes(32).toString("base64url"),
          pairedAt: now,
          lastSeenAt: now
        };
        this.save();
      }
      json(response, 200, { code: 0, token: this.state.bridge.token });
      return;
    }

    if (request.method === "GET" && pathname === "/api/bilibili-history/status") {
      json(response, 200, {
        code: 0,
        paired: Boolean(this.state.bridge),
        bridge: this.state.bridge ? {
          extensionId: this.state.bridge.extensionId,
          pairedAt: this.state.bridge.pairedAt,
          lastSeenAt: this.state.bridge.lastSeenAt
        } : null,
        jobs: this.state.jobs.slice(-20).map(publicJob)
      });
      return;
    }

    const roleDaysMatch = pathname.match(/^\/api\/bilibili-history\/roles\/([^/]+)\/days$/i);
    if (request.method === "GET" && roleDaysMatch) {
      const roleId = sanitizeRoleId(decodeURIComponent(roleDaysMatch[1]));
      if (!roleId) {
        json(response, 400, { code: -1, error: "INVALID_ROLE_ID" });
        return;
      }
      const index = this.recordStore.readIndex(roleId);
      json(response, 200, { code: 0, roleId, index });
      return;
    }

    const roleDayMatch = pathname.match(/^\/api\/bilibili-history\/roles\/([^/]+)\/days\/(\d{4}-\d{2}-\d{2})$/i);
    if (request.method === "GET" && roleDayMatch) {
      const roleId = sanitizeRoleId(decodeURIComponent(roleDayMatch[1]));
      if (!roleId) {
        json(response, 400, { code: -1, error: "INVALID_ROLE_ID" });
        return;
      }
      const records = this.recordStore.readDay(roleId, roleDayMatch[2]);
      const offset = Math.max(0, Math.trunc(Number(requestUrl.searchParams.get("offset")) || 0));
      const limit = Math.min(500, Math.max(1, Math.trunc(Number(requestUrl.searchParams.get("limit")) || 100)));
      json(response, 200, {
        code: 0,
        roleId,
        date: roleDayMatch[2],
        total: records.length,
        offset,
        limit,
        records: records.slice(offset, offset + limit)
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/bilibili-history/jobs") {
      const body = await readJson<{
        roleId?: unknown;
        since?: unknown;
        until?: unknown;
        pageDelayMs?: unknown;
        timezoneOffsetMinutes?: unknown;
      }>(request);
      const sinceEpoch = epoch(body.since);
      const untilEpoch = epoch(body.until) || Math.floor(Date.now() / 1000) + 1;
      if (!sinceEpoch || untilEpoch <= sinceEpoch) {
        json(response, 400, { code: -1, error: "INVALID_TIME_RANGE" });
        return;
      }
      const roleId = sanitizeRoleId(body.roleId);
      if (!roleId) {
        json(response, 400, { code: -1, error: "INVALID_ROLE_ID" });
        return;
      }
      try {
        this.recordStore.indexPath(roleId);
      } catch (error) {
        json(response, 404, { code: -1, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const now = new Date().toISOString();
      const job: BilibiliHistoryJob = {
        id: randomUUID(),
        roleId,
        createdAt: now,
        updatedAt: now,
        sinceEpoch,
        untilEpoch,
        timezoneOffsetMinutes: Number.isFinite(Number(body.timezoneOffsetMinutes))
          ? Math.min(840, Math.max(-840, Math.trunc(Number(body.timezoneOffsetMinutes))))
          : new Date().getTimezoneOffset(),
        status: "queued",
        cursor: { max: 0, view_at: 0, business: "" },
        pagesProcessed: 0,
        pageDelayMs: Math.min(5000, Math.max(250, Number(body.pageDelayMs) || DEFAULT_PAGE_DELAY_MS)),
        lastPageKey: "",
        lastError: "",
        summary: emptySummary(),
        persistence: {
          recordCount: 0,
          activeDays: {},
          lastPersistedAt: "",
          recordDates: {}
        }
      };
      this.state.jobs.push(job);
      this.state.jobs = this.state.jobs.slice(-100);
      this.save();
      json(response, 202, { code: 0, job: publicJob(job) });
      return;
    }

    const jobMatch = pathname.match(/^\/api\/bilibili-history\/jobs\/([0-9a-f-]+)$/i);
    if (request.method === "GET" && jobMatch) {
      const job = this.state.jobs.find(candidate => candidate.id === jobMatch[1]);
      json(response, job ? 200 : 404, job ? { code: 0, job: publicJob(job) } : { code: -1, error: "JOB_NOT_FOUND" });
      return;
    }

    if (request.method === "GET" && pathname === "/api/bilibili-history/bridge/next") {
      if (!this.tokenMatches(request)) {
        json(response, 401, { code: -1, error: "INVALID_BRIDGE_TOKEN" });
        return;
      }
      this.touchBridge();
      const job = this.queuedJob();
      if (!job) {
        json(response, 200, { code: 0, job: null });
        return;
      }
      if (job.status === "queued") {
        job.status = "running";
        job.updatedAt = new Date().toISOString();
        this.save();
      }
      json(response, 200, {
        code: 0,
        job: {
          id: job.id,
          endpoint: API_ENDPOINT,
          sinceEpoch: job.sinceEpoch,
          untilEpoch: job.untilEpoch,
          cursor: job.cursor,
          pageSize: MAX_PAGE_ITEMS,
          pageDelayMs: job.pageDelayMs
        }
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/bilibili-history/bridge/page") {
      if (!this.tokenMatches(request)) {
        json(response, 401, { code: -1, error: "INVALID_BRIDGE_TOKEN" });
        return;
      }
      const body = await readJson<PageSubmission>(request);
      const job = this.state.jobs.find(candidate => candidate.id === body.jobId);
      if (!job || job.status !== "running") {
        json(response, 409, { code: -1, error: "JOB_NOT_RUNNING" });
        return;
      }
      const code = Number(body.code);
      if (code !== 0) {
        job.status = code === -412 || code === -101 ? "paused" : "failed";
        job.lastError = `Bilibili API ${code}: ${String(body.message ?? "").slice(0, 160)}`;
        job.updatedAt = new Date().toISOString();
        this.save();
        json(response, 200, { code: 0, done: true, status: job.status });
        return;
      }
      const items = Array.isArray(body.items) ? body.items.slice(0, MAX_PAGE_ITEMS) : [];
      const pageKey = String(body.pageKey ?? "").slice(0, 256);
      if (!pageKey || pageKey !== job.lastPageKey) {
        const inRangeItems = items.filter(item => {
          const viewedAt = Number(item.view_at);
          return Number.isSafeInteger(viewedAt) && viewedAt >= job.sinceEpoch && viewedAt < job.untilEpoch;
        });
        if (!job.roleId) throw new Error("BILIBILI_HISTORY_JOB_HAS_NO_ROLE");
        const recordDates = job.persistence?.recordDates
          ?? this.recordStore.recordDatesForJob(job.roleId, job.id);
        const summarizedRecordIds = new Set(Object.keys(recordDates));
        const persistedAt = new Date().toISOString();
        const persisted = this.recordStore.persist(job.roleId, inRangeItems, {
          jobId: job.id,
          capturedAt: persistedAt,
          timezoneOffsetMinutes: job.timezoneOffsetMinutes
        });
        for (let index = 0; index < persisted.acceptedRecords.length; index += 1) {
          const record = persisted.acceptedRecords[index];
          if (!summarizedRecordIds.has(record.recordId)) {
            accumulate(job.summary, inRangeItems[index], job.timezoneOffsetMinutes);
            summarizedRecordIds.add(record.recordId);
          }
          recordDates[record.recordId] = record.localDate;
        }
        const activeDays: Record<string, number> = {};
        for (const date of Object.values(recordDates)) increment(activeDays, date);
        job.persistence = {
          recordCount: Object.keys(recordDates).length,
          activeDays,
          lastPersistedAt: persistedAt,
          recordDates
        };
        job.pagesProcessed += 1;
        job.lastPageKey = pageKey;
      }
      const crossedBoundary = items.some(item => Number(item.view_at) < job.sinceEpoch);
      const nextCursor = safeCursor(body.nextCursor);
      const cursorUnchanged = JSON.stringify(nextCursor) === JSON.stringify(job.cursor);
      const done = items.length === 0 || crossedBoundary || cursorUnchanged || job.pagesProcessed >= MAX_JOB_PAGES;
      job.cursor = nextCursor;
      job.updatedAt = new Date().toISOString();
      if (done) job.status = "completed";
      this.save();
      json(response, 200, {
        code: 0,
        done,
        status: job.status,
        nextCursor: job.cursor,
        waitMs: job.pageDelayMs
      });
      return;
    }

    json(response, 404, { code: -1, error: "NOT_FOUND" });
  }
}
