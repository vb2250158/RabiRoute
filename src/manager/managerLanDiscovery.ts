import type http from "node:http";

export const MANAGER_DISCOVERY_PATH = "/.well-known/rabiroute-manager";
export const MANAGER_DISCOVERY_SERVICE_TYPE = "rabiroute";
export const MANAGER_DISCOVERY_PROTOCOL_VERSION = 1;

export type ManagerLanDiscoveryDocument = Readonly<{
  protocolVersion: 1;
  applicationGenerationId: string;
  managerInstanceId: string;
  guid: string;
  name: string;
  computerName: string;
  deviceType: "RabiRoute Manager";
  version: string;
}>;

export function handleManagerLanDiscoveryRequest(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  options: Readonly<{
    enabled: boolean;
    document: () => ManagerLanDiscoveryDocument;
    jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  }>
): boolean {
  if (requestUrl.pathname !== MANAGER_DISCOVERY_PATH) return false;
  response.setHeader("cache-control", "no-store");
  if (!options.enabled) {
    options.jsonResponse(response, 404, { code: -1, message: "Manager LAN discovery is disabled." });
    return true;
  }
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    options.jsonResponse(response, 405, { code: -1, message: "method not allowed" });
    return true;
  }
  options.jsonResponse(response, 200, { code: 0, data: options.document() });
  return true;
}
