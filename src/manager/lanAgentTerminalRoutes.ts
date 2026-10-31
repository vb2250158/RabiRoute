import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";
import { LAN_AGENT_INTERACTIVE_ROUTES, interactiveOperation, type InteractiveContext } from "./lanAgentInteractiveContract.js";
import { openTerminalEventStream } from "./lanAgentTerminalStream.js";

export function createLanAgentTerminalOperations(context: InteractiveContext): readonly ApiOperationDefinition[] {
  return LAN_AGENT_INTERACTIVE_ROUTES.filter(route => route.key.startsWith("terminals.")).map(route => interactiveOperation(route, context, async (input, guard): Promise<ApiOperationResult> => {
    const instanceId = input.path.instanceId!;
    if (instanceId === context.registry.localInstanceId) throw new Error("Select a remote computer.");
    if (route.key === "terminals.events") return { status: 200, headers: { "cache-control": "no-store", "x-accel-buffering": "no" },
      stream: openTerminalEventStream(context.registry.terminals, instanceId, input.path.terminalId!, Number(input.url.searchParams.get("after") || "0"), guard) };
    const data = route.key === "terminals.read"
      ? await context.registry.terminals.read(instanceId, input.path.terminalId!, Number(input.url.searchParams.get("after") || "0"), Number(input.url.searchParams.get("waitMs") || "0"), guard)
      : await context.registry.terminals.execute(instanceId, route.key === "terminals.list" ? { action: "list" } : input.body as Record<string, unknown>, guard);
    return { status: 200, headers: { "cache-control": "no-store" }, body: { code: 0, data } };
  }));
}
