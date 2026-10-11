import type { IncomingMessage, ServerResponse } from "node:http";
import { validateInternalManagerHop } from "../shared/internalManagerHop.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

export const DEVICE_PEER_BOOTSTRAP_PATH = "/api/rabilink/peer/device-bootstrap";
export const DEVICE_PEER_LEASE_MS = 45_000;

export type DevicePeerBootstrapAuthority = Readonly<{
  sourceDeviceId: string;
  scope: string;
  issuedAt: number;
  assertCurrent(): void;
}>;
export type DevicePeerBootstrapRouteOptions = {
  current(): { scope: string; generation: string; deviceId: string };
  readJsonBody(request: IncomingMessage): Promise<unknown>;
  bootstrap(input: unknown, authority: DevicePeerBootstrapAuthority): Promise<unknown>;
  jsonResponse(response: ServerResponse, status: number, body: unknown): void;
};

/** Device credentials reach this route only through the authenticated Relay HTTP owner. */
export function createDevicePeerBootstrapRoutes(options: DevicePeerBootstrapRouteOptions) {
  const pending = new Set<Promise<void>>();
  let stopped = false;
  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
      let status = 403;
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
        const assertCurrent = () => {
          const current = options.current();
          if (stopped || current.scope !== initial.scope || current.generation !== initial.generation || current.deviceId !== initial.deviceId
            || !hasAuthenticatedConnectionRequest(request)) throw new Error("Original connection changed.");
          const fresh = validateInternalManagerHop(request, initial);
          if (!fresh || fresh.kind !== "relay" || fresh.deviceId !== claims.deviceId || fresh.nonce !== claims.nonce) {
            throw new Error("Original Relay device identity changed.");
          }
        };
        assertCurrent();
        const input = await options.readJsonBody(request);
        assertCurrent();
        status = 400;
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid device bootstrap.");
        const fields = input as Record<string, unknown>;
        if (fields.source !== claims.deviceId || fields.target !== initial.deviceId
          || !Number.isSafeInteger(fields.expiresAt) || typeof fields.expiresAt !== "number"
          || fields.expiresAt <= Date.now() || fields.expiresAt > claims.authenticatedAt + DEVICE_PEER_LEASE_MS
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
          scope: initial.scope, issuedAt: claims.authenticatedAt, assertCurrent: assertLease });
        assertLease();
        const data = await options.bootstrap(input, authority);
        assertLease();
        options.jsonResponse(response, 200, { code: 0, data });
      } catch {
        options.jsonResponse(response, status, { code: -1, error: status === 400 ? "DEVICE_PEER_BOOTSTRAP_INVALID" : "DEVICE_PEER_BOOTSTRAP_DENIED" });
      }
  }
  return {
    handle(request: IncomingMessage, url: URL, response: ServerResponse): boolean {
      if (url.pathname !== DEVICE_PEER_BOOTSTRAP_PATH) return false;
      response.setHeader("cache-control", "no-store");
      if (request.method !== "POST") {
        options.jsonResponse(response, 405, { code: -1, error: "DEVICE_PEER_BOOTSTRAP_METHOD_REQUIRED" });
        return true;
      }
      const task = dispatch(request, response).catch(() => { response.destroy(); });
      pending.add(task);
      void task.then(() => pending.delete(task));
      return true;
    },
    stop(): void { stopped = true; },
    async drain(): Promise<void> { await Promise.allSettled([...pending]); }
  };
}
