import { canonicalApiJson } from "@rabiroute/host-api/manager/apiOperationContract";
import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { parseRoleSkillMarkdown, type RoleSkillDetail } from "@rabiroute/host-api/roleKnowledge";
import { atomicRoleJson, roleStateRoot, withRoleLock } from "@rabiroute/host-api/roleLifecycle";
import { isPortableSkillArchiveSegment } from "@rabiroute/host-api/shared/skillArchivePath";
import { recordDataMutationAudit } from "@rabiroute/host-api/observability/dataMutationAudit";
import { preparePersonaResourceAdmission } from "./personaResourceAdmission.js";
import { roleSkillArchiveLimits } from "./roleSkillArchive.js";
import type { RoleSkillReadContext } from "./roleSkillReadRoutes.js";

export type SkillWriteInput = { id?: string; content?: string; files?: Record<string, string>; deleteFiles?: string[] };
export type RoleSkillWriteContext = RoleSkillReadContext & {
  isReadOnly?: () => boolean;
  onSkillsChanged?: (roleId: string, roleDir: string) => void | Promise<void>;
};
type SkillFile = { path: string; size: number; sha256: string };
type Snapshot = { entry: string; root: string; directory: boolean; revision: string; document: string; files: SkillFile[] };
type Receipt = { fingerprint: string; state: "prepared" | "committed"; action: string; destination: string;
  staged: string; backup: string; directory: boolean; beforeRevision?: string; afterRevision: string; result: unknown };

