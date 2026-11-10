import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeLayout } from "../shared/runtimeLayout.js";

type HostReply = { ok: boolean; state: string; applicationGenerationId?: string };
type RunHost = (executable: string, arguments_: string[]) => Promise<{ stdout: string }>;

export class DataUpgradeHostRestartError extends Error {
  constructor(message: string, readonly restartDispatched: boolean) { super(message); }
}

/** Delegates an accepted upgrade to the existing generation-fenced Host command. */
export function createDataUpgradeHostRestart(options: Readonly<{
  layout: RuntimeLayout;
  generation: () => string;
  hosted: boolean;
  hostExecutable?: string;
  run?: RunHost;
}>): (operationId: string) => Promise<void> {
  const run: RunHost = options.run ?? ((executable, arguments_) => promisify(execFile)(executable, arguments_, {
    encoding: "utf8", windowsHide: true, timeout: 240_000, maxBuffer: 64 * 1024
  }));
  let submittedOperation: string | undefined;
  let flight: Promise<void> | undefined;

  return operationId => {
    if (submittedOperation !== undefined) {
      if (submittedOperation !== operationId) return Promise.reject(new Error("Another data upgrade already requested this Host restart."));
      return flight!;
    }
    if (!options.hosted) return Promise.reject(new Error("Start RabiRoute through its Host to complete the confirmed data upgrade."));
    const executable = options.hostExecutable?.trim() || path.join(options.layout.stateRoot, "RabiRouteHost.exe");
    if (!path.isAbsolute(executable)) return Promise.reject(new Error("The configured Host executable must be absolute."));
    const generation = options.generation();
    if (!generation) return Promise.reject(new Error("The current application generation is unavailable."));
    submittedOperation = operationId;
    flight = (async () => {
      try {
        const status = JSON.parse((await run(executable, ["--command", "status", "--json"])).stdout) as HostReply;
        if (!status.ok || !["healthy", "degraded"].includes(status.state) || status.applicationGenerationId !== generation) {
          throw new Error("The Host generation changed before the confirmed data upgrade could restart.");
        }
      } catch {
        submittedOperation = undefined;
        flight = undefined;
        throw new DataUpgradeHostRestartError("The current Host could not be verified. No restart was submitted; confirm the upgrade again after checking Host status.", false);
      }
      // The command process belongs to the retiring Manager Job. Its termination is
      // not evidence that Host rejected the request. Startup consumes the durable
      // upgrade receipt, and callers must inspect that receipt instead of retrying.
      let result: HostReply;
      try {
        result = JSON.parse((await run(executable, ["--command", "restart", "--application-generation-id", generation, "--json"])).stdout) as HostReply;
      } catch {
        throw new DataUpgradeHostRestartError("The original Host restart result is uncertain. Inspect the persisted upgrade operation before continuing.", true);
      }
      if (!result.ok) throw new DataUpgradeHostRestartError("The original Host did not confirm the data-upgrade restart. Inspect the upgrade operation before continuing.", true);
    })();
    return flight;
  };
}
