import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import type { PluginCandidate, PluginExecutionMode, PluginIdentity, PluginModule } from "./types.js";

export type PluginExecutor = Readonly<{
  prepare(candidate: PluginCandidate, identity: PluginIdentity): Promise<PluginModule>;
}>;

function validateModule(value: unknown, candidate: PluginCandidate): PluginModule {
  if (!value || typeof value !== "object" || typeof (value as { activate?: unknown }).activate !== "function") {
    throw new Error(`Plugin ${candidate.manifest.id} ${candidate.entry.execution} entry must export activate(context).`);
  }
  return Object.freeze({ activate: (value as PluginModule).activate });
}

export class InProcessPluginExecutor implements PluginExecutor {
  async prepare(candidate: PluginCandidate, _identity: PluginIdentity): Promise<PluginModule> {
    if (candidate.entry.execution !== "in_process") {
      throw new Error(`Plugin execution mode requires a configured executor: ${candidate.entry.execution}.`);
    }
    return validateModule(await import(pathToFileURL(candidate.entry.path).href), candidate);
  }
}

export class DeclarativePluginExecutor implements PluginExecutor {
  async prepare(candidate: PluginCandidate, _identity: PluginIdentity): Promise<PluginModule> {
    if (candidate.entry.execution !== "declarative") {
      throw new Error(`DeclarativePluginExecutor cannot execute ${candidate.entry.execution} plugins.`);
    }
    const parsed = JSON.parse(await fs.readFile(candidate.entry.path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Declarative plugin resource must be an object.");
    const raw = parsed as Record<string, unknown>;
    const unknown = Object.keys(raw).filter(key => key !== "contributions");
    if (unknown.length || !Array.isArray(raw.contributions)) throw new Error("Declarative plugin resource must contain only a contributions array.");
    const contributions = structuredClone(raw.contributions);
    return Object.freeze({ activate(context) {
      for (const value of contributions) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Declarative plugin contribution must be an object.");
        const contribution = value as Record<string, unknown>;
        if (typeof contribution.kind !== "string" || typeof contribution.id !== "string") {
          throw new Error("Declarative plugin contribution requires kind and id.");
        }
        context.contributions.register({ kind: contribution.kind, id: contribution.id, value: contribution.value });
      }
    } });
  }
}

export class RoutingPluginExecutor implements PluginExecutor {
  readonly #executors: Readonly<Partial<Record<PluginExecutionMode, PluginExecutor>>>;
  constructor(executors: Partial<Record<PluginExecutionMode, PluginExecutor>>) {
    this.#executors = Object.freeze({ ...executors });
  }
  prepare(candidate: PluginCandidate, identity: PluginIdentity): Promise<PluginModule> {
    const executor = this.#executors[candidate.entry.execution];
    if (!executor) throw new Error(`Plugin execution mode is not configured: ${candidate.entry.execution}.`);
    return executor.prepare(candidate, identity);
  }
}

export function createBuiltinPluginExecutor(): PluginExecutor {
  return new RoutingPluginExecutor({
    in_process: new InProcessPluginExecutor(),
    declarative: new DeclarativePluginExecutor()
  });
}