export class RoleSkillWriteError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly field = "body", readonly requestId?: string) { super(message); }
}
const fail = (status: number, code: string, message: string, field?: string): never => { throw new RoleSkillWriteError(status, code, message, field); };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function relativeFile(value: string): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.split("/").some(part => !isPortableSkillArchiveSegment(part))) {
    fail(400, "SKILL_FILE_PATH_INVALID", "Use a portable relative file path inside the selected Skill.", "body.files");
  }
  return value;
}
function skillId(value: unknown): string {
  if (typeof value !== "string" || !isPortableSkillArchiveSegment(value)) fail(400, "SKILL_ID_INVALID", "Use a portable Skill id from the current role catalog.", "skillId");
  return value as string;
}
async function exists(filename: string): Promise<boolean> {
  try { await fs.lstat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function regular(filename: string, directory?: boolean): Promise<void> {
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink() || (directory === true ? !stat.isDirectory() : directory === false ? !stat.isFile() || stat.nlink !== 1 : !stat.isFile() && !stat.isDirectory())) {
    fail(409, "SKILL_SOURCE_UNSAFE", "The selected Skill contains a link or non-regular file.");
  }
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
async function snapshot(root: string, entry: string, directory: boolean): Promise<Snapshot> {
  await regular(root, directory);
  const files: SkillFile[] = [];
  let total = 0;
  async function visit(filename: string, relative: string): Promise<void> {
    await regular(filename);
    const stat = await fs.lstat(filename);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(filename)).sort()) {
        relativeFile(name);
        await visit(path.join(filename, name), relative ? relative + "/" + name : name);
      }
      return;
    }
    await regular(filename, false);
    total += stat.size;
    if (stat.size > roleSkillArchiveLimits.maxFileBytes || total > roleSkillArchiveLimits.maxTotalBytes || files.length >= roleSkillArchiveLimits.maxEntries) {
      fail(413, "SKILL_RESOURCE_TOO_LARGE", "Skill resources exceed the existing Skill archive limits.");
    }
    const bytes = await fs.readFile(filename);
    files.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
  }
  await visit(root, directory ? "" : "SKILL.md");
  const document = await fs.readFile(entry, "utf8");
  return { root, entry, directory, document, files, revision: '"sha256:' + hash(JSON.stringify(files)) + '"' };
}
async function selected(context: RoleSkillReadContext, roleDir: string, id: string, signal: AbortSignal): Promise<{ detail: RoleSkillDetail; snapshot: Snapshot }> {
  const catalog = await context.querySkills(roleDir, undefined, { signal }) as RoleSkillDetail[];
  const matches = catalog.filter(item => item.id === id);
  if (!matches.length) fail(404, "SKILL_NOT_FOUND", "Skill is absent from the selected role catalog.", "skillId");
  if (matches.length > 1) fail(409, "SKILL_ID_CONFLICT", "The selected id belongs to multiple Skill entries. Resolve that catalog item before editing it.", "skillId");
  const detail = matches[0];
  const skills = path.join(roleDir, "skills"), entry = path.resolve(detail.path);
  if (!within(skills, entry)) fail(409, "SKILL_SOURCE_UNSAFE", "The selected Skill is outside its role Skill root.");
  await regular(roleDir, true); await regular(skills, true);
  const directory = path.basename(entry).toLowerCase() === "skill.md";
  const root = directory ? path.dirname(entry) : entry;
  if (directory && path.dirname(root) !== skills || !directory && path.dirname(entry) !== skills) fail(409, "SKILL_SOURCE_UNSAFE", "The selected Skill root is not a direct catalog entry.");
  const source = await snapshot(root, entry, directory);
  const parsed = parseRoleSkillMarkdown(source.document, entry, () => detail.updatedAt);
  if (!parsed || parsed.id !== id) fail(409, "SKILL_SOURCE_CHANGED", "The selected Skill identity changed while reading its source.", "skillId");
  return { detail: parsed!, snapshot: source };
}
function header(request: http.IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) fail(400, "SKILL_REQUEST_HEADER_INVALID", "Supply the request header once.", "headers." + name);
  return typeof value === "string" ? value.trim() : "";
}
async function readReceipt(filename: string): Promise<Receipt | undefined> {
  try { return JSON.parse(await fs.readFile(filename, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** The role owns the lock, original Skill directory, immutable revision and command receipt. */
export function createRoleSkillWriteOwner(context: RoleSkillWriteContext) {
  return { prepare(request: http.IncomingMessage, roleId: string, signal?: AbortSignal) {
    const admission = preparePersonaResourceAdmission(request, signal, context.identity);
    const roleDir = path.resolve(context.roleDirectory(roleId));
    const assertCurrent = () => {
      admission();
      if (path.resolve(context.roleDirectory(roleId)) !== roleDir) fail(409, "SKILL_OWNER_CHANGED", "Original role directory changed. Read the selected role again.");
    };
    const read = async (id: string) => {
      assertCurrent();
      const value = await selected(context, roleDir, skillId(id), signal ?? new AbortController().signal);
      assertCurrent();
      return { ...value.detail, document: value.snapshot.document, files: value.snapshot.files, revision: value.snapshot.revision };
    };
    const operation = async (requestId: string) => {
      assertCurrent();
      const file = path.join(roleStateRoot(roleDir), "operations", "skills", hash(roleDir + "\0" + requestId) + ".json");
      const receipt = await readReceipt(file);
      assertCurrent();
      if (!receipt) fail(404, "SKILL_OPERATION_NOT_FOUND", "The original Skill operation receipt is not present.", "requestId");
      return { requestId, state: receipt!.state, action: receipt!.action,
        mutationOutcome: receipt!.state === "committed" ? "committed" : "unknown", revision: receipt!.afterRevision,
        ...(receipt!.state === "committed" ? { result: receipt!.result } : {}) };
    };
    const mutate = async (action: "create" | "update" | "delete", selectedId: string | undefined, body: SkillWriteInput) => {
      assertCurrent();
      if (context.isReadOnly?.()) fail(409, "SKILL_STORAGE_READ_ONLY", "The current storage owner is in read-only acceptance mode.");
      const id = skillId(action === "create" ? body.id : selectedId);
      const key = header(request, "idempotency-key");
      if (!key) fail(400, "SKILL_REQUEST_ID_REQUIRED", "Supply a stable Idempotency-Key for this Skill command.", "headers.idempotency-key");
      const expected = header(request, "if-match") || header(request, "x-rabiroute-expected-revision");
      if (action !== "create" && !expected) fail(428, "SKILL_REVISION_REQUIRED", "Read the Skill detail and submit its exact ETag with If-Match.", "headers.if-match");
      await regular(roleDir, true);
      const state = roleStateRoot(roleDir), receiptFile = path.join(state, "operations", "skills", hash(roleDir + "\0" + key) + ".json");
      const fingerprint = hash(canonicalApiJson([roleId, action, id, body, expected]));
      return withRoleLock(roleDir, async () => {
        assertCurrent();
        const previous = await readReceipt(receiptFile);
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail(409, "SKILL_REQUEST_CONFLICT", "The same request key already belongs to a different Skill command.");
          if (previous.state === "committed") return previous.result;
          const present = await exists(previous.destination);
          const current = present ? await snapshot(previous.destination, previous.directory ? path.join(previous.destination, "SKILL.md") : previous.destination, previous.directory).catch(() => undefined) : undefined;
          const removedSource = action === "delete" && !present && previous.beforeRevision
            ? await snapshot(previous.backup, previous.directory ? path.join(previous.backup, "SKILL.md") : previous.backup, previous.directory).catch(() => undefined)
            : undefined;
          if (action === "delete" ? removedSource?.revision === previous.beforeRevision && Boolean(previous.beforeRevision) : current?.revision === previous.afterRevision) {
            await atomicRoleJson(receiptFile, { ...previous, state: "committed" });
            return previous.result;
          }
          fail(409, "SKILL_REQUEST_UNCERTAIN", "The original Skill command needs its original receipt and resource checked before another write.");
        }
        const skills = path.join(roleDir, "skills");
        await fs.mkdir(skills, { recursive: true }); await regular(skills, true);
        const found = action === "create" ? undefined : await selected(context, roleDir, id, signal ?? new AbortController().signal);
        if (action === "create" && await context.querySkills(roleDir, id, { signal: signal ?? new AbortController().signal })) fail(409, "SKILL_ALREADY_EXISTS", "The selected Skill id already exists.", "body.id");
        if (found && found.snapshot.revision !== expected) fail(412, "SKILL_REVISION_MISMATCH", "The Skill changed. Read the current detail and merge the intended edit.", "headers.if-match");
        const destination = found?.snapshot.root ?? path.join(skills, id);
        if (action === "create" && await exists(destination)) fail(409, "SKILL_ALREADY_EXISTS", "The selected Skill directory already exists.", "body.id");
        const work = path.join(state, "work", "skills", randomUUID());
        const staged = path.join(work, "next"), backup = path.join(work, "previous");
        await fs.mkdir(work, { recursive: true });
        let moved = false, installed = false, committed = false, receipt: Receipt | undefined;
        try {
          let result: unknown, afterRevision = "missing";
          if (action === "delete") result = { id, deleted: true, revision: found!.snapshot.revision };
          else {
            const directory = found?.snapshot.directory ?? true;
            if (found) await fs.cp(found.snapshot.root, staged, { recursive: directory, errorOnExist: true, force: false });
            else await fs.mkdir(staged);
            const entry = directory ? path.join(staged, "SKILL.md") : staged;
            if (body.content !== undefined) await fs.writeFile(entry, body.content, "utf8");
            if (!await exists(entry)) fail(400, "SKILL_DOCUMENT_REQUIRED", "Provide the complete SKILL.md document.", "body.content");
            if (!directory && (Object.keys(body.files ?? {}).length || body.deleteFiles?.length)) fail(400, "SKILL_DIRECTORY_REQUIRED", "Supporting files require a directory-form Skill.");
            for (const [file, content] of Object.entries(body.files ?? {})) {
              const relative = relativeFile(file);
              if (relative.toLowerCase() === "skill.md") fail(400, "SKILL_DOCUMENT_FIELD_REQUIRED", "Use content for SKILL.md.", "body.files");
              const target = path.join(staged, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, "utf8");
            }
            for (const file of body.deleteFiles ?? []) {
              const relative = relativeFile(file);
              if (relative.toLowerCase() === "skill.md") fail(400, "SKILL_DOCUMENT_REQUIRED", "Delete the Skill itself to remove its entry document.", "body.deleteFiles");
              await fs.rm(path.join(staged, relative), { force: true });
            }
            const raw = await fs.readFile(entry, "utf8"), parsed = parseRoleSkillMarkdown(raw, directory ? path.join(destination, "SKILL.md") : destination, () => new Date().toISOString());
            if (!parsed || parsed.id !== id) fail(400, "SKILL_DOCUMENT_INVALID", "Provide a valid Skill document whose indexed id matches the selected Skill.", "body.content");
            const next = await snapshot(staged, entry, directory); afterRevision = next.revision;
            result = { ...parsed, document: raw, files: next.files, revision: afterRevision };
          }
          if (found) {
            const current = await snapshot(found.snapshot.root, found.snapshot.entry, found.snapshot.directory);
            if (current.revision !== found.snapshot.revision) fail(412, "SKILL_REVISION_MISMATCH", "The Skill changed while preparing the edit. Read its current source and merge the intended change.", "headers.if-match");
          } else if (await exists(destination)) fail(409, "SKILL_ALREADY_EXISTS", "The selected Skill directory was created by another writer.", "body.id");
          receipt = { fingerprint, state: "prepared", action, destination, staged, backup, directory: found?.snapshot.directory ?? true, beforeRevision: found?.snapshot.revision, afterRevision, result };
          assertCurrent(); await atomicRoleJson(receiptFile, receipt, assertCurrent);
          if (found) {
            await fs.rename(destination, backup);
            moved = true;
            const originalEntry = found.snapshot.directory ? path.join(backup, "SKILL.md") : backup;
            const original = await snapshot(backup, originalEntry, found.snapshot.directory);
            if (original.revision !== found.snapshot.revision) {
              fail(412, "SKILL_REVISION_MISMATCH", "The Skill changed before replacement. Read its current source and merge the intended change.", "headers.if-match");
            }
          }
          if (action !== "delete") { await fs.rename(staged, destination); installed = true; }
          await atomicRoleJson(receiptFile, { ...receipt, state: "committed" });
          committed = true;
          recordDataMutationAudit({ group: "skills", event: "role_skill_changed", owner: "role-skill-owner", action,
            target: { type: "skill", id }, dataSource: { kind: "file", id: `roles/${roleId}/skills` }, outcome: "committed", operationId: key,
            ...(found ? { before: { revision: found.snapshot.revision } } : {}), after: { revision: afterRevision } });
          try { await context.onSkillsChanged?.(roleId, roleDir); }
          catch {
            recordDataMutationAudit({ group: "skills", event: "role_skill_projection_failed", owner: "role-skill-owner", action,
              target: { type: "skill", id }, dataSource: { kind: "file", id: `roles/${roleId}/skills` }, outcome: "failed", operationId: key });
            return { ...(result as object), mutationOutcome: "committed", warnings: ["SKILL_CATALOG_REFRESH_FAILED"] };
          }
          return result;
        } catch (error) {
          if (!committed && !installed && moved && !await exists(destination)) {
            try {
              await fs.rename(backup, destination);
              moved = false;
            } catch {
              // The prepared journal still locates both copies for the original request.
            }
          }
          if (!committed && (installed || moved)) {
            throw new RoleSkillWriteError(409, "SKILL_REQUEST_UNCERTAIN",
              "Skill replacement could not be confirmed or restored. Read the original Skill operation receipt before another write.", "requestId", key);
          }
          if (!committed && !installed && !moved && receipt) await fs.rm(receiptFile, { force: true });
          throw error;
        } finally {
          if ((committed && installed) || (!installed && !moved)) await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
        }
      }).catch(error => {
        if (error instanceof RoleSkillWriteError) throw error;
        const status = (error as { status?: number }).status;
        if (status) throw new RoleSkillWriteError(status, "SKILL_OWNER_BUSY", error instanceof Error ? error.message : String(error));
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RoleSkillWriteError(404, "SKILL_SOURCE_NOT_FOUND", "The selected Skill resource is no longer present.");
        throw new RoleSkillWriteError(500, "SKILL_WRITE_FAILED", "Skill storage failed. Keep the original request key and inspect the selected resource before retrying.");
      });
    };
    return { read, operation, mutate };
  }};
}
