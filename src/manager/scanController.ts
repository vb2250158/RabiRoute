import type { AgentManagerApiContext } from "../agentAdapters/managerApi.js";
import type { MessageAdapterType } from "../shared/gatewayConfigModel.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";

export type ScanControllerContext = {
  rootDir: string;
  getRuntimes(): Iterable<GatewayRuntime>;
  agentManagerApiContext(): AgentManagerApiContext;
  checkHttpEndpoint(url: string, timeoutMs?: number): Promise<boolean>;
  adapterRuntimes(type: MessageAdapterType): GatewayRuntime[];
};

export class ScanController {
  constructor(readonly ctx: ScanControllerContext) {}

  runtimes(): GatewayRuntime[] {
    return [...this.ctx.getRuntimes()];
  }
}

export type ScanDiagnosticState = "ok" | "timeout" | "error";

export type ScanDiagnostic = {
  state: ScanDiagnosticState;
  durationMs: number;
  message?: string;
};

export type BoundedScanTask<Key extends string, Value> = {
  key: Key;
  run(): Promise<Value> | Value;
  fallback(diagnostic: ScanDiagnostic): Value;
};

type TaskValue<Task> = Task extends BoundedScanTask<string, infer Value> ? Value : never;

type BoundedScanValues<Tasks extends readonly BoundedScanTask<string, unknown>[]> = {
  [Key in Tasks[number]["key"]]: TaskValue<Extract<Tasks[number], { key: Key }>>;
};

type BoundedScanDiagnostics<Tasks extends readonly BoundedScanTask<string, unknown>[]> = {
  [Key in Tasks[number]["key"]]: ScanDiagnostic;
};

export type BoundedScanResult<Tasks extends readonly BoundedScanTask<string, unknown>[]> = {
  values: BoundedScanValues<Tasks>;
  diagnostics: BoundedScanDiagnostics<Tasks>;
  partial: boolean;
  durationMs: number;
  deadlineMs: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts every independent probe immediately and gives them one shared
 * deadline. A stalled or failed probe is replaced with its caller-provided
 * fallback so the control plane can still return the other observations.
 *
 * The deadline bounds the response, not the underlying platform API. Callers
 * should still pass AbortSignals/timeouts to network probes when supported.
 */
export async function runBoundedScans<
  const Tasks extends readonly BoundedScanTask<string, any>[]
>(
  tasks: Tasks,
  options: { deadlineMs: number }
): Promise<BoundedScanResult<Tasks>> {
  const startedAt = Date.now();
  const deadlineMs = Math.max(1, Math.trunc(options.deadlineMs));
  const deadlineAt = startedAt + deadlineMs;

  const settled = await Promise.all(tasks.map(async (task) => {
    const taskStartedAt = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const probe = Promise.resolve()
      .then(() => task.run())
      .then(
        (value) => ({ kind: "value" as const, value }),
        (error) => ({ kind: "error" as const, error })
      );
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
      timeout.unref?.();
    });
    const outcome = await Promise.race([probe, deadline]);
    if (timeout) clearTimeout(timeout);

    const durationMs = Date.now() - taskStartedAt;
    if (outcome.kind === "value") {
      return [task.key, outcome.value, { state: "ok", durationMs } satisfies ScanDiagnostic] as const;
    }
    const diagnostic: ScanDiagnostic = outcome.kind === "timeout"
      ? {
          state: "timeout",
          durationMs,
          message: `Probe exceeded the shared ${deadlineMs} ms scan deadline.`
        }
      : {
          state: "error",
          durationMs,
          message: errorMessage(outcome.error)
        };
    return [task.key, task.fallback(diagnostic), diagnostic] as const;
  }));

  const values: Record<string, unknown> = {};
  const diagnostics: Record<string, ScanDiagnostic> = {};
  for (const [key, value, diagnostic] of settled) {
    values[key] = value;
    diagnostics[key] = diagnostic;
  }

  return {
    values: values as BoundedScanValues<Tasks>,
    diagnostics: diagnostics as BoundedScanDiagnostics<Tasks>,
    partial: Object.values(diagnostics).some((diagnostic) => diagnostic.state !== "ok"),
    durationMs: Date.now() - startedAt,
    deadlineMs
  };
}
