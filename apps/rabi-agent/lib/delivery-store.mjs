import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export function canonicalJson(value) {
  // Match wire JSON semantics (omit undefined object properties, null array
  // holes) before sorting. In particular a completed result has no error field.
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Delivery payload must be JSON serializable.");
  const stable = item => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(stable).join(",")}]`;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${stable(item[key])}`).join(",")}}`;
  };
  return stable(JSON.parse(text));
}
export const contentHash = value => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Private transport responsibility, outside immutable release directories. */
export class DeliveryStore {
  constructor(filename, { maxPending = 10_000, maxBytes = 64 * 1024 * 1024, now = Date.now } = {}) {
    this.now = now; this.maxPending = maxPending; this.maxBytes = maxBytes;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try { fs.chmodSync(filename, 0o600); } catch { /* Windows current-user data directory owns access. */ }
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS delivery_meta(version INTEGER NOT NULL);
      INSERT INTO delivery_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM delivery_meta);
      CREATE TABLE IF NOT EXISTS deliveries(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        hash TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, next_attempt INTEGER NOT NULL,
        last_error TEXT, receipt TEXT);
      CREATE INDEX IF NOT EXISTS delivery_due ON deliveries(state,next_attempt,seq);`);
    if (this.db.prepare("SELECT version FROM delivery_meta").get().version !== 1) { this.db.close(); throw new Error("Unsupported delivery queue schema; existing records retained."); }
    const columns = this.db.prepare("PRAGMA table_info(deliveries)").all().map(column => column.name);
    for (const column of ["manager_guid", "manager_origin", "manager_hint", "target_key"]) if (!columns.includes(column)) this.db.exec(`ALTER TABLE deliveries ADD COLUMN ${column} TEXT`);
    this.db.exec("CREATE INDEX IF NOT EXISTS delivery_target_order ON deliveries(target_key,seq,state)");
    // A crashed send is unknown, never reset to a fresh POST.
    this.db.prepare("UPDATE deliveries SET state='unknown',next_attempt=0 WHERE state='sending'").run();
  }
  submit(id, kind, payload, { managerGuid, managerOrigin, managerHint, targetKey } = {}) {
    if (typeof id !== "string" || !id.trim() || id.length > 512 || /[\x00-\x1f\x7f]/.test(id)) throw new Error("A stable delivery intent ID is required.");
    const text = canonicalJson(payload), hash = contentHash({ kind, payload });
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Delivery intent exceeds the 2 MiB local envelope limit.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT * FROM deliveries WHERE id=?").get(id);
      if (old) {
        if (old.hash !== hash) throw new Error("DELIVERY_INTENT_CONFLICT: the original target and content are immutable.");
        this.db.exec("COMMIT"); return this.project(old);
      }
      const capacity = this.db.prepare("SELECT count(*) AS count,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM deliveries WHERE state NOT IN ('delivered','cancelled')").get();
      if (capacity.count >= this.maxPending || capacity.bytes + Buffer.byteLength(text) > this.maxBytes) throw new Error("DELIVERY_QUEUE_FULL: intent was not accepted.");
      const now = this.now();
      this.db.prepare("INSERT INTO deliveries(id,kind,hash,payload,state,created,updated,next_attempt,manager_guid,manager_origin,manager_hint,target_key) VALUES(?,?,?,?,'pending',?,?,0,?,?,?,?)")
        .run(id, kind, hash, text, now, now, managerGuid || null, managerOrigin || null, managerHint || null, targetKey || id);
      this.db.exec("COMMIT"); return this.get(id);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  project(row) {
    if (!row) return undefined;
    return { intentId: row.id, kind: row.kind, state: row.state, payloadHash: row.hash, attempts: row.attempts,
      createdAt: new Date(row.created).toISOString(), updatedAt: new Date(row.updated).toISOString(),
      nextAttemptAt: row.next_attempt ? new Date(row.next_attempt).toISOString() : null,
      error: row.last_error || null, ...(row.receipt ? { receipt: JSON.parse(row.receipt) } : {}) };
  }
  get(id) { return this.project(this.db.prepare("SELECT * FROM deliveries WHERE id=?").get(id)); }
  raw(id) { const row = this.db.prepare("SELECT * FROM deliveries WHERE id=?").get(id); return row && { ...row, payload: JSON.parse(row.payload) }; }
  taskManagerGuid(taskId) {
    const rows = this.db.prepare("SELECT DISTINCT manager_guid FROM deliveries WHERE kind='task-result' AND json_extract(payload,'$.taskId')=?").all(taskId);
    return rows.length === 1 && rows[0].manager_guid || undefined;
  }
  list({ cursor, limit = 50, state, query } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (cursor !== undefined && !/^\d+$/.test(String(cursor)))) throw new Error("Invalid delivery pagination.");
    if (query !== undefined && (typeof query !== "string" || query.length > 300)) throw new Error("Invalid delivery query.");
    const clauses = [], values = [];
    if (state) { clauses.push("state=?"); values.push(state); }
    if (query) {
      clauses.push("(instr(id,?)>0 OR instr(coalesce(json_extract(payload,'$.sessionId'),''),?)>0 OR instr(coalesce(json_extract(payload,'$.request.threadId'),''),?)>0)");
      values.push(query, query, query);
    }
    const filter = clauses.length ? " AND " + clauses.join(" AND ") : "";
    const rows = this.db.prepare(`SELECT * FROM deliveries WHERE seq>?${filter} ORDER BY seq LIMIT ?`).all(Number(cursor || 0), ...values, limit + 1);
    const items = rows.slice(0, limit), counts = Object.fromEntries(this.db.prepare(`SELECT state,count(*) AS count FROM deliveries WHERE 1=1${filter} GROUP BY state`).all(...values).map(row => [row.state, row.count]));
    return { items: items.map(row => this.project(row)), nextCursor: rows.length > limit ? String(items.at(-1).seq) : null, counts };
  }
  due(limit = 32, { ordered = false, activeTargets = [], excludeIds = [], perTarget = limit } = {}) {
    const earlier = ordered ? " AND NOT EXISTS(SELECT 1 FROM deliveries earlier WHERE coalesce(earlier.target_key,earlier.id)=coalesce(d.target_key,d.id) AND earlier.seq<d.seq AND earlier.state NOT IN ('delivered','cancelled'))" : "";
    const excluded = excludeIds.length ? ` AND d.id NOT IN (${excludeIds.map(() => "?").join(",")})` : "";
    const slots = activeTargets.length ? `CASE target_key ${activeTargets.map(() => "WHEN ? THEN ?").join(" ")} ELSE ? END` : "?";
    const ids = this.db.prepare(`WITH ranked AS (
      SELECT d.id,d.seq,d.next_attempt,coalesce(d.target_key,d.id) AS target_key,
        row_number() OVER(PARTITION BY coalesce(d.target_key,d.id) ORDER BY d.seq) AS target_rank
      FROM deliveries d WHERE (d.state NOT IN ('delivered','blocked','cancelled') OR (d.state='blocked' AND d.last_error IN ('DELIVERY_HTTP_401','DELIVERY_HTTP_403','DELIVERY_MANAGER_CHANGED','DELIVERY_MANAGER_IDENTITY_UNAVAILABLE')))
        AND d.next_attempt<=?${earlier}${excluded})
      SELECT id FROM ranked WHERE target_rank<=${slots} ORDER BY next_attempt,seq LIMIT ?`)
      .all(this.now(), ...excludeIds, ...activeTargets.flatMap(item => [item.targetKey, item.slots]), perTarget, limit);
    // Only scheduling identities enter the window; materialize immutable bodies
    // after SQL has selected at most the available global execution slots.
    return ids.map(row => this.raw(row.id));
  }
  bindManagerGuid(id, guid) {
    if (typeof guid !== "string" || !guid.trim()) throw new Error("A verified Manager GUID is required before a transport attempt.");
    this.db.prepare("UPDATE deliveries SET manager_guid=? WHERE id=? AND manager_guid IS NULL").run(guid, id);
    if (this.raw(id)?.manager_guid !== guid) throw new Error("Delivery Manager binding conflict; original record retained.");
  }
  update(id, state, { error = null, receipt, delayMs = 0, attempt = false } = {}) {
    const old = this.raw(id); if (!old || old.state === "delivered") return this.get(id);
    this.db.prepare("UPDATE deliveries SET state=?,updated=?,next_attempt=?,last_error=?,receipt=?,attempts=attempts+? WHERE id=?")
      .run(state, this.now(), this.now() + delayMs, error, receipt === undefined ? old.receipt : JSON.stringify(receipt), attempt ? 1 : 0, id);
    return this.get(id);
  }
  acknowledgeEvent(id, taskId) {
    const row = this.raw(id);
    if (!row || row.kind !== "task-result" || row.payload.taskId !== taskId) return false;
    this.update(id, "delivered", { receipt: { eventId: id, taskId, accepted: true } }); return true;
  }
  close() { this.db.close(); }
}
