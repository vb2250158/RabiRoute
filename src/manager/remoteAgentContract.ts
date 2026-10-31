import type { ApiOperationContract, ApiSchema } from "./apiOperationContract.js";
import { REMOTE_AGENT_PROTOCOL_VERSION, REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES, REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES } from "../messageEndpoints/remoteAgentProtocol.js";

const text = { type: "string" };
const nativeValue = { description: "Preserves the original Hub's JSON value, String/default conversion or provider extension; named native rules perform business validation." };
const object = (properties: Record<string, ApiSchema>, required: string[] = [], additionalProperties = true): ApiSchema => ({ type: "object", properties, required, additionalProperties });
const device = object({ deviceId: text, deviceName: text, agentType: text, os: text, osVersion: text, arch: text,
  declaredIp: text, defaultCwd: text, defaultThreadName: text, connected: { type: "boolean" }, passwordSaved: { type: "boolean" },
  observedIp: text, host: text, port: { type: ["number", "null"] }, controlUrl: text, discoveryPort: { type: ["number", "null"] },
  protocolVersion: { type: ["number", "null"] }, discoveredAt: text, connectedAt: text, lastSeenAt: text, lastTaskAt: text, connectionError: text }, ["deviceId", "connected"]);
const transfer = object({ name: text, relativePath: nativeValue, path: text, mimeType: nativeValue, size: { type: "integer", minimum: 0 }, sha256: nativeValue }, ["name"]);
const eventProperties = { taskId: nativeValue, status: nativeValue, summary: nativeValue, message: nativeValue, artifactPath: nativeValue,
  logPath: nativeValue, files: nativeValue, savedFiles: nativeValue, error: nativeValue, data: nativeValue, device: nativeValue };
const event = object(eventProperties);
const task = object({ taskId: text, deviceId: text, message: text, taskKind: text, cwd: nativeValue, threadName: nativeValue,
  files: { type: "array", items: transfer }, originGatewayId: text, originReplyContext: nativeValue, status: nativeValue,
  createdAt: text, updatedAt: text, events: { type: "array", items: event } },
  ["taskId", "deviceId", "message", "taskKind", "files", "originGatewayId", "status", "createdAt", "updatedAt", "events"]);
const devices = { type: "array", items: device }, tasks = { type: "array", items: task };
const json = (schema: ApiSchema) => ({ mediaType: "application/json", schema });
const result = (properties: Record<string, ApiSchema>) => json(object({ code: { const: 0 }, ...properties }, ["code", ...Object.keys(properties)], false));
const failure = json(object({ code: { const: -1 }, message: text, uncertain: { type: "boolean" } }, ["code", "message"], false));

export const REMOTE_AGENT_ROUTES = Object.freeze([
  { key: "devices.list", method: "GET", pathTemplate: "/api/remote-agent/devices" },
  { key: "scan", method: "POST", pathTemplate: "/api/remote-agent/scan" },
  { key: "connect", method: "POST", pathTemplate: "/api/remote-agent/connect" },
  { key: "disconnect", method: "POST", pathTemplate: "/api/remote-agent/disconnect" },
  { key: "tasks.list", method: "GET", pathTemplate: "/api/remote-agent/tasks" },
  { key: "tasks.create", method: "POST", pathTemplate: "/api/remote-agent/tasks" },
  { key: "task-events.receive", method: "POST", pathTemplate: "/api/remote-agent/task-events" }
] as const);
for (const route of REMOTE_AGENT_ROUTES) Object.freeze(route);
export type RemoteAgentRoute = typeof REMOTE_AGENT_ROUTES[number];

