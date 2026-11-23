import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { roleFolderPath } from "./shared/routePaths.js";
import { recordDataMutationAudit } from "./observability/dataMutationAudit.js";
import { tryRoleFileLock } from "./shared/roleFileLock.js";

export type RoleMetadata = { schemaVersion: 1; revision: number; archivedAt: string | null };
export class RoleLifecycleError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

export type RoleStorageFailureCode = "ROLE_STORAGE_UNAVAILABLE" | "ROLE_STORAGE_WAIT_TIMEOUT";

/** Restore the same storage error after a Hook read crosses the worker boundary. */
export function roleStorageFailure(code: RoleStorageFailureCode, cause?: unknown): RoleLifecycleError {
  return code === "ROLE_STORAGE_WAIT_TIMEOUT"
    ? new RoleLifecycleError(code, "Rabi 等待角色资料访问超时。")
    : Object.assign(new RoleLifecycleError(code, "Rabi 无法访问角色资料。", 503), { cause });
}

function parseRoleMetadata(text: string): RoleMetadata {
  const value = JSON.parse(text) as RoleMetadata;
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (value.archivedAt !== null && (typeof value.archivedAt !== "string" || !Number.isFinite(Date.parse(value.archivedAt))))) {
    throw new Error("invalid role metadata");
  }
  return value;
}

/** Used by the isolated catalog capture worker, never by the Manager request loop. */
export function roleLifecyclePresentation(roleDirectory: string): { archivedAt?: string | null; lifecycleError?: string } {
  const file = path.join(roleDirectory, "roleMetadata.json");
  try {
    if (fsSync.statSync(file).size > 8192) throw new Error("metadata too large");
    return { archivedAt: parseRoleMetadata(fsSync.readFileSync(file, "utf8")).archivedAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { lifecycleError: "ROLE_METADATA_UNAVAILABLE" };
  }
}

export async function readRoleMetadata(roleDirectory: string): Promise<RoleMetadata> {
  try {
    const file = await fs.open(path.join(roleDirectory, "roleMetadata.json"), "r");
    try {
      if ((await file.stat()).size > 8192) throw new Error("metadata too large");
      return parseRoleMetadata(await file.readFile("utf8"));
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, revision: 0, archivedAt: null };
    throw new RoleLifecycleError("ROLE_METADATA_UNAVAILABLE", "角色状态无法读取，请检查角色元数据。", 503);
  }
}

export function roleStateRoot(roleDirectory: string): string {
  return path.join(path.dirname(roleDirectory), ".role-state");
}

export async function assertRoleAcceptsWork(roleDirectory: string): Promise<void> {
  const marker = path.join(roleStateRoot(roleDirectory), "deleted", `${path.basename(roleDirectory)}.json`);
  if (await fs.stat(marker).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) throw new RoleLifecycleError("ROLE_DELETED", "角色已删除。", 410);
  if ((await readRoleMetadata(roleDirectory)).archivedAt) throw new RoleLifecycleError("ROLE_ARCHIVED", "角色已归档，已暂停新任务。");
}

async function withRoleStorageLock<T>(roleDirectory: string, mode: "shared" | "exclusive", operation: () => Promise<T>): Promise<T> {
  const locks = path.join(roleStateRoot(roleDirectory), "locks");
  const lock = path.join(locks, `${path.basename(roleDirectory)}.lock`);
  const deadline = performance.now() + 5_000;
  async function acquire() {
    try { return await tryRoleFileLock(lock, mode); }
    catch (cause) { throw roleStorageFailure("ROLE_STORAGE_UNAVAILABLE", cause); }
  }
  try { await fs.mkdir(locks, { recursive: true }); }
  catch (cause) { throw roleStorageFailure("ROLE_STORAGE_UNAVAILABLE", cause); }
  let release = await acquire();
  while (!release && mode === "shared" && performance.now() < deadline) {
    await delay(15 + Math.random() * 15);
    release = await acquire();
  }
  if (!release) throw mode === "shared"
    ? roleStorageFailure("ROLE_STORAGE_WAIT_TIMEOUT")
    : new RoleLifecycleError("ROLE_BUSY", "Rabi 暂时无法修改角色资料，请稍后重试。");
  try { return await operation(); }
  finally { await release(); }
}

/** Serialize changes to the same role or operation key across Manager and Gateway processes. */
export async function withRoleLock<T>(roleDirectory: string, operation: () => Promise<T>): Promise<T> {
  return withRoleStorageLock(roleDirectory, "exclusive", operation);
}

export async function beginRoleWork(roleDirectory: string): Promise<() => Promise<void>> {
  return withRoleStorageLock(roleDirectory, "shared", async () => {
    await assertRoleAcceptsWork(roleDirectory);
    const directory = path.join(roleStateRoot(roleDirectory), "work", path.basename(roleDirectory));
    await fs.mkdir(directory, { recursive: true });
    const lease = path.join(directory, `${randomUUID()}.json`);
    await fs.writeFile(lease, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
    let released = false;
    return async () => {
      if (released) return;
      await fs.unlink(lease);
      released = true;
    };
  });
}

export async function roleWorkCount(roleDirectory: string): Promise<number> {
  return fs.readdir(path.join(roleStateRoot(roleDirectory), "work", path.basename(roleDirectory)))
    .then(files => files.length, error => { if (error.code === "ENOENT") return 0; throw error; });
}

/** A request owner can fence preparation awaits before dispatching the atomic replacement. */
export async function atomicRoleJson(file: string, value: unknown, assertCurrent?: () => void): Promise<void> {
  assertCurrent?.();
  await fs.mkdir(path.dirname(file), { recursive: true });
  assertCurrent?.();
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    assertCurrent?.();
    await fs.rename(temporary, file);
    recordDataMutationAudit({ group: "persona", event: "role_file_committed", owner: "role-lifecycle",
      action: "write", target: { type: "role-file", id: path.basename(file) },
      dataSource: { kind: "file", id: path.basename(file) }, outcome: "committed" });
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

export async function checkedRoleDirectory(rolesRoot: string, roleId: string): Promise<string> {
  const directory = roleFolderPath(rolesRoot, roleId);
  const [root, resolved, stat] = await Promise.all([fs.realpath(rolesRoot), fs.realpath(directory), fs.lstat(directory)]);
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.dirname(resolved) !== root) {
    throw new RoleLifecycleError("ROLE_PATH_INVALID", "角色目录超出受管范围。", 400);
  }
  return directory;
}
