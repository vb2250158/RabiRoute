import { roleLifecyclePresentation, RoleLifecycleError, beginRoleWork } from "../roleLifecycle.js";
import fs from "node:fs";
import path from "node:path";
import { rabiContextManager, type RabiContextResolution, type RabiContextTrigger } from "../context/rabiContextManager.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { roleFolderPath } from "../shared/routePaths.js";
import type { RoleMemoryCatalogs } from "../roleKnowledge.js";

export type CodexHookRoleSource = {
  roleId: string;
  roleDir: string;
  persona: string;
  growth: string;
  skills: string;
};

export type CodexHookContextReadRequest =
  | { kind: "role_source"; rolesRoot: string; roleId: string }
  | { kind: "knowledge"; trigger: RabiContextTrigger; memories?: RoleMemoryCatalogs };

export type CodexHookContextReadReply =
  | { kind: "role_source"; source: CodexHookRoleSource }
  | { kind: "knowledge"; resolution: RabiContextResolution };

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
      skills: readText(path.join(roleDir, "skills.md"))
    }
  };
}

/** Physical worker face; keeps synchronous direct-hook consumers on their existing API. */
export async function readCodexHookContextInputAsync(input: CodexHookContextReadRequest): Promise<CodexHookContextReadReply> {
  const directory = input.kind === "knowledge" ? input.trigger.roleDir : roleFolderPath(input.rolesRoot, sanitizeRoleId(input.roleId));
  const release = await beginRoleWork(directory);
  try {
    if (input.kind === "knowledge") return { kind: "knowledge", resolution: await rabiContextManager.resolveAsync(input.trigger, input.memories) };
    return readCodexHookContextInput(input);
  } finally { await release(); }
}
