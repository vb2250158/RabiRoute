import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RoleLifecycleError } from "@rabiroute/host-api/roleLifecycle";
import { recordDataMutationAudit } from "@rabiroute/host-api/observability/dataMutationAudit";
import { personaReadSettings } from "@rabiroute/host-api/shared/personaReadSettings";

export function assertRoleDocumentQuota(bytes: number): void {
  const quota = personaReadSettings.documentBytes;
  if (quota > 0 && bytes > quota) throw new RoleLifecycleError("ROLE_DOCUMENT_TOO_LARGE", `RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES=${quota} exceeded; increase this Manager setting or set 0 to remove the application quota.`, 413);
}

/** Match the existing persona document reader: an internal file link keeps its real target. */
async function documentTarget(directory: string, allowMissing: boolean): Promise<{ file: string; size?: number }> {
  const roleDirectory = await fs.realpath(directory), canonical = path.join(roleDirectory, "persona.md");
  try { await fs.lstat(canonical); }
  catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return { file: canonical }; throw error; }
  const file = await fs.realpath(canonical);
  if (path.dirname(file) !== roleDirectory) throw new RoleLifecycleError("ROLE_DOCUMENT_INVALID", "角色正文的实际路径超出角色目录。", 403);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new RoleLifecycleError("ROLE_DOCUMENT_INVALID", "角色正文必须指向角色目录中的普通文件。", 400);
  return { file, size: stat.size };
}

export async function readRoleDocument(directory: string): Promise<string> {
  try {
    const target = await documentTarget(directory, false);
    assertRoleDocumentQuota(target.size!);
    const document = await fs.readFile(target.file);
    assertRoleDocumentQuota(document.byteLength);
    return document.toString("utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

export async function atomicRoleDocument(directory: string, document: string, assertCurrent: () => void): Promise<void> {
  assertCurrent();
  const { file } = await documentTarget(directory, true), temporary = `${file}.${randomUUID()}.tmp`;
  assertCurrent();
  try {
    await fs.writeFile(temporary, document, { flag: "wx" });
    const current = await documentTarget(directory, true);
    assertCurrent();
    if (current.file !== file) throw new RoleLifecycleError("ROLE_DOCUMENT_CHANGED", "角色正文指向的文件已变化，请重新读取后保存。", 409);
    await fs.rename(temporary, file);
    recordDataMutationAudit({ group: "persona", event: "role_document_committed", owner: "role-configuration",
      action: "write", target: { type: "role-file", id: "persona.md" }, dataSource: { kind: "file", id: "persona.md" }, outcome: "committed" });
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
