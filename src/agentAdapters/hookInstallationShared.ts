import path from "node:path";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

export type HookInstaller = (args: string[]) => Promise<unknown>;
const pending = new Map<string, Promise<{ message: string }>>();

/** Each native platform calls this common audit/dedup boundary with its own installer. */
export function runHookInstallation(rootDir: string, type: string, operation: () => Promise<{ message: string }>): Promise<{ message: string }> {
  const key = `${path.resolve(rootDir)}:${type}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const work = operation().then(result => {
    recordDataMutationAudit({ group: "config", event: "agent_hooks_updated", owner: "agent-hook-installer", action: "update-hooks",
      dataSource: { kind: "file", id: `plugins/rabi-${type}-context` }, target: { type: "agent", id: type }, outcome: "committed" });
    return result;
  }, error => {
    recordDataMutationAudit({ group: "config", event: "agent_hooks_update_failed", owner: "agent-hook-installer", action: "update-hooks",
      dataSource: { kind: "file", id: `plugins/rabi-${type}-context` }, target: { type: "agent", id: type }, outcome: "failed", error });
    throw error;
  }).finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}
