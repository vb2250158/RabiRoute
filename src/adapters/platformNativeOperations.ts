import { createHash } from "node:crypto";
import type { ApiHttpProxyDefinition, ApiUpgradeDefinition, ApiOperationContract } from "../manager/apiOperationContract.js";
import type { ApiExternalListenerDefinition } from "../manager/apiExternalListenerBinding.js";

const object = { type: "object", additionalProperties: true };
const path = { type: "object", required: ["nativePath"], properties: { nativePath: { type: "string" } }, additionalProperties: false };

const napcatId = (instanceId: string, port: number) => `gateway.napcat.${createHash("sha256").update(instanceId).digest("hex").slice(0, 24)}.${port}.events`;
const feishuId = (port: number) => `gateway.feishu.${port}.callback`;

export function feishuListenerBinding(port: number, hostname = "127.0.0.1"): ApiExternalListenerDefinition {
  const addressHost = ["0.0.0.0", "::", "[::]"].includes(hostname) ? undefined
    : new URL(`http://${hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname}`).hostname;
  return { listenerId: feishuId(port), address: { protocol: "http", port,
    ...(addressHost ? { hostname: addressHost } : {}) },
    protocol: "feishu-events-v2", invocation: "discovery-only", authentication: { kind: "native",
      description: "Original Feishu Verification Token and raw-body timestamp/nonce/Encrypt Key signature; URL verification uses the original token-only challenge. Manager and node bearer tokens do not authenticate this platform callback." } };
}

export function napcatListenerBinding(instanceId: string, port: number): ApiExternalListenerDefinition {
  return { listenerId: napcatId(instanceId, port),
    address: { protocol: "http", hostname: "127.0.0.1", port }, protocol: "onebot-v11-reverse-websocket",
    invocation: "discovery-only", authentication: { kind: "none",
      description: "Original loopback-only reverse WebSocket listener; no path filter, verifyClient or inbound password. The instance Access Token belongs to outbound OneBot HTTP and is never forwarded to this listener." } };
}

/** Native listeners use the common executable registry while retaining their complete URL space. */
export function createFeishuNativeOperations(handler: ApiHttpProxyDefinition["handler"], webhookPath: string, port: number, operationId = feishuId(port)): readonly ApiHttpProxyDefinition[] {
  return [{ contract: { operationId, contractVersion: "1.0.0", method: "*", pathTemplate: "/:nativePath",
    exposure: "public", transport: "http",
    description: `Feishu native callback. Only POST with URL.pathname exactly equal to ${JSON.stringify(webhookPath)} is accepted; other native requests return 404. No path normalization or Manager authentication is introduced.`,
    request: { path, pathRemainder: "nativePath", query: object, headers: object, body: { kind: "passthrough" } },
    httpProxy: { wire: { dataFrameBytes: 1024 * 1024, streamWindowBytes: 1024 * 1024, maxConcurrentStreams: Number.MAX_SAFE_INTEGER },
      completion: "Original raw-body parser, accepted callback and native response complete before release. The Feishu parser owns its 1 MiB body bound; the registry introduces no concurrency cap.",
      cancellation: "Closing the listener aborts incomplete requests and joins accepted callback promises; no retry." },
    responses: { default: { mediaType: "*/*", passthrough: true } },
    effects: { mode: "platform-event", description: "Original app identity, chat/message/event mapping, durable event-id deduplication and forwarding callback own accepted effects." },
    recovery: { strategy: "native-event-id", description: "Reconcile the original Feishu event_id; never manufacture another event identity or automatically replay platform events." },
    validators: [{ id: "feishu.native-callback", description: "1 MiB raw body limit, original status/disposition, five-minute signature window, token, optional AES-256-CBC and token-only URL challenge remain owned by Feishu." }] }, handler }];
}

export function createNapCatNativeOperations(instanceId: string, port: number, handler: ApiUpgradeDefinition["handler"], maxPayload = 100 * 1024 * 1024, operationId = napcatId(instanceId, port)): readonly ApiUpgradeDefinition[] {
  const contract: ApiOperationContract = { operationId,
    contractVersion: "1.0.0", method: "GET", pathTemplate: "/:nativePath", exposure: "public", transport: "websocket",
    description: "Original OneBot reverse WebSocket server on this instance's loopback port; any upgrade pathname is accepted. The native ws implementation validates handshake and frames.",
    request: { path, pathRemainder: "nativePath", query: object, headers: object, body: { kind: "none" } },
    websocket: { protocol: "onebot-v11-reverse-websocket", framing: "bytes", maxMessageBytes: maxPayload || Number.MAX_SAFE_INTEGER,
      maxBufferedBytes: Number.MAX_SAFE_INTEGER, authentication: "Original loopback listener with no inbound password; Manager bearer and outbound OneBot HTTP token are not used.",
      completion: "Hold the accepted session through actual socket close and every accepted frame/profile callback; listener close waits for native HTTP/WS server callbacks.",
      cancellation: "Retirement stops upgrades, terminates accepted native sockets and waits for all accepted callback promises. No automatic frame replay." },
    responses: { "101": { mediaType: "application/octet-stream", schema: false }, default: { mediaType: "application/json", schema: true } },
    effects: { mode: "platform-event", description: "Original per-instance group/private event mapper and instance-selected OneBot HTTP endpoint own effects." },
    recovery: { strategy: "inspect-native-event", description: "Inspect original message/event identity and platform receipt before any retry; no Manager-level retry or new idempotency identity." },
    validators: [{ id: "napcat.native-ws", description: "Keep ws native handshake, runtime maxPayload (default 100 MiB) and frame codec. No additional application buffering cap, JSON schema or authentication grant is introduced." }] };
  return [{ contract, handler }];
}
