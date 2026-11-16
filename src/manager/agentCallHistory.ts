import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactCallValue } from "../../apps/rabi-agent/lib/call-observation.mjs";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const identifier = /^[a-zA-Z0-9._:-]{1,160}$/;
const sources = new Set(["mcp", "cli", "http", "sdk"]);
const defaults = { enabled: true, captureBodies: true, maxBodyBytes: 4 * 1024 * 1024 };

export type CallObservation = {
  callId: string;
  spanId: string;
  boundary: "server" | "client" | "tool";
  source: string;
  startedAt: string;
  endedAt?: string;
  agentType?: string;
  sessionId?: string;
  toolName?: string;
  operationId?: string;
  requestId?: string;
  method?: string;
  pathname?: string;
  status: string;
  statusCode?: number;
  durationMs?: number;
  responseBytes?: number;
  request?: unknown;
  response?: unknown;
  truncated?: boolean;
};

export type CallHistoryQuery = { limit?: number; cursor?: string; source?: string; status?: string; sessionId?: string; query?: string; from?: string; to?: string };

function boundedText(value: unknown, limit = 500): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function responseStatus(statusCode: number, body: unknown): string {
  const value = body as { code?: number; ok?: boolean; uncertain?: boolean } | null;
  if (value?.uncertain) return "uncertain";
  if (statusCode >= 400 || value?.ok === false || value?.code === -1) return "failed";
  return statusCode === 202 ? "accepted" : "succeeded";
}

function bodyValue(bytes: Buffer[], contentType: string, truncated: boolean): unknown {
  if (!bytes.length) return null;
  if (!/json|text|xml|javascript|form-urlencoded/.test(contentType)) return { mediaType: contentType || "application/octet-stream", captured: "metadata" };
  if (truncated) return { captured: "omitted", reason: "size-limit", truncated: true };
  const text = Buffer.concat(bytes).toString("utf8");
  try { return JSON.parse(text); } catch { return text; }
}

/** Original call observations and compressed payloads share this single owner. */
export class AgentCallHistory {
  private database?: DatabaseSync;
  private opening?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private pending = 0;
  private closing = false;
  private lastError?: string;
  private revision = 0;
  private droppedObservations = 0;
  private observationConflicts = 0;
  private listeners = new Set<() => void>();
  private subscriptions = new Set<() => void>();
  private config = { ...defaults };
  readonly directory: string;

  constructor(rootDir: string) {
    this.directory = path.join(rootDir, "data", ".runtime", "call-history");
  }

