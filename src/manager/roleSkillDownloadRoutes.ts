import type http from "node:http";
import fs, { constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ManagerReadWorkerError } from "./managerReadWorkerPool.js";
import { roleSkillArchiveLimits } from "./roleSkillArchive.js";
import { parseRoleSkillDownloadRoute } from "./roleKnowledgeRoute.js";

export type RoleSkillArchiveReply =
  | { ok: true; sizeBytes: number; sha256: string; fileCount: number }
  | { ok: false; code: "not_found" | "unsafe_path" | "too_large" | "conflict" };

export const roleSkillDownloadPolicy = Object.freeze({ maxActiveLeases: 4, transferTimeoutMs: 30_000 });

/** Includes generation, slow transfers and quarantined workers; not just pool slots. */
export class RoleSkillDownloadAdmission {
  private leases = 0;
  constructor(private readonly limit: number = roleSkillDownloadPolicy.maxActiveLeases) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid download lease limit.");
  }
  get active(): number { return this.leases; }
  acquire(): (() => void) | undefined {
    if (this.leases >= this.limit) return undefined;
    this.leases++;
    let released = false;
    return () => { if (!released) { released = true; this.leases--; } };
  }
}
const downloadAdmission = new RoleSkillDownloadAdmission();

type Context = {
  roleDirectory: (roleId: string) => string;
  archive: (roleDir: string, skillId: string, outputPath: string, options: {
    signal: AbortSignal;
    /** Must be invoked on late confirmed worker exit after termination_unconfirmed. */
    onWorkerReleased: () => void;
  }) => Promise<RoleSkillArchiveReply>;
  json: (response: http.ServerResponse, status: number, body: unknown) => void;
  /** Existing host error logging; do not log private source or archive paths. */
  reportCleanupError: () => void;
  temporaryRoot?: string;
  admission?: RoleSkillDownloadAdmission;
  transferTimeoutMs?: number;
};
const archiveErrorStatus = { not_found: 404, unsafe_path: 403, too_large: 413, conflict: 409 } as const;

/** The caller performs authentication and persona authorization before entering this route. */
export function handleRoleSkillDownloadApi(
  request: http.IncomingMessage, pathname: string, response: http.ServerResponse, context: Context
): boolean {
  let route: ReturnType<typeof parseRoleSkillDownloadRoute>;
  try { route = parseRoleSkillDownloadRoute(pathname); }
  catch { context.json(response, 403, { code: -1, error: "INVALID_SKILL_DOWNLOAD_PATH" }); return true; }
  if (!route) return false;
  if (request.method !== "GET") {
    context.json(response, 405, { code: -1, error: "GET_REQUIRED" }); return true;
  }
  if (new URL(request.url || pathname, "http://request.invalid").search) {
    context.json(response, 400, { code: -1, error: "SKILL_DOWNLOAD_QUERY_NOT_SUPPORTED" }); return true;
  }
  void transfer(request, response, route, context).catch(() => context.reportCleanupError());
  return true;
}

async function transfer(
  request: http.IncomingMessage, response: http.ServerResponse,
  route: { roleId: string; skillId: string }, context: Context
): Promise<void> {
  if (request.aborted || response.destroyed) return;
  const releaseLease = (context.admission ?? downloadAdmission).acquire();
  if (!releaseLease) {
    context.json(response, 503, { code: -1, error: "SKILL_DOWNLOAD_BUSY" });
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => { if (!response.writableEnded) abort(); };
  request.once("aborted", abort);
  response.once("close", closed);
  let lease: string | undefined;
  let workerReleased = false;
  let quarantined = false;
  let transferTimer: NodeJS.Timeout | undefined;
  let cleanupFlight: Promise<void> | undefined;
  const cleanup = () => cleanupFlight ??= (async () => {
    if (lease) await fs.rm(lease, { recursive: true, force: true });
    // Failed cleanup retains admission rather than allowing unbounded orphan artifacts.
    releaseLease();
  })();
  const onWorkerReleased = () => {
    workerReleased = true;
    if (quarantined) void cleanup().catch(() => context.reportCleanupError());
  };
  try {
    if (request.aborted || response.destroyed) abort();
    controller.signal.throwIfAborted();
    const roleDir = context.roleDirectory(route.roleId);
    // A fresh private lease lives outside public resource trees. Only the worker gets its path.
    lease = await fs.mkdtemp(path.join(context.temporaryRoot ?? os.tmpdir(), "rabiroute-skill-"));
    controller.signal.throwIfAborted();
    const outputPath = path.join(lease, "download.zip");
    const result = await context.archive(roleDir, route.skillId, outputPath, { signal: controller.signal, onWorkerReleased });
    controller.signal.throwIfAborted();
    if (!result.ok) {
      context.json(response, archiveErrorStatus[result.code], { code: -1, error: `SKILL_ARCHIVE_${result.code.toUpperCase()}` });
      return;
    }
    if (!Number.isSafeInteger(result.sizeBytes) || result.sizeBytes < 22
      || result.sizeBytes > roleSkillArchiveLimits.maxArchiveBytes || !/^[a-f0-9]{64}$/i.test(result.sha256)) {
      throw new Error("Invalid archive result.");
    }
    const transferTimeout = context.transferTimeoutMs ?? roleSkillDownloadPolicy.transferTimeoutMs;
    if (!Number.isSafeInteger(transferTimeout) || transferTimeout < 1) throw new Error("Invalid transfer timeout.");
    transferTimer = setTimeout(() => { abort(); response.destroy(); }, transferTimeout);
    transferTimer.unref();
    const file = await fs.open(outputPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== result.sizeBytes) throw new Error("Invalid archive artifact.");
      controller.signal.throwIfAborted();
      const asciiName = `${route.skillId}.zip`.replace(/[^A-Za-z0-9._-]/g, "_");
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(result.sizeBytes),
        "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(`${route.skillId}.zip`).replace(/'/g, "%27")}`,
        "x-rabiroute-content-sha256": result.sha256.toLowerCase(),
        "etag": `"sha256-${result.sha256.toLowerCase()}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff"
      });
      await pipeline(file.createReadStream(), response, { signal: controller.signal });
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof ManagerReadWorkerError && error.code === "termination_unconfirmed") {
      // The pool retains its slot. Never delete a directory a live worker can still write.
      quarantined = !workerReleased;
    }
    if (controller.signal.aborted || response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    const unavailable = error instanceof ManagerReadWorkerError
      && ["busy", "timeout", "termination_unconfirmed"].includes(error.code);
    context.json(response, unavailable ? 503 : 500, {
      code: -1, error: unavailable ? "SKILL_ARCHIVE_UNAVAILABLE" : "SKILL_ARCHIVE_FAILED"
    });
  } finally {
    if (transferTimer) clearTimeout(transferTimer);
    request.removeListener("aborted", abort);
    response.removeListener("close", closed);
    if (!quarantined) await cleanup();
  }
}
