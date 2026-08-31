import { Worker } from "node:worker_threads";
import type { PlanLayoutMigrationResult } from "../roleKnowledge.js";

type WorkerResult =
  | { ok: true; outcome: PlanLayoutMigrationResult }
  | { ok: false; error: string };

export function migrateRolePlanLayoutInWorker(roleDir: string): Promise<PlanLayoutMigrationResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./rolePlanLayoutMigrationWorker.ts"
          : "./rolePlanLayoutMigrationWorker.js",
        import.meta.url
      ),
      {
        workerData: { roleDir },
        execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : []
      }
    );
    let settled = false;
    worker.once("message", (result: WorkerResult) => {
      settled = true;
      if (result.ok) resolve(result.outcome);
      else reject(new Error(result.error));
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`role plan layout migration worker exited with code ${code}`));
      else if (!settled) reject(new Error("role plan layout migration worker exited without a result"));
    });
  });
}
