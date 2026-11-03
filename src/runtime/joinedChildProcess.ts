import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Completion belongs to the real child close event, including failed spawn and cancellation. */
export function joinChildProcess(child: ChildProcessWithoutNullStreams, options: {
  timeoutMs: number; timeoutError(): Error; stdout?(chunk: string): void; stderr?(chunk: string): void;
}): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    const deadline = setTimeout(() => {
      failure ??= options.timeoutError();
      try { child.kill(); } catch { /* The owner remains joined until close confirms termination. */ }
    }, options.timeoutMs);
    child.stdout.on("data", data => options.stdout?.(data.toString("utf8")));
    child.stderr.on("data", data => options.stderr?.(data.toString("utf8")));
    child.once("error", error => { failure ??= error; });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (failure) reject(failure); else resolve({ code, signal });
    });
  });
}
