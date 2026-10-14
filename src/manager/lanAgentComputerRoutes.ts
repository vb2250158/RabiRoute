import type http from "node:http";
import type { LanAgentRegistry } from "./lanAgentRegistry.js";

export function handleLanAgentComputerApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, context: {
  registry: LanAgentRegistry;
  authorized: () => boolean;
  readBody: (request: http.IncomingMessage) => Promise<Record<string, unknown>>;
  json: (response: http.ServerResponse, status: number, body: unknown) => void;
}): boolean {
  const match = url.pathname.match(/^\/api\/lan-agent\/instances\/([^/]+)\/computer$/);
  if (!match) return false;
  response.setHeader("cache-control", "no-store");
  if (!context.authorized()) { context.json(response, 401, { code: -1, message: "A verified connection identity is required." }); return true; }
  if (request.method !== "POST") { context.json(response, 405, { code: -1, message: "Use POST for computer operations." }); return true; }
  const instanceId = decodeURIComponent(match[1]!);
  const assertAuthorized = () => { if (!context.authorized()) throw new Error("Connection identity changed; computer operation stopped."); };
  void context.readBody(request).then(async input => {
    assertAuthorized();
    const capability = String(input.action).startsWith("upload.") || ["file.stat", "file.read"].includes(String(input.action)) ? "files"
      : input.action === "windows.list" ? "windows" : input.action === "screen.capture" ? "screenshots" : "";
    const node = context.registry.getNode(instanceId);
    if (!capability || !node?.computerCapabilities?.includes(capability)) throw new Error("Computer capability is unavailable; query the node or update its connector.");
    const data = await context.registry.manageAgent(instanceId, "computer", input, 45000, assertAuthorized);
    assertAuthorized(); context.json(response, 200, { code: 0, data });
  }).catch(error => context.json(response, 400, { code: -1, uncertain: true, message: error instanceof Error ? error.message : String(error) }));
  return true;
}
