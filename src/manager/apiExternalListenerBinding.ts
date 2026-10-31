import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ManagerApiOperationsService, ApiOperationRegistration } from "./apiOperationContract.js";
import type { ApiPublishedOperation } from "./apiOperationCatalog.js";

/** Addresses describe an already owned listener. They never cause a server to start. */
export type ApiExternalListenerDefinition = Readonly<{
  listenerId: string;
  address: Readonly<{ protocol: "http" | "https"; hostname?: string; port: number }>;
  protocol: string;
  invocation: "native" | "discovery-only";
  authentication: Readonly<{ kind: "none" | "native"; description: string }>;
}>;
export type ApiExternalListenerBinding = ApiExternalListenerDefinition & Readonly<{
  kind: "external-listener";
  leaseId: string;
}>;
export type ApiExternalListenerRegistration = Pick<ManagerApiOperationsService, "registerOperations" | "registerUpgrades" | "registerHttpProxies"> & ApiOperationRegistration & Readonly<{
  binding: ApiExternalListenerBinding;
  handle(request: IncomingMessage, url: URL, response: ServerResponse): boolean;
  handleUpgrade(request: IncomingMessage, url: URL, socket: Duplex, head: Uint8Array): boolean;
  stopAccepting(): void;
  /** Data-only publication across an existing host lifecycle/IPC boundary; no credentials or handlers. */
  publication(): ApiExternalListenerPublication;
}>;
export type ApiExternalListenerPublication = Readonly<{
  /** False retires this listener even while its owning gateway process remains alive. */
  active: boolean;
  binding: ApiExternalListenerBinding;
  operations: readonly Pick<ApiPublishedOperation, "contract" | "contractDigest">[];
}>;
/** Installed by trusted host code. The host verifies the original process/lease, never an HTTP caller. */
export type ApiExternalListenerSource = Readonly<{
  isCurrent(): boolean;
  read(): readonly ApiExternalListenerPublication[];
}>;

export function validateExternalListenerDefinition(value: ApiExternalListenerDefinition): void {
  if (Object.keys(value).some(key => !["listenerId", "address", "protocol", "invocation", "authentication", "kind", "leaseId"].includes(key))
    || Object.keys(value.address ?? {}).some(key => !["protocol", "hostname", "port"].includes(key))
    || Object.keys(value.authentication ?? {}).some(key => !["kind", "description"].includes(key))) throw new Error("External listener bindings cannot publish credentials or additional fields.");
  if (typeof value.listenerId !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,191}$/.test(value.listenerId) || typeof value.protocol !== "string" || !value.protocol.trim()
    || !["native", "discovery-only"].includes(value.invocation)
    || !["none", "native"].includes(value.authentication?.kind) || !value.authentication.description?.trim()
    || !["http", "https"].includes(value.address?.protocol)
    || !Number.isSafeInteger(value.address.port) || value.address.port < 1 || value.address.port > 65535) throw new Error("Invalid external listener binding.");
  const hostname = value.address.hostname;
  if (hostname !== undefined) {
    const url = new URL(`${value.address.protocol}://${hostname}:${value.address.port}`);
    if (url.hostname !== hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || ["0.0.0.0", "[::]"].includes(hostname)) throw new Error("Listener discovery requires a reachable hostname, not a bind wildcard or URL.");
  }
}
