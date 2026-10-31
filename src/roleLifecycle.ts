import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { roleFolderPath } from "./shared/routePaths.js";
import { recordDataMutationAudit } from "./observability/dataMutationAudit.js";

export type RoleMetadata = { schemaVersion: 1; revision: number; archivedAt: string | null };
export class RoleLifecycleError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
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

/** The lock is shared by Manager commands and Gateway admission on the same role storage. */
export async function withRoleLock<T>(roleDirectory: string, operation: () => Promise<T>): Promise<T> {
  const locks = path.join(roleStateRoot(roleDirectory), "locks");
  await fs.mkdir(locks, { recursive: true });
  const lock = path.join(locks, path.basename(roleDirectory));
  try { await fs.mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RoleLifecycleError("ROLE_BUSY", "角色正在执行另一项操作，请稍后重试。");
    throw error;
  }
  try { return await operation(); }
  finally { await fs.rmdir(lock); }
}

export async function beginRoleWork(roleDirectory: string): Promise<() => Promise<void>> {
  return withRoleLock(roleDirectory, async () => {
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
