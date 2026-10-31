import type { RecentMemoryCatalogRead } from "../roleKnowledge.js";
import { buildCompanionContext } from "./companionContext.js";
import { managerMemoryCatalogWorkerPool, type ManagerReadWorkerPool } from "./managerReadWorkerPool.js";

const issueSignatures = new Map<string, string>();

/** Reads only companionship dependencies, independently of plan recovery and knowledge publication. */
export async function readCompanionContext(
  input: Omit<Parameters<typeof buildCompanionContext>[0], "recentMemories">,
  options: {
    pool?: Pick<ManagerReadWorkerPool, "run">;
    assertCurrent?: () => void;
    onIssues?: (issues: RecentMemoryCatalogRead["issues"]) => void;
  } = {}
): Promise<string> {
  options.assertCurrent?.();
  try {
    const catalog = await (options.pool ?? managerMemoryCatalogWorkerPool).run<RecentMemoryCatalogRead>({
      type: "role_recent_memory_catalog", roleDir: input.roleDirectory
    });
    options.assertCurrent?.();
    const signature = JSON.stringify([...catalog.issues].sort((a, b) => a.file.localeCompare(b.file)));
    if (catalog.issues.length) {
      if (issueSignatures.get(input.roleDirectory) !== signature) {
        options.onIssues?.(catalog.issues);
        issueSignatures.set(input.roleDirectory, signature);
      }
    } else issueSignatures.delete(input.roleDirectory);
    const result = await buildCompanionContext({ ...input, recentMemories: catalog.memories });
    options.assertCurrent?.();
    return result;
  } catch (error) {
    options.assertCurrent?.();
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), {
      code: "COMPANION_CONTEXT_FAILED"
    });
  }
}
