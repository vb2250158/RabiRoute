import { roleLifecyclePresentation, RoleLifecycleError, beginRoleWork, type RoleStorageFailureCode } from "../roleLifecycle.js";
import fs from "node:fs";
import path from "node:path";
import { rabiContextManager, type RabiContextResolution, type RabiContextTrigger } from "../context/rabiContextManager.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { roleFolderPath } from "../shared/routePaths.js";
import { readRoleHookPlanCatalog, roleContextInjectionPolicy, type RoleContextInjectionPolicy, type RoleHookPlanCatalog, type RoleMemoryCatalogs } from "../roleKnowledge.js";

export type CodexHookRoleSource = {
  roleId: string;
  roleDir: string;
  persona: string;
  growth: string;
  skills: string;
  contextInjection: RoleContextInjectionPolicy;
};

export type CodexHookContextReadRequest =
  | { kind: "role_source"; rolesRoot: string; roleId: string }
  | { kind: "knowledge"; trigger: RabiContextTrigger; memories?: RoleMemoryCatalogs; plans?: RoleHookPlanCatalog };

export type CodexHookContextReadReply =
  | { kind: "role_source"; source: CodexHookRoleSource }
  | { kind: "knowledge"; resolution: RabiContextResolution };

export type CodexHookRoleStorageFailure = { kind: "role_storage_failure"; code: RoleStorageFailureCode };
export type CodexHookContextWorkerReply = CodexHookContextReadReply | CodexHookRoleStorageFailure;
export type CodexHookKnowledgeBatch = {
  memories: RoleMemoryCatalogs;
  plans: RoleHookPlanCatalog;
  triggers: readonly RabiContextTrigger[];
};
export type CodexHookKnowledgeBatchItem =
  | { result: Extract<CodexHookContextReadReply, { kind: "knowledge" }> }
  | { error: string };

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Physical role reads run in the Manager's bounded read worker, with the same
 * recall, viewedAt and completed-plan policies as the synchronous hook API. */
export function readCodexHookContextInput(input: CodexHookContextReadRequest): CodexHookContextReadReply {
  if (input.kind === "knowledge") {
    const lifecycle = roleLifecyclePresentation(input.trigger.roleDir);
    if (lifecycle.archivedAt || lifecycle.lifecycleError) throw new RoleLifecycleError("ROLE_ARCHIVED_OR_UNAVAILABLE", "角色已归档或状态无法读取，不再附带新上下文。");
    return { kind: "knowledge", resolution: rabiContextManager.resolve(input.trigger) };
  }
  const roleId = sanitizeRoleId(input.roleId);
  if (!roleId) throw new Error("Rabi role ID is invalid.");
  const roleDir = roleFolderPath(input.rolesRoot, roleId);
  if (!fs.existsSync(path.join(roleDir, "persona.md"))) {
    throw new Error(`Rabi role not found: ${roleId}`);
  }
  const lifecycle = roleLifecyclePresentation(roleDir);
  if (lifecycle.archivedAt || lifecycle.lifecycleError) throw new RoleLifecycleError("ROLE_ARCHIVED_OR_UNAVAILABLE", "角色已归档或状态无法读取，不再附带新上下文。");
  return {
    kind: "role_source",
    source: {
      roleId, roleDir,
      persona: readText(path.join(roleDir, "persona.md")),
      growth: readText(path.join(roleDir, "growth.md")),
      skills: readText(path.join(roleDir, "skills.md")),
      contextInjection: roleContextInjectionPolicy(roleDir)
    }
  };
}

/** Physical worker face; keeps synchronous direct-hook consumers on their existing API. */
export async function readCodexHookContextInputAsync(input: CodexHookContextReadRequest): Promise<CodexHookContextReadReply> {
  const directory = input.kind === "knowledge" ? input.trigger.roleDir : roleFolderPath(input.rolesRoot, sanitizeRoleId(input.roleId));
  const release = await beginRoleWork(directory);
  try {
    if (input.kind === "knowledge") return { kind: "knowledge", resolution: await rabiContextManager.resolveAsync(input.trigger, input.memories, input.plans) };
    return readCodexHookContextInput(input);
  } finally { await release(); }
}

export async function readCodexHookPlanCatalog(roleDir: string, archive: boolean): Promise<RoleHookPlanCatalog> {
  const release = await beginRoleWork(roleDir);
  try { return await readRoleHookPlanCatalog(roleDir, archive); }
  finally { await release(); }
}

export async function readCodexHookKnowledgeBatch(batch: CodexHookKnowledgeBatch): Promise<CodexHookKnowledgeBatchItem[]> {
  const roleDir = batch.plans.roleDir;
  if (batch.triggers.some(trigger => path.resolve(trigger.roleDir) !== roleDir || trigger.consolidationInputMemoryIds !== undefined)) {
    throw new Error("Hook batch requires one role with ordinary recall.");
  }
  const release = await beginRoleWork(roleDir);
  try {
    const results: CodexHookKnowledgeBatchItem[] = [];
    for (const trigger of batch.triggers) {
      try {
        const resolution = await rabiContextManager.resolveAsync(trigger, batch.memories, batch.plans);
        if (resolution.knowledge.contextInjection.mode === "focused") {
          // Focused rendering uses only matched read hints. The snapshot revision is already computed.
          const { knowledge } = resolution;
          resolution.knowledge = { ...knowledge, activePlans: [], activeSkills: [], recentMemories: [],
            matchedItems: [], matchedSkills: [] };
        }
        results.push({ result: { kind: "knowledge", resolution } });
      } catch (error) {
        results.push({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  } finally { await release(); }
}
