import { Worker } from "node:worker_threads";
import type { MemoryConsolidationScheduleEvaluation } from "./memoryConsolidationScheduler.js";

type WorkerResult =
  | { ok: true; evaluation: MemoryConsolidationScheduleEvaluation }
  | { ok: false; error: string };

export function evaluateMemoryConsolidationSchedule(
  roleDir: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<MemoryConsolidationScheduleEvaluation> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./memoryConsolidationScheduleWorker.js", import.meta.url),
      { workerData: { roleDir } }
    );
    let settled = false;
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      action();
    };
    const abort = (): void => {
      void worker.terminate();
      finish(() => reject(options.signal?.reason ?? new DOMException("Memory schedule evaluation aborted.", "AbortError")));
    };
    const deadline = setTimeout(() => {
      void worker.terminate();
      finish(() => reject(Object.assign(new Error(`Memory schedule evaluation timed out after ${timeoutMs}ms.`), { code: "ETIMEDOUT" })));
    }, timeoutMs);
    deadline.unref?.();
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });

    worker.once("message", (result: WorkerResult) => {
      finish(() => {
        if (result.ok) resolve(result.evaluation);
        else reject(new Error(result.error));
      });
    });
    worker.once("error", (error) => {
      finish(() => reject(error));
    });
    worker.once("exit", (code) => {
      if (settled) return;
      finish(() => {
        if (code !== 0) reject(new Error(`memory consolidation schedule worker exited with code ${code}`));
        else reject(new Error("memory consolidation schedule worker exited without a result"));
      });
    });
  });
}
