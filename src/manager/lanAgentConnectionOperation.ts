import { getTimeoutMs } from "../shared/timeoutSettings.js";
import type { ApiUpgradeDefinition } from "./apiOperationContract.js";
import type { LanAgentRegistry } from "./lanAgentRegistry.js";

export const LAN_AGENT_WEBSOCKET_LIMITS = Object.freeze({ maxMessageBytes: 100 * 1024 * 1024,
  maxBufferedBytes: 200 * 1024 * 1024, get authenticationMs() { return getTimeoutMs("agent.remote.authentication", 10_000); }, get closeGraceMs() { return getTimeoutMs("agent.remote.closeGrace", 2000); } });
export type LanAgentConnectionOptions = { getToken(): string; enabled(): boolean };

export function createLanAgentConnectionOperation(registry: LanAgentRegistry, options: LanAgentConnectionOptions) {
  const nativeField = { description: "Validated by the original connection state machine; protocol/business errors retain their original replies." };
  const failure = { mediaType: "application/json", schema: { type: "object", required: ["code", "message"],
    properties: { code: { const: -1 }, message: { type: "string" } }, additionalProperties: false } };
  return { contract: { operationId: "manager.lan-agent.connect", contractVersion: "1.1.0", method: "GET", pathTemplate: "/api/lan-agent/connect",
    description: "Connect the existing LAN Agent transport and authenticate in its first native message.", exposure: "public", transport: "websocket",
    request: { path: { type: "object", additionalProperties: false }, query: { type: "object", additionalProperties: true },
      headers: { type: "object", additionalProperties: true }, body: { kind: "none" } },
    websocket: { protocol: "rabiroute.lan-agent.native-v1", framing: "json", ...LAN_AGENT_WEBSOCKET_LIMITS,
      incomingSchema: { type: "object", additionalProperties: true, properties: Object.fromEntries([
        "type", "token", "node", "agents", "requestId", "result", "error", "taskId", "eventId", "status", "summary", "event"
      ].map(name => [name, nativeField])) },
      outgoingSchema: { type: "object", required: ["type"], properties: { type: { type: "string" } }, additionalProperties: true },
      authentication: "The existing enabled switch and first authenticate/token message, then hello/node metadata, own admission. No HTTP-only identity or Agent/persona registration is added. Native credentials are rechecked by the existing message owner.",
      completion: "The socket close event and native connection cleanup complete the activation lease; accepted HTTP commands drain before this transport retires.",
      cancellation: "Retirement stops new upgrades, then closes owned sockets with code 1001 and terminates peers after the native close grace. It never replays tasks or creates an alternate Agent runtime." },
    responses: { "101": { mediaType: "application/octet-stream", schema: false, headers: {
      type: "object", required: ["upgrade", "connection", "sec-websocket-accept"], additionalProperties: true,
      properties: { upgrade: { const: "websocket" }, connection: { const: "Upgrade" }, "sec-websocket-accept": { type: "string", pattern: "^[A-Za-z0-9+/]{27}=$" } }
    } }, "401": failure,
      "400": { ...failure, alternatives: [{ mediaType: "text/html", schema: { type: "string" } }] } },
    effects: { mode: "native-agent-connection", description: "The existing registry owns authentication, hello, Agent catalogs, terminal events, management results, task acceptance/results and update status. Task state and credentials remain with their original owners." },
    recovery: { strategy: "reconnect-original-node-without-replay", description: "Rediscover the Manager and reconnect using the original computer credential. Resubmit a retained taskResult with its original eventId; Manager persists the result before resultAck and deduplicates across restarts. Reconnection and catalog changes never replay commands or task assignments." },
    validators: [{ id: "lan-agent.websocket.native-state-machine", description: "JSON object framing is shared with native parsing; authenticate, hello, heartbeat, agentCatalog, managementResult, terminalEvent, ackTask/progress/taskResult and updateResult keep their original stateful field/ownership/error rules. Unknown messages receive the native error; native ws validates handshake headers and rejects invalid JSON/oversize frames." },
      { id: "lan-agent.websocket.capacity", description: "The original ws default 100 MiB message bound is explicit; outgoing buffered bytes are bounded at 200 MiB. First authentication expires at ten seconds. These are shared transport capacities, not feature permissions." }] },
    handler: input => registry.upgradeConnection(input, options) } satisfies ApiUpgradeDefinition;
}
