import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFileSync, withFileLockSync } from "./shared/filePersistence.js";
import { createLocalSecretProtector, type LocalSecretProtector } from "./shared/localSecretProtection.js";
import { resolveRuntimeLayout } from "./shared/runtimeLayout.js";
import { recordDataMutationAudit } from "./observability/dataMutationAudit.js";

export type DshSessionCredential = { cookie: string; expiresAt: number };
type ConnectionRecord = {
  origin: string;
  state: "connected" | "disconnected";
  updatedAt: string;
  expiresAt?: number;
  protection?: string;
  protectedCredential?: string;
};
type ConnectionDocument = { schemaVersion: 1; revision: number; connections: ConnectionRecord[] };
export type DshConnectionResolution =
  | (DshSessionCredential & { state: "connected" })
  | { state: "expired" | "disconnected"; cookie?: undefined };

export class DshConnectionError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function dshConnectionFile(): string {
  const root = resolveRuntimeLayout(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")).stateRoot;
  return path.join(root, "data", "dsh-connections", "connections.json");
}

export function dshLocalOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new DshConnectionError("DSH connection address is invalid."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new DshConnectionError("DSH connection requires a clean local HTTP(S) origin.");
  }
  return url.origin;
}

/** Machine-private authentication only; no session, Route, or business state. */
export class DshConnectionStore {
  private readonly credentialCache = new Map<string, { protectedValue: string; credential: DshSessionCredential; until: number }>();
  constructor(
    readonly filePath = dshConnectionFile(),
    private readonly protector: LocalSecretProtector = createLocalSecretProtector(path.dirname(filePath))
  ) {}

  private readDocument(): ConnectionDocument {
    try {
      const stat = fs.lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("invalid");
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as ConnectionDocument;
      if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !Array.isArray(value.connections) || value.connections.length > 100) throw new Error("invalid");
      const seen = new Set<string>();
      for (const row of value.connections) {
        if (!row || typeof row.origin !== "string" || dshLocalOrigin(row.origin) !== row.origin || seen.has(row.origin)
          || !["connected", "disconnected"].includes(row.state) || typeof row.updatedAt !== "string") throw new Error("invalid");
        if (row.state === "connected" && (!Number.isSafeInteger(row.expiresAt) || !row.protection
          || typeof row.protectedCredential !== "string" || !row.protectedCredential)) throw new Error("invalid");
        seen.add(row.origin);
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, revision: 0, connections: [] };
      throw new DshConnectionError("DSH saved connections are unreadable; restore the local connection settings.", 500);
    }
  }

  readMetadata(now = Date.now()) {
    const document = this.readDocument();
    return {
      revision: document.revision,
      connections: document.connections.map(row => ({
        baseUrl: row.origin,
        state: row.state === "disconnected" ? "disconnected" : Number(row.expiresAt) <= now ? "expired" : "saved",
        updatedAt: row.updatedAt,
        ...(row.expiresAt !== undefined && row.expiresAt > 0 ? { expiresAt: row.expiresAt } : {})
      }))
    };
  }

  resolve(origin: string, now = Date.now()): DshConnectionResolution | undefined {
    const row = this.readDocument().connections.find(item => item.origin === origin);
    if (!row) return undefined;
    if (row.state === "disconnected") return { state: "disconnected" };
    if (Number(row.expiresAt) <= now) return { state: "expired" };
    try {
      if (row.protection !== this.protector.scheme) throw new Error("protection mismatch");
      const cached = this.credentialCache.get(origin);
      if (cached && cached.protectedValue === row.protectedCredential && cached.credential.expiresAt === row.expiresAt && cached.until > now) return { state: "connected", ...cached.credential };
      const value = JSON.parse(this.protector.unprotect(row.protectedCredential!)) as DshSessionCredential & { origin: string };
      if (value.origin !== origin || value.expiresAt !== row.expiresAt || !/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(value.cookie)) throw new Error("invalid");
      const credential = { cookie: value.cookie, expiresAt: value.expiresAt };
      this.credentialCache.set(origin, { protectedValue: row.protectedCredential!, credential, until: Math.min(value.expiresAt, now + 60_000) });
      return { state: "connected", ...credential };
    } catch { throw new DshConnectionError("DSH saved authentication is unavailable to this system account; reconnect in WebGUI.", 401); }
  }

  connect(origin: string, credential: DshSessionCredential, expectedRevision: number): void {
    origin = dshLocalOrigin(origin);
    if (!/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(credential.cookie)
      || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt <= Date.now()) {
      throw new DshConnectionError("DSH session credential is invalid or expired.");
    }
    const protectedCredential = this.protector.protect(JSON.stringify({ ...credential, origin }));
    this.replace({ origin, state: "connected", updatedAt: new Date().toISOString(), expiresAt: credential.expiresAt,
      protection: this.protector.scheme, protectedCredential }, expectedRevision);
  }

  invalidate(origin: string, rejectedCookie: string): void {
    withFileLockSync(`${this.filePath}.lock`, () => {
      const current = this.resolve(origin);
      if (current?.state !== "connected" || current.cookie !== rejectedCookie) return;
      const document = this.readDocument();
      const row = document.connections.find(item => item.origin === origin)!;
      row.expiresAt = 0;
      row.updatedAt = new Date().toISOString();
      document.revision++;
      atomicWriteFileSync(this.filePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      this.credentialCache.delete(origin);
      recordDataMutationAudit({ group: "security", event: "dsh_connection_rejected", owner: "DshConnectionStore", action: "invalidate",
        target: { type: "dsh_connection", id: origin }, dataSource: { kind: "file", id: "dsh-connections/connections.json" }, outcome: "committed" });
    });
  }

  disconnect(origin: string, expectedRevision: number): void {
    this.replace({ origin: dshLocalOrigin(origin), state: "disconnected", updatedAt: new Date().toISOString() }, expectedRevision);
  }

  private replace(row: ConnectionRecord, expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DshConnectionError("DSH connection revision is required.");
    withFileLockSync(`${this.filePath}.lock`, () => {
      const document = this.readDocument();
      if (row.state === "connected" && Number(row.expiresAt) <= Date.now()) throw new DshConnectionError("DSH session credential expired before saving.", 401);
      if (document.revision !== expectedRevision) throw new DshConnectionError("DSH connections changed; refresh before retrying.", 409);
      const index = document.connections.findIndex(item => item.origin === row.origin);
      if (index < 0) {
        if (document.connections.length >= 100) throw new DshConnectionError("DSH connection limit reached.");
        document.connections.push(row);
      } else document.connections[index] = row;
      document.revision++;
      atomicWriteFileSync(this.filePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      this.credentialCache.delete(row.origin);
      recordDataMutationAudit({ group: "security", event: "dsh_connection_updated", owner: "DshConnectionStore", action: row.state,
        target: { type: "dsh_connection", id: row.origin }, dataSource: { kind: "file", id: "dsh-connections/connections.json" },
        outcome: "committed", changes: [{ field: "authentication" }] });
    });
  }
}
