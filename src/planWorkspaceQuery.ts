import path from "node:path";
import type { RolePlanPageReadInput } from "./manager/managerReadWorkerPool.js";

/** Session identities supplied by the owning Agent host, never inferred from a title. */
export type PlanBindingScope = { agentType: string; workspace: string; sessionIds: string[] };

/** Canonical absolute workspace identity across Windows and POSIX hosts. */
export function planWorkspaceIdentity(value: string): string {
  let text = value.trim().replaceAll("\\", "/");
  if (text.startsWith("//?/UNC/")) text = "//" + text.slice(8);
  else if (text.startsWith("//?/")) text = text.slice(4);
  if (/^[a-z]:\//i.test(text) || text.startsWith("//")) {
    const normalized = path.win32.normalize(text).replaceAll("\\", "/").toLowerCase();
    return /^[a-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/$/, "");
  }
  return text.startsWith("/") ? path.posix.normalize(text).replace(/\/$/, "") || "/" : "";
}

/** Validate the read-only POST form of the shared WebGUI plan query. */
export function parseWorkspacePlanQuery(value: unknown): RolePlanPageReadInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plan query.");
  const input = value as Record<string, unknown>;
  const scope = input.bindingScope as Partial<PlanBindingScope> | undefined;
  if (!scope || typeof scope.agentType !== "string" || !scope.agentType.trim() || typeof scope.workspace !== "string" || !planWorkspaceIdentity(scope.workspace) || !Array.isArray(scope.sessionIds) || scope.sessionIds.some(id => typeof id !== "string" || !id.trim())) throw new Error("Invalid plan binding scope.");
  const strings = (key: string): string[] => {
    const list = input[key] ?? [];
    if (!Array.isArray(list) || list.some(item => typeof item !== "string")) throw new Error("Invalid " + key);
    return list;
  };
  const sort = input.sort ?? "status";
  if (!["status", "updated", "importance", "urgency"].includes(String(sort))) throw new Error("Invalid plan sort.");
  const view = input.view;
  if (view !== undefined && !["current", "plans", "archived"].includes(String(view))) throw new Error("Invalid plan view.");
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 250) throw new Error("Invalid plan limit.");
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || !/^\d*$/.test(input.cursor))) throw new Error("Invalid plan cursor.");
  if (input.query !== undefined && typeof input.query !== "string") throw new Error("Invalid plan query text.");
  return { cursor: String(input.cursor ?? ""), limit: Number(limit), query: String(input.query ?? ""),
    sort: sort as RolePlanPageReadInput["sort"], view: view as RolePlanPageReadInput["view"], statuses: strings("statuses"), tags: strings("tags"), summary: true, includeFacets: true,
    bindingScope: { agentType: scope.agentType, workspace: planWorkspaceIdentity(scope.workspace), sessionIds: [...new Set(scope.sessionIds)] } };
}
