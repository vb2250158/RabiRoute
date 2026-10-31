import { validateInternalManagerHop } from "../shared/internalManagerHop.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";

export const DEVICE_PEER_BOOTSTRAP_PATH = "/api/rabilink/peer/device-bootstrap";
export const DEVICE_PEER_LEASE_MS = 45_000;

export type DevicePeerBootstrapAuthority = Readonly<{
  sourceDeviceId: string;
  scope: string;
  issuedAt: number;
  assertCurrent(): void;
}>;
export type DevicePeerBootstrapOptions = {
  current(): { scope: string; generation: string; deviceId: string };
  bootstrap(input: unknown, authority: DevicePeerBootstrapAuthority): Promise<unknown>;
};

/** Device credentials reach this route only through the authenticated Relay HTTP owner. */
export function createDevicePeerBootstrapOperation(options: DevicePeerBootstrapOptions) {
  let stopped = false;
  const reply = (status: number, body: unknown): ApiOperationResult => ({ status, body, headers: { "cache-control": "no-store" } });
  const failure = (status: number) => reply(status, { code: -1, error: status === 400 ? "DEVICE_PEER_BOOTSTRAP_INVALID" : "DEVICE_PEER_BOOTSTRAP_DENIED" });
  const prepare: NonNullable<ApiOperationDefinition["prepare"]> = ({ request, signal }) => {
    try {
      if (stopped) throw new Error("Device bootstrap owner stopped.");
      const initial = { ...options.current() };
      if (!initial.scope || !initial.generation || !initial.deviceId || !hasAuthenticatedConnectionRequest(request)) {
        throw new Error("Unadmitted device connection.");
      }
      const claims = validateInternalManagerHop(request, initial);
      if (!claims || claims.kind !== "relay" || !/^glasses-[a-f0-9]{16}$/.test(claims.deviceId)
        || !Number.isSafeInteger(claims.authenticatedAt) || typeof claims.authenticatedAt !== "number") {
        throw new Error("A current Relay device credential is required.");
      }
      const authenticatedAt = claims.authenticatedAt;
      const assertCurrent = () => {
        signal?.throwIfAborted();
        const current = options.current();
        if (stopped || current.scope !== initial.scope || current.generation !== initial.generation || current.deviceId !== initial.deviceId
          || !hasAuthenticatedConnectionRequest(request)) throw new Error("Original connection changed.");
        const fresh = validateInternalManagerHop(request, initial);
        if (!fresh || fresh.kind !== "relay" || fresh.deviceId !== claims.deviceId || fresh.nonce !== claims.nonce) {
          throw new Error("Original Relay device identity changed.");
        }
      };
      assertCurrent();
      return async input => {
        let status = 403;
        try {
          assertCurrent();
          const body = input.body;
          status = 400;
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid device bootstrap.");
          const fields = body as Record<string, unknown>;
          if (fields.source !== claims.deviceId || fields.target !== initial.deviceId
            || !Number.isSafeInteger(fields.expiresAt) || typeof fields.expiresAt !== "number"
            || fields.expiresAt <= Date.now() || fields.expiresAt > authenticatedAt + DEVICE_PEER_LEASE_MS
            || typeof fields.nonce !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(fields.nonce)) {
            throw new Error("Device identity or absolute lease is invalid.");
          }
          const expiresAt = fields.expiresAt;
          status = 403;
          const assertLease = () => {
            assertCurrent();
            if (Date.now() >= expiresAt) throw new Error("Original device lease expired.");
          };
          const authority: DevicePeerBootstrapAuthority = Object.freeze({ sourceDeviceId: claims.deviceId,
            scope: initial.scope, issuedAt: authenticatedAt, assertCurrent: assertLease });
          assertLease();
          const data = await options.bootstrap(body, authority);
          assertLease();
          return reply(200, { code: 0, data });
        } catch {
          signal?.throwIfAborted();
          return failure(status);
        }
      };
    } catch {
      signal?.throwIfAborted();
      return failure(403);
    }
  };
  const operation: ApiOperationDefinition = {
    contract: {
      operationId: "manager.rabilink.peer.device-bootstrap", contractVersion: "1.0.0", method: "POST", pathTemplate: DEVICE_PEER_BOOTSTRAP_PATH,
      description: "Grant a signed device connection using the original Relay device credential and its absolute 45-second authority lease.", exposure: "public", transport: "http",
      request: { path: { type: "object", additionalProperties: false }, query: { type: "object" }, headers: { type: "object" },
        body: { kind: "json", schema: { type: "object", additionalProperties: true, properties: {
          source: { type: "string" }, target: { type: "string" }, publicKey: { type: "string" }, expiresAt: { type: "integer" }, nonce: { type: "string" }, signature: { type: "string" }
        } }, maxBytes: 0, allowAnyContentType: true, emptyValue: {} } },
      responses: {
        "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], additionalProperties: false,
          properties: { code: { const: 0 }, data: { type: "object", required: ["sourceDeviceId", "deviceId", "publicKey", "generation", "managerGeneration", "expiresAt", "epoch"], additionalProperties: false, properties: {
            sourceDeviceId: { type: "string" }, deviceId: { type: "string" }, publicKey: { type: "string" }, generation: { type: "string" }, managerGeneration: { type: "string" }, expiresAt: { type: "integer" }, epoch: { type: "string" }
          } } } } },
        ...Object.fromEntries([400, 403].map(status => [status, { mediaType: "application/json", schema: { type: "object", required: ["code", "error"], additionalProperties: false,
          properties: { code: { const: -1 }, error: { const: status === 400 ? "DEVICE_PEER_BOOTSTRAP_INVALID" : "DEVICE_PEER_BOOTSTRAP_DENIED" } } } }]))
      },
      effects: { mode: "connection-control", description: "The original cryptographic owner verifies the signed fields and installs or renews a device lease; it does not send business requests." },
      recovery: { strategy: "original-device-proof", description: "Retain the original authenticatedAt, source, nonce and absolute expiry; never renew authority by resetting a request timestamp." },
      validators: [
        { id: "original-relay-device", description: "Before reading a body, validate the current authenticated Relay hop, original scope, generation, device identity and nonce. Recheck after every await." },
        { id: "signed-device-lease", description: "The original cryptographic owner validates public key, signature, target, nonce, capacity and absolute expiry before installing the device grant." }
      ]
    },
    prepare,
    handler: async input => { const prepared = await prepare(input); return typeof prepared === "function" ? prepared(input) : prepared; }
  };
  return { operation, stop(): void { stopped = true; } };
}
