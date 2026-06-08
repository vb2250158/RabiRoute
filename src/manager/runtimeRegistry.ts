import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";

export type GatewayRuntime = {
  definition: GatewayDefinition;
  process: ChildProcessWithoutNullStreams | null;
  needsRestart: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  lastExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  } | null;
  log: string[];
};

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, GatewayRuntime>();

  values(): GatewayRuntime[] {
    return [...this.runtimes.values()];
  }

  get(id: string): GatewayRuntime | undefined {
    return this.runtimes.get(id);
  }

  keys(): string[] {
    return [...this.runtimes.keys()];
  }

  set(definition: GatewayDefinition, existing?: Partial<GatewayRuntime>): GatewayRuntime;
  set(id: string, runtime: GatewayRuntime): GatewayRuntime;
  set(definitionOrId: GatewayDefinition | string, existingOrRuntime?: Partial<GatewayRuntime> | GatewayRuntime): GatewayRuntime {
    if (typeof definitionOrId === "string") {
      const runtime = existingOrRuntime as GatewayRuntime | undefined;
      if (!runtime) {
        throw new Error(`Missing runtime for ${definitionOrId}`);
      }
      this.runtimes.set(definitionOrId, runtime);
      return runtime;
    }

    const definition = definitionOrId;
    const existing = existingOrRuntime as Partial<GatewayRuntime> | undefined;
    const runtime: GatewayRuntime = {
      definition,
      process: existing?.process ?? null,
      needsRestart: existing?.needsRestart ?? false,
      startedAt: existing?.startedAt ?? null,
      stoppedAt: existing?.stoppedAt ?? null,
      lastExit: existing?.lastExit ?? null,
      log: existing?.log ?? []
    };
    this.runtimes.set(definition.id, runtime);
    return runtime;
  }

  delete(id: string): boolean {
    return this.runtimes.delete(id);
  }

  deleteMissing(seen: Set<string>): GatewayRuntime[] {
    const removed: GatewayRuntime[] = [];
    for (const id of [...this.runtimes.keys()]) {
      if (seen.has(id)) continue;
      const runtime = this.runtimes.get(id);
      if (runtime) removed.push(runtime);
      this.runtimes.delete(id);
    }
    return removed;
  }

  appendLog(runtime: GatewayRuntime, line: string): void {
    const stamped = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${line}`;
    runtime.log.push(stamped);
    if (runtime.log.length > 200) {
      runtime.log.splice(0, runtime.log.length - 200);
    }
  }
}
