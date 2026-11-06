import { createLanAgentTerminalOperations } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentTerminalRoutes.js";
import { createLanAgentComputerOperations } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentComputerRoutes.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseApiPathTemplate } from "../../apps/rabi-agent/lib/api-path-template.mjs";
import { createLanAgentReadOperations } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentReadOperations.js";
import { createLanAgentManagementOperations, type LanAgentRoutesContext } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentRoutes.js";
import { createApiDiscoveryOperations } from "../plugins/io.rabiroute.manager.agent-communication/src/manager/apiDiscoveryRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";

/** Low-level fixtures use the executable owners and the same credential-first ingress as Manager. */
export function handleLanAgentApiFixture(request: IncomingMessage, url: URL, response: ServerResponse, context: LanAgentRoutesContext): boolean {
  // Production ingress authenticates before contract parsing and dispatch.
  const access = context.authority && evaluateLanAgentRequest(request, context.authority, context.enabled?.() === true);
  if (access && access.kind === "denied") {
    context.jsonResponse(response, access.status, { code: -1, error: access.error });
    return true;
  }
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => ({ applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-plugins" }) });
  const definitions = [...createLanAgentReadOperations(context), ...createLanAgentTerminalOperations(context), ...createLanAgentComputerOperations(context),
    ...createLanAgentManagementOperations(context), ...createApiDiscoveryOperations(registry)];
  if (!definitions.some(({ contract }) => parseApiPathTemplate(contract.pathTemplate, contract.request.pathTails).pattern.test(url.pathname))) return false;
  registerLanAgentBodyGuard(request, () => {});
  const registration = registry.registerOperations("fixture", definitions);
  response.once("close", () => { void registration.dispose(); });
  return registry.handle(request, url, response);
}
