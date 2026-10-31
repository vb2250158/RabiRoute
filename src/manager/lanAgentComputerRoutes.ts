import type { ApiOperationDefinition } from "./apiOperationContract.js";
import { LAN_AGENT_INTERACTIVE_ROUTES, interactiveOperation, type InteractiveContext } from "./lanAgentInteractiveContract.js";

export function createLanAgentComputerOperations(context: InteractiveContext): readonly ApiOperationDefinition[] {
  return LAN_AGENT_INTERACTIVE_ROUTES.filter(route => route.key === "computer.execute").map(route => interactiveOperation(route, context, async (input, guard) => {
    const body = input.body as Record<string, unknown>, instanceId = input.path.instanceId!;
    const capability = String(body.action).startsWith("upload.") || ["file.stat", "file.read"].includes(String(body.action)) ? "files"
      : body.action === "windows.list" ? "windows" : body.action === "screen.capture" ? "screenshots" : "";
    if (!capability || !context.registry.getNode(instanceId)?.computerCapabilities?.includes(capability)) throw new Error("Computer capability is unavailable; query the node or update its connector.");
    const data = await context.registry.manageAgent(instanceId, "computer", body, 45000, guard); guard();
    return { status: 200, headers: { "cache-control": "no-store" }, body: { code: 0, data } };
  }));
}
