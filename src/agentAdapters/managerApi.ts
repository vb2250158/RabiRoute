import type { AgentScanOptions, AgentManagerApiContext, AgentScanResult } from "./managerTypes.js";
export type * from "./managerTypes.js";

/** Transitional source compatibility for tests; production API uses published provider operations. */
export async function scanDshAgentAdapter(ctx: AgentManagerApiContext, options: AgentScanOptions = {}) {
  return (await import("./dshManagerApi.js")).scanDshAgentAdapter(ctx, options);
}
export async function scanGrokBotAgentAdapter(ctx: AgentManagerApiContext, options: AgentScanOptions = {}) {
  return (await import("./grokBotManagerApi.js")).scanGrokBotAgentAdapter(ctx, options);
}
export async function getCopilotStatus(ctx: AgentManagerApiContext) {
  return (await import("./copilotManagerApi.js")).getCopilotStatus(ctx);
}
export async function testAstrbotLogin(request: import("./managerTypes.js").AstrbotLoginTestRequest) {
  return (await import("./astrbotManagerApi.js")).testAstrbotLogin(request);
}
export async function openMarvis(ctx: AgentManagerApiContext, request: import("./managerTypes.js").MarvisOpenRequest) {
  return (await import("./marvisManagerApi.js")).openMarvis(ctx, request);
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Explicit scans settle independently; the worker owner retains concurrency and cancellation limits. */
export async function scanAgentAdapters(ctx: AgentManagerApiContext, options: AgentScanOptions = {}): Promise<Record<string, unknown>> {
  if (!ctx.providers) throw new Error("Scanning requires the current native Agent provider graph.");
  ctx.scanSignal?.throwIfAborted();
  const providers = ctx.providers;
  const settled = await Promise.allSettled(providers.map(provider => provider.invoke<Record<string, unknown>>(
    "scan", options, { signal: ctx.scanSignal }
  )));
  ctx.scanSignal?.throwIfAborted();
  const agents: Record<string, AgentScanResult> = {};
  const cwdOptions = new Set<string>();
  const extras: Record<string, unknown> = {};
  for (const [index, outcome] of settled.entries()) {
    const provider = providers[index]!;
    try {
      if (outcome.status === "rejected") throw outcome.reason;
      const result = outcome.value;
      const row = object(result) && object(result.agents) ? result.agents[provider.type] : undefined;
      if (!object(row) || row.type !== provider.type || typeof row.installed !== "boolean") {
        throw new Error("Agent scanner returned invalid metadata for its own type.");
      }
      agents[provider.type] = row as AgentScanResult;
      if (Array.isArray(result.cwdOptions)) {
        for (const value of result.cwdOptions) if (typeof value === "string") cwdOptions.add(value);
      }
      for (const [key, value] of Object.entries(result)) {
        if (key === "agents" || key === "cwdOptions") continue;
        // Shared arrays are unions. Provider-specific totals/pages remain inside its own row.
        if (Array.isArray(value)) {
          const previous = Array.isArray(extras[key]) ? extras[key] as unknown[] : [];
          extras[key] = [...new Set([...previous, ...value])];
        } else if (!(key in extras)) extras[key] = value;
      }
    } catch (error) {
      agents[provider.type] = {
        ...provider.manifest,
        installed: false,
        warnings: [error instanceof Error ? error.message : "Agent owner is unavailable."]
      } as AgentScanResult;
    }
  }
  const legacy = {
    threadNames: extras.threadNames ?? [], cwdOptions: [...cwdOptions],
    copilotSessions: extras.copilotSessions ?? [], copilotBins: extras.copilotBins ?? [], marvisAppIds: extras.marvisAppIds ?? []
  };
  return { ...extras, ...legacy, agents, legacy };
}
