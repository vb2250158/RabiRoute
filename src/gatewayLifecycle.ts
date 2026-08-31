export const GATEWAY_READY_PREFIX = "RABIROUTE_GATEWAY_READY:";

export type GatewayEndpoint = Readonly<{
  id: string;
  transport: "http" | "websocket";
  host: string;
  port: number;
  path?: string;
}>;

export type GatewayReady = Readonly<{
  protocolVersion: 1;
  gatewayId: string;
  gatewayGenerationId: string;
  pid: number;
  readyAt: string;
  endpoints: readonly GatewayEndpoint[];
}>;

function validEndpoint(endpoint: GatewayEndpoint): boolean {
  return Boolean(endpoint.id)
    && (endpoint.transport === "http" || endpoint.transport === "websocket")
    && Boolean(endpoint.host)
    && Number.isInteger(endpoint.port)
    && endpoint.port > 0
    && endpoint.port <= 65_535
    && (endpoint.path === undefined || endpoint.path.startsWith("/"));
}

export function gatewayReadyLine(ready: GatewayReady): string {
  return `${GATEWAY_READY_PREFIX}${JSON.stringify(ready)}`;
}

export function parseGatewayReadyLine(
  line: string,
  expected: Readonly<{ gatewayId: string; gatewayGenerationId: string; pid: number }>
): GatewayReady | null {
  if (!line.startsWith(GATEWAY_READY_PREFIX)) return null;
  let ready: GatewayReady;
  try {
    ready = JSON.parse(line.slice(GATEWAY_READY_PREFIX.length)) as GatewayReady;
  } catch {
    return null;
  }
  if (ready.protocolVersion !== 1
    || ready.gatewayId !== expected.gatewayId
    || ready.gatewayGenerationId !== expected.gatewayGenerationId
    || ready.pid !== expected.pid
    || !Date.parse(ready.readyAt)
    || !Array.isArray(ready.endpoints)
    || !ready.endpoints.every(validEndpoint)) return null;
  return Object.freeze({ ...ready, endpoints: Object.freeze([...ready.endpoints]) });
}