  private open(): Promise<void> {
    return this.opening ??= (async () => {
      await fs.mkdir(this.directory, { recursive: true });
      try { this.config = this.validateConfig(JSON.parse(await fs.readFile(path.join(this.directory, "config.json"), "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const database = new DatabaseSync(path.join(this.directory, "calls.sqlite"));
      database.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS calls (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT UNIQUE NOT NULL,
          started_at TEXT NOT NULL, updated_at TEXT NOT NULL, source TEXT NOT NULL,
          agent_type TEXT, session_id TEXT, tool_name TEXT, operation_id TEXT,
          method TEXT, pathname TEXT, status TEXT NOT NULL, status_code INTEGER,
          duration_ms REAL, response_bytes INTEGER, truncated INTEGER NOT NULL DEFAULT 0,
          boundary TEXT NOT NULL, request_id TEXT, summary TEXT NOT NULL DEFAULT '',
          capture_state TEXT NOT NULL DEFAULT 'complete', business_code TEXT
        );
        CREATE INDEX IF NOT EXISTS calls_session ON calls(session_id, sequence DESC);
        CREATE INDEX IF NOT EXISTS calls_source ON calls(source, sequence DESC);
        CREATE TABLE IF NOT EXISTS spans (
          call_id TEXT NOT NULL, span_id TEXT NOT NULL, boundary TEXT NOT NULL,
          started_at TEXT NOT NULL, payload_path TEXT NOT NULL,
          PRIMARY KEY(call_id, span_id, boundary)
        );
        CREATE TABLE IF NOT EXISTS recording_state (id INTEGER PRIMARY KEY, dropped INTEGER NOT NULL, conflicts INTEGER NOT NULL);`);
      const columns = database.prepare("PRAGMA table_info(calls)").all() as { name: string }[];
      if (!columns.some(column => column.name === "capture_state")) database.exec("ALTER TABLE calls ADD COLUMN capture_state TEXT NOT NULL DEFAULT 'complete'");
      if (!columns.some(column => column.name === "business_code")) database.exec("ALTER TABLE calls ADD COLUMN business_code TEXT");
      const spanColumns = database.prepare("PRAGMA table_info(spans)").all() as { pk: number }[];
      if (spanColumns.filter(column => column.pk > 0).length === 2) database.exec(`BEGIN IMMEDIATE;
        ALTER TABLE spans RENAME TO previous_spans;
        CREATE TABLE spans (call_id TEXT NOT NULL, span_id TEXT NOT NULL, boundary TEXT NOT NULL, started_at TEXT NOT NULL, payload_path TEXT NOT NULL, PRIMARY KEY(call_id, span_id, boundary));
        INSERT INTO spans SELECT * FROM previous_spans; DROP TABLE previous_spans; COMMIT;`);
      const health = database.prepare("SELECT dropped, conflicts FROM recording_state WHERE id=1").get() as { dropped: number; conflicts: number } | undefined;
      this.droppedObservations += health?.dropped ?? 0;
      this.observationConflicts += health?.conflicts ?? 0;
      this.database = database;
    })();
  }

  configuration() { return { ...this.config }; }

  private validateConfig(value: any) {
    if (typeof value?.enabled !== "boolean" || typeof value?.captureBodies !== "boolean" || !Number.isSafeInteger(value.maxBodyBytes)
      || value.maxBodyBytes < 1024 || value.maxBodyBytes > 16 * 1024 * 1024) throw new Error("Invalid call-history configuration.");
    return { enabled: value.enabled, captureBodies: value.captureBodies, maxBodyBytes: value.maxBodyBytes };
  }

  async configure(value: unknown) {
    await this.open();
    const config = this.validateConfig(value);
    const file = path.join(this.directory, "config.json");
    const temporary = file + "." + randomUUID() + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(config) + "\n");
    await fs.rename(temporary, file);
    this.config = config;
    this.changed();
    return this.configuration();
  }

  /** Observation failure affects diagnostics only. Calls retain their original result. */
  record(input: CallObservation): void {
    if (this.closing || !this.config.enabled) return;
    if (this.pending >= 256) { this.droppedObservations++; this.lastError = "Call-history write queue is full. Some observations were not captured."; return; }
    this.pending++;
    this.writes = this.writes.then(async () => {
      await this.open();
      if (!this.config.enabled) return;
      await this.persist(input);
      this.lastError = undefined;
      this.changed();
    }).catch(() => { this.droppedObservations++; this.lastError = "A call-history observation could not be persisted."; })
      .finally(() => { this.pending--; });
  }

  async ingest(input: unknown) {
    const value = input as CallObservation;
    if (!value || !identifier.test(value.callId) || !identifier.test(value.spanId) || !["client", "tool"].includes(value.boundary)
      || !Number.isFinite(Date.parse(value.startedAt)) || typeof value.status !== "string") throw Object.assign(new Error("Invalid client observation."), { statusCode: 400 });
    await this.open();
    if (this.closing) throw new Error("Call history is stopping.");
    if (!this.config.enabled) return { stored: true, captured: false, reason: "disabled" };
    // The receipt is acknowledged only after this exact observation is durable.
    const write = this.writes.then(() => this.persist(value));
    this.writes = write.then(() => {}, () => { this.lastError = "A client observation could not be persisted."; });
    const result = await write;
    this.changed();
    return result;
  }

  private async persist(input: CallObservation) {
    if (!identifier.test(input.callId) || !identifier.test(input.spanId)) throw new Error("Invalid call identity.");
    const headers = (input.request as { headers?: Record<string, unknown> } | undefined)?.headers;
    const secrets = Object.entries(headers ?? {}).flatMap(([key, value]) => {
      if (typeof value !== "string") return [];
      if (key.toLowerCase() === "authorization") return [value.replace(/^Bearer\s+/i, "")];
      return /token|api[-_]?key|secret/i.test(key) ? [value] : [];
    }).filter(value => value.length >= 8);
    const safe = redactCallValue(input, 0, new WeakSet(), secrets) as CallObservation;
    const record = { ...safe, source: sources.has(safe.source) ? safe.source : "http", pathname: boundedText(safe.pathname, 4096),
      toolName: boundedText(safe.toolName), operationId: boundedText(safe.operationId), agentType: boundedText(safe.agentType),
      sessionId: boundedText(safe.sessionId), status: boundedText(safe.status, 40) };
    if (!this.config.captureBodies) { record.request = { captured: "disabled" }; record.response = { captured: "disabled" }; }
    for (const side of ["request", "response"] as const) {
      const bytes = Buffer.byteLength(JSON.stringify(record[side]) ?? "");
      if (bytes > this.config.maxBodyBytes) {
        record[side] = { captured: "omitted", reason: "size-limit", bytes };
        record.truncated = true;
      }
    }
    let payload = JSON.stringify(record);
    if (Buffer.byteLength(payload) > this.config.maxBodyBytes * 3) {
      record.request = { captured: "omitted", reason: "payload-budget" };
      record.response = { captured: "omitted", reason: "payload-budget" };
      record.truncated = true;
      payload = JSON.stringify(record);
    }
    const digest = createHash("sha256").update(payload).digest("hex");
    const date = new Date(input.startedAt).toISOString().slice(0, 10);
    const relative = path.join("payloads", date, digest + ".json.gz");
    const file = path.join(this.directory, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, await compress(payload), { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const response = record.response as any;
    const body = response?.body ?? response;
    const result = body?.data ?? body?.bodyJson?.data;
    const items = result?.items;
    const request = record.request as any;
    const query = boundedText(request?.query?.q ?? request?.query?.query, 300);
    const summary = [query, Array.isArray(items) ? `${items.length} items${result.coverage?.state ? " · " + boundedText(result.coverage.state, 40) : ""}` : ""].filter(Boolean).join(" · ");
    const db = this.database!;
    if (record.boundary !== "server") {
      const previous = db.prepare("SELECT payload_path FROM spans WHERE call_id=? AND span_id=? AND boundary=?").get(record.callId, record.spanId, record.boundary) as { payload_path: string } | undefined;
      if (previous) {
        const conflict = previous.payload_path !== relative;
        if (conflict) this.observationConflicts++;
        db.prepare("INSERT OR REPLACE INTO recording_state(id, dropped, conflicts) VALUES (1,?,?)").run(this.droppedObservations, this.observationConflicts);
        return { stored: true, duplicate: true, conflict };
      }
    }
    const omitted = [record.request, request?.body, record.response, response?.body].some(value => value?.captured === "omitted");
    const captureState = !this.config.captureBodies ? "disabled" : record.truncated || omitted ? "partial"
      : response?.body?.captured === "metadata" || response?.bodyBytes?.captured === "metadata" ? "metadata"
      : record.status === "running" ? "pending" : "complete";
    const businessCode = body && typeof body === "object" && Object.hasOwn(body, "code") ? JSON.stringify(body.code).slice(0, 120) : null;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO spans(call_id, span_id, boundary, started_at, payload_path) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(call_id, span_id, boundary) DO UPDATE SET payload_path=excluded.payload_path`).run(record.callId, record.spanId, record.boundary, record.startedAt, relative);
      db.prepare(`INSERT INTO calls(call_id, started_at, updated_at, source, agent_type, session_id, tool_name, operation_id,
        method, pathname, status, status_code, duration_ms, response_bytes, truncated, boundary, request_id, summary, capture_state, business_code)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(call_id) DO UPDATE SET updated_at=excluded.updated_at,
        source=CASE WHEN excluded.source='http' THEN calls.source ELSE excluded.source END,
        agent_type=COALESCE(NULLIF(excluded.agent_type,''), calls.agent_type), session_id=COALESCE(NULLIF(excluded.session_id,''), calls.session_id),
        tool_name=COALESCE(NULLIF(excluded.tool_name,''),calls.tool_name), operation_id=COALESCE(NULLIF(excluded.operation_id,''),calls.operation_id),
        method=COALESCE(NULLIF(excluded.method,''),calls.method), pathname=COALESCE(NULLIF(excluded.pathname,''),calls.pathname),
        status=excluded.status, status_code=COALESCE(excluded.status_code,calls.status_code), duration_ms=excluded.duration_ms,
        response_bytes=COALESCE(excluded.response_bytes,calls.response_bytes), truncated=MAX(calls.truncated,excluded.truncated),
        boundary=excluded.boundary, request_id=COALESCE(NULLIF(excluded.request_id,''),calls.request_id),
        summary=COALESCE(NULLIF(excluded.summary,''),calls.summary), capture_state=excluded.capture_state,
        business_code=COALESCE(excluded.business_code,calls.business_code)`)
        .run(record.callId, record.startedAt, record.endedAt ?? record.startedAt, record.source, record.agentType || null,
          record.sessionId || null, record.toolName || null, record.operationId || null, record.method ?? null, record.pathname || null,
          record.status, record.statusCode ?? null, record.durationMs ?? null, record.responseBytes ?? null, record.truncated ? 1 : 0,
          record.boundary, record.requestId ?? null, summary, captureState, businessCode);
      db.prepare("INSERT OR REPLACE INTO recording_state(id, dropped, conflicts) VALUES (1,?,?)").run(this.droppedObservations, this.observationConflicts);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { stored: true };
  }

  async list(query: CallHistoryQuery = {}) {
    await this.open(); await this.writes;
    const limit = Number(query.limit ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Object.assign(new Error("limit must be between 1 and 200."), { statusCode: 400 });
    const filters = { source: query.source || "", status: query.status || "", sessionId: query.sessionId || "", query: query.query || "", from: query.from || "", to: query.to || "" };
    const scope = createHash("sha256").update(JSON.stringify(filters)).digest("hex");
    let before = Number.MAX_SAFE_INTEGER;
    let watermark = Number((this.database!.prepare("SELECT MAX(sequence) AS value FROM calls").get() as any)?.value ?? 0);
    if (query.cursor) {
      let cursor: any;
      try { cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")); } catch { throw Object.assign(new Error("Invalid call-history cursor."), { statusCode: 400 }); }
      if (cursor?.scope !== scope || !Number.isSafeInteger(cursor?.before) || !Number.isSafeInteger(cursor?.watermark)) throw Object.assign(new Error("Invalid call-history cursor."), { statusCode: 400 });
      before = cursor.before; watermark = cursor.watermark;
    }
    const where = ["sequence <= ?", "sequence < ?"];
    const values: (string | number)[] = [watermark, before];
    for (const [field, column] of [["source", "source"], ["status", "status"], ["sessionId", "session_id"]] as const) {
      if (filters[field]) { where.push(column + " = ?"); values.push(filters[field]); }
    }
    if (filters.from) { where.push("started_at >= ?"); values.push(filters.from); }
    if (filters.to) { where.push("started_at <= ?"); values.push(filters.to); }
    if (filters.query) { where.push("(instr(lower(COALESCE(operation_id,'') || ' ' || COALESCE(pathname,'') || ' ' || COALESCE(tool_name,'') || ' ' || call_id), lower(?)) > 0)"); values.push(filters.query); }
    const rows = this.database!.prepare(`SELECT * FROM calls WHERE ${where.join(" AND ")} ORDER BY sequence DESC LIMIT ?`).all(...values, limit + 1) as any[];
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map(row => ({ callId: row.call_id, startedAt: row.started_at, updatedAt: row.updated_at,
      source: row.source, agentType: row.agent_type, sessionId: row.session_id, toolName: row.tool_name, operationId: row.operation_id,
      method: row.method, pathname: row.pathname, status: row.status, statusCode: row.status_code, durationMs: row.duration_ms,
      responseBytes: row.response_bytes, truncated: Boolean(row.truncated), boundary: row.boundary, requestId: row.request_id, summary: row.summary,
      captureState: row.truncated ? "partial" : row.capture_state, businessCode: row.business_code }));
    return { items, nextCursor: more ? Buffer.from(JSON.stringify({ scope, watermark, before: rows[limit - 1].sequence })).toString("base64url") : null,
      recording: { ...this.configuration(), pending: this.pending, dropped: this.droppedObservations, conflicts: this.observationConflicts, lastError: this.lastError ?? null }, revision: this.revision };
  }

  async listStages(callId: string) {
    if (!identifier.test(callId)) return null;
    await this.open(); await this.writes;
    const stages = this.database!.prepare("SELECT span_id AS spanId, boundary, started_at AS startedAt FROM spans WHERE call_id=? ORDER BY started_at, span_id").all(callId);
    return stages.length ? { callId, stages } : null;
  }

  async detail(callId: string, spanId?: string, boundary?: string) {
    if (!identifier.test(callId)) return null;
    if (spanId && (!identifier.test(spanId) || !["server", "client", "tool"].includes(boundary ?? ""))) return null;
    await this.open(); await this.writes;
    const rows = (spanId
      ? this.database!.prepare("SELECT payload_path FROM spans WHERE call_id=? AND span_id=? AND boundary=?").all(callId, spanId, boundary!)
      : this.database!.prepare("SELECT payload_path FROM spans WHERE call_id=? ORDER BY started_at, span_id").all(callId)) as { payload_path: string }[];
    if (!rows.length) return null;
    const stages = await Promise.all(rows.map(async row => {
      try { return JSON.parse((await decompress(await fs.readFile(path.join(this.directory, row.payload_path)))).toString("utf8")); }
      catch { return { status: "unavailable", error: "Stored observation payload is unavailable." }; }
    }));
    return { callId, stages };
  }

  private changed() { this.revision++; for (const listener of this.listeners) listener(); }

  events() {
    let pending = true;
    let heartbeat = false;
    let closed = false;
    let wake: (() => void) | undefined;
    const changed = () => { pending = true; wake?.(); wake = undefined; };
    // event-driven-allow: SSE protocol keepalive; no business state is queried.
    const timer = setInterval(() => { heartbeat = true; wake?.(); wake = undefined; }, 20_000);
    timer.unref?.();
    const cancel = () => { closed = true; clearInterval(timer); this.listeners.delete(changed); this.subscriptions.delete(cancel); wake?.(); wake = undefined; };
    this.listeners.add(changed);
    this.subscriptions.add(cancel);
    const self = this;
    return { cancel, frames: (async function* () {
      try {
        while (!closed) {
          if (!pending && !heartbeat) await new Promise<void>(resolve => { wake = resolve; });
          if (closed) break;
          const changed = pending;
          pending = false;
          heartbeat = false;
          yield changed ? { event: "changed", data: { revision: self.revision } } : { comment: "keepalive" };
        }
      } finally { cancel(); }
    })() };
  }

  observeHttp(request: IncomingMessage, response: ServerResponse, requestId: string, resolveOperation: () => string | undefined): void {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://manager"); } catch { return; }
    if (!this.config.enabled || url.pathname.startsWith("/api/diagnostics/calls") || url.pathname === "/api/events" || url.pathname.endsWith("/events") || url.pathname === "/meta"
      || !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/gateways/")) return;
    const header = (name: string) => boundedText(request.headers[name], 160);
    const supplied = header("x-rabiroute-call-id");
    const startedAt = new Date().toISOString();
    const source = header("x-rabiroute-call-source");
    const requestChunks: Buffer[] = [], responseChunks: Buffer[] = [];
    let requestBytes = 0, responseBytes = 0;
    const limit = this.config.captureBodies ? this.config.maxBodyBytes : 0;
    this.record({ callId: identifier.test(supplied) ? supplied : requestId, spanId: requestId, boundary: "server", source,
      startedAt, agentType: header("x-rabiroute-agent-type"), sessionId: header("x-rabiroute-session-id"), toolName: header("x-rabiroute-tool-name"),
      requestId, method: request.method, pathname: url.pathname, status: "running", request: { query: Object.fromEntries(url.searchParams) } });
    const collect = (chunks: Buffer[], chunk: unknown, used: number, encoding?: BufferEncoding) => {
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return used;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any, encoding);
      if (used < limit) chunks.push(Buffer.from(bytes.subarray(0, limit - used)));
      return used + bytes.byteLength;
    };
    // Tapping emit preserves the original reader's flow control and body ownership.
    const emit = request.emit;
    request.emit = function(this: IncomingMessage, event: string | symbol, ...args: any[]) {
      if (event === "data") requestBytes = collect(requestChunks, args[0], requestBytes);
      return Reflect.apply(emit, this, [event, ...args]);
    } as typeof request.emit;
    const write = response.write, end = response.end;
    response.write = function(this: ServerResponse, chunk: any, ...args: any[]) {
      responseBytes = collect(responseChunks, chunk, responseBytes, typeof args[0] === "string" ? args[0] as BufferEncoding : undefined);
      return Reflect.apply(write, this, [chunk, ...args]);
    } as typeof response.write;
    response.end = function(this: ServerResponse, chunk?: any, ...args: any[]) {
      responseBytes = collect(responseChunks, chunk, responseBytes, typeof args[0] === "string" ? args[0] as BufferEncoding : undefined);
      return Reflect.apply(end, this, [chunk, ...args]);
    } as typeof response.end;
    let completed = false;
    const finish = (cancelled: boolean) => {
      if (completed) return;
      completed = true;
      const body = bodyValue(responseChunks, String(response.getHeader("content-type") ?? ""), responseBytes > limit);
      this.record({ callId: identifier.test(supplied) ? supplied : requestId, spanId: requestId, boundary: "server", source,
        startedAt, endedAt: new Date().toISOString(), agentType: header("x-rabiroute-agent-type"), sessionId: header("x-rabiroute-session-id"),
        toolName: header("x-rabiroute-tool-name"), operationId: resolveOperation(), requestId, method: request.method, pathname: url.pathname,
        status: cancelled ? "cancelled" : responseStatus(response.statusCode, body), statusCode: response.statusCode,
        durationMs: Math.max(0, Date.now() - Date.parse(startedAt)), responseBytes,
        request: { query: Object.fromEntries(url.searchParams), queryValues: Object.fromEntries([...new Set(url.searchParams.keys())].map(key => [key, url.searchParams.getAll(key)])), headers: { ...request.headers },
          body: bodyValue(requestChunks, String(request.headers["content-type"] ?? ""), requestBytes > limit) },
        response: { statusCode: response.statusCode, headers: response.getHeaders(), body }, truncated: limit > 0 && (requestBytes > limit || responseBytes > limit) });
      requestChunks.length = 0; responseChunks.length = 0;
    };
    response.once("finish", () => finish(false));
    response.once("close", () => finish(!response.writableFinished));
  }

  async close() {
    this.closing = true;
    for (const cancel of [...this.subscriptions]) cancel();
    await this.writes;
    this.database?.close();
  }
}
