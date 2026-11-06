import type { ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { LAN_AGENT_INTERACTIVE_ROUTES, interactiveOperation, type InteractiveContext } from "./lanAgentInteractiveContract.js";

export function createLanAgentComputerOperations(context: InteractiveContext): readonly ApiOperationDefinition[] {
  return LAN_AGENT_INTERACTIVE_ROUTES.filter(route => route.key === "computer.execute").map(route => interactiveOperation(route, context, async (input, guard) => {
    const body = input.body as Record<string, unknown>, instanceId = input.path.instanceId!;
    const capability = String(body.action).startsWith("upload.") || ["file.stat", "file.read"].includes(String(body.action)) ? "files"
      : body.action === "windows.list" ? "windows" : body.action === "screen.capture" ? "screenshots" : "";
    if (!capability || !context.registry.computerCapabilities(instanceId).includes(capability)) throw new Error("Computer capability is unavailable on this platform; query the instance capabilities or update its connector.");
    let data: unknown;
    try { data = await context.registry.manageAgent(instanceId, "computer", body, 45000, guard); }
    catch (error) {
      // Old connectors use an exception for an ordinary missing-upload status read.
      if (body.action !== "upload.status" || !(error instanceof Error)
        || error.message !== "Upload not found; do not create a new ID after an uncertain write.") throw error;
      data = { uploadId: body.uploadId, state: "absent" };
    }
    guard();
    return { status: 200, headers: { "cache-control": "no-store" }, body: { code: 0, data } };
  }));
}
