import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { writeGatewayRouteBootSnapshot } from "../shared/gatewayRouteSnapshotBoot.js";

export type GatewayCommandProcessOptions = {
  definition: Readonly<GatewayDefinition>;
  snapshotDirectory: string;
  cwd: string;
  command: string;
  args: readonly string[];
  shell?: boolean | string;
  environment(definition: Readonly<GatewayDefinition>): NodeJS.ProcessEnv;
  cleanupError(error: unknown): void;
};

/** Freeze at admission and retain the file until the actual command process closes. */
export function spawnGatewayCommandProcess(options: GatewayCommandProcessOptions): ChildProcessWithoutNullStreams {
  const boot = writeGatewayRouteBootSnapshot(options.snapshotDirectory, randomUUID(), options.definition);
  const release = () => {
    try { boot.dispose(); }
    catch (error) { options.cleanupError(error); }
  };
  try {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...options.environment(boot.definition),
        RABIROUTE_ROUTE_SNAPSHOT_PATH: boot.filename, RABIROUTE_ROUTE_REVISION: boot.revision },
      shell: options.shell,
      windowsHide: true
    });
    child.once("close", release);
    child.once("error", () => { if (child.pid === undefined) release(); });
    return child;
  } catch (error) {
    release();
    throw error;
  }
}
