import type http from "node:http";
import type { ApiOperationDefinition, ApiSchema } from "./apiOperationContract.js";
import type { WebguiLanAccessConfig } from "./webguiLanAccess.js";

export const WEBGUI_ACCESS_BODY_LIMIT = 64 * 1024;
export type WebguiAccessOwner = {
  readPayload(request: http.IncomingMessage): unknown;
  readConfig(): WebguiLanAccessConfig;
  saveConfig(value: WebguiLanAccessConfig): void;
  generateToken(): string;
  canManage(request: http.IncomingMessage): boolean;
};

const text = { type: "string" };
const bool = { type: "boolean" };
const empty = { type: "object", properties: {}, additionalProperties: false };
// Preserve the existing decoder: only actual boolean fields change settings;
// other non-null JSON values and unknown fields are accepted and ignored.
export const webguiAccessPatchSchema: ApiSchema = { anyOf: [
  { type: "object", properties: {
    enabled: { description: "A boolean changes the LAN setting; other JSON values are ignored." },
    regenerateToken: { description: "Only literal true rotates the shared WebGUI credential." }
  }, additionalProperties: true },
  { type: "array" }, text, { type: "number" }, bool
] };
const payload: ApiSchema = { type: "object", required: ["code", "data"], properties: { code: { const: 0 }, data: {
  type: "object", required: ["enabled", "tokenConfigured", "token", "canManage", "managerHost", "managerPort", "listeningOnLan", "restartRequired", "hostManagedByEnvironment", "urls"],
  properties: { enabled: bool, tokenConfigured: bool, token: text, canManage: bool, managerHost: text,
    managerPort: { type: "integer", minimum: 0, maximum: 65535 }, listeningOnLan: bool, restartRequired: bool, hostManagedByEnvironment: bool,
    urls: { type: "array", items: { type: "object", required: ["name", "address", "url"],
      properties: { name: text, address: text, cidr: text, url: text }, additionalProperties: true } } }, additionalProperties: true
} }, additionalProperties: true };
const failure = { mediaType: "application/json", schema: { type: "object", required: ["code", "message"],
  properties: { code: { const: -1 }, message: text }, additionalProperties: true } };
const headers = { "cache-control": "private, no-store" };

export function createWebguiAccessOperations(owner: WebguiAccessOwner): readonly ApiOperationDefinition[] {
  return (["GET", "PATCH", "POST"] as const).map(method => {
    const read = method === "GET";
    return { contract: {
      operationId: read ? "manager.webgui-access.read" : method === "PATCH" ? "manager.webgui-access.update" : "manager.webgui-access.update-post",
      contractVersion: "1.0.0", method, pathTemplate: "/api/webgui-access", exposure: "public", transport: "http",
      description: read ? "Read existing WebGUI access settings and connection links. Credential disclosure follows the existing connection/local-machine owner."
        : "Update WebGUI LAN access or rotate its shared credential. POST retains the existing alternate method and uses the same owner as PATCH.",
      request: { path: empty, query: { type: "object", additionalProperties: true }, headers: { type: "object" },
        body: read ? { kind: "none" } : { kind: "json", schema: webguiAccessPatchSchema, maxBytes: WEBGUI_ACCESS_BODY_LIMIT, emptyValue: {}, allowAnyContentType: true } },
      responses: { "200": { mediaType: "application/json", schema: payload,
        headers: { type: "object", required: ["cache-control"], properties: { "cache-control": { const: headers["cache-control"] } }, additionalProperties: true } }, "400": failure, "403": failure },
      effects: { mode: read ? "sensitive-read" : "configuration-write", description: read ? "Reads the original configuration/status owner. Response may contain the existing credential; discovery never contains credential values."
        : "Persists through the existing global configuration store, retaining its audit and connection-policy updates. Enabling may generate a credential; regenerateToken=true always rotates it." },
      recovery: { strategy: read ? "repeatable-read" : "read-before-retry", description: read ? "Rediscover the Manager address after identity changes."
        : "Read current settings after an uncertain write. Do not automatically replay token rotation. restartRequired reports existing Host/listener semantics; this operation does not restart Manager." },
      validators: [{ id: "manager.webgui-access.original-owner", description: "Authenticated connections retain management access without a separate Agent/persona grant. The existing local-machine predicate remains available. Only boolean enabled and literal regenerateToken=true change settings; unknown fields and other non-null JSON values retain their no-op behavior. Empty input decodes to an empty object. Bodies are bounded to 64 KiB." }]
    }, handler: input => {
      if (!read && !owner.canManage(input.request)) return { status: 403, headers, body: { code: -1, message: "局域网 WebGUI 设置需要有效的连接身份。" } };
      try {
        if (!read) {
          const body = input.body as { enabled?: unknown; regenerateToken?: unknown };
          const current = owner.readConfig();
          const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
          const accessToken = body.regenerateToken === true || (enabled && !current.accessToken) ? owner.generateToken() : current.accessToken;
          owner.saveConfig({ enabled, accessToken });
        }
        return { status: 200, headers, body: owner.readPayload(input.request) };
      } catch (error) { return { status: 400, headers, body: { code: -1, message: error instanceof Error ? error.message : String(error) } }; }
    } };
  });
}