export function remoteAgentContract(route: RemoteAgentRoute): ApiOperationContract {
  const read = route.method === "GET", scan = route.key === "scan";
  const request = route.key === "connect" ? object({ deviceId: nativeValue, password: nativeValue })
    : route.key === "disconnect" ? { not: { type: "null" }, description: "Non-null JSON; the original endpoint reads String(body.deviceId || empty). Arrays and primitive JSON retain their existing no-target disconnect behavior." }
    : route.key === "task-events.receive" ? event : object({ deviceId: nativeValue, message: nativeValue, text: nativeValue, taskKind: nativeValue,
      cwd: nativeValue, threadName: nativeValue, filePaths: nativeValue, files: nativeValue, attachments: nativeValue,
      originGatewayId: nativeValue, gatewayId: nativeValue, originReplyContext: nativeValue });
  return { operationId: `manager.remote-agent.${route.key}`, contractVersion: "1.0.0", method: route.method,
    ...(["devices.list", "tasks.list", "tasks.create"].includes(route.key) ? { aliases: [`agent:${route.method}:${route.pathTemplate}`] } : {}),
    pathTemplate: route.pathTemplate, description: "Use the existing experimental v3 Remote Agent Hub; its bridge connection and task state remain Hub-owned.", exposure: "public", transport: "http",
    request: { path: object({}, [], false), query: object({}), headers: object({}), body: read ? { kind: "none" }
      : scan ? { kind: "binary", optional: true, allowAnyContentType: true, mediaType: "application/octet-stream", maxBytes: Number.MAX_SAFE_INTEGER,
        rules: ["Scan ignores request bytes and fields. Drain without JSON parsing; use the existing native discovery owner and its timeout."] }
      : { kind: "json", allowAnyContentType: true, emptyValue: {}, maxBytes: Number.MAX_SAFE_INTEGER, schema: request } },
    responses: { [route.key === "tasks.create" || route.key === "task-events.receive" ? "202" : "200"]:
      route.key === "devices.list" || scan ? result({ devices, tasks })
        : route.key === "connect" || route.key === "disconnect" ? result({ device, devices })
        : route.key === "tasks.list" ? result({ tasks }) : result({ task }),
      "400": failure, "403": failure, "500": failure },
    effects: { mode: read ? "read-hub-state" : scan ? "native-device-discovery" : "existing-hub-mutation",
      description: "Connect performs existing mutual HMAC bridge authentication and stores the bridge password in its existing local store. Create dispatches a non-idempotent task, may read local attachments and schedules original conversation callbacks. Events may store returned files and schedule the original callback. All responses prohibit caching; discovery includes no password values." },
    recovery: { strategy: "inspect-hub-history-no-automatic-replay", description: "The legacy Hub has no durable idempotency key and its task/history maps are in memory. Retain returned taskId, device and originating gateway; query devices/tasks after uncertainty. HTTP 202 for create means socket dispatch, not remote completion. Do not automatically repeat creates, connects or event writes, or claim a process restart preserves task receipts." },
    validators: [
      { id: "remote-agent.shared-ingress", description: "Use the original public Manager connection policy, including authenticated remote connections with no persona/Agent registration grant. Revalidate the original admission before native dispatch/publication and after awaited work." },
      { id: "remote-agent.v3-native-owner", description: `Original discovery selects observed bridge addresses. Protocol ${REMOTE_AGENT_PROTOCOL_VERSION} requires nonce challenge, mutual HMAC-SHA256 proofs and matching deviceId before password persistence. Gateway defaults, actual device ownership, terminal-event repeats, task status extensions and callback lifetime remain native-owned.` },
      { id: "remote-agent.native-json-and-files", description: `Preserve native String/default conversions and JSON extension fields instead of inferring runtime rules from TypeScript. Only native arrays participate in file transfer. Existing decoded-file limits are ${REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES} bytes per file and ${REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES} total (a nonpositive limit retains its native disabled-limit meaning). Native owners determine file paths, checksums, stored metadata and returned-file placement.` },
      { id: "remote-agent.history-window", description: "Device/scan responses retain the latest 20 Hub tasks, task listing the latest 100. Queries are otherwise ignored. This bounded in-memory view cannot prove the outcome of every uncertain historical write." }
    ] };
}
