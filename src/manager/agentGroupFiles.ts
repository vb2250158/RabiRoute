import type http from "node:http";
import { definitionUsesNapcat, normalizeNapCatInstances, normalizeReadableGroupFileIds, type GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { NAPCAT_GROUP_FILES_LIMITS, readNapCatGroupFiles, type GroupFilesPage } from "../napcat.js";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";

const PATH = "/api/agent/qq/group-files";
const groupIdPattern = /^[1-9][0-9]{0,15}$/;
const folderIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const queryContract = { type: "object", required: ["routeId", "groupId"], additionalProperties: false, properties: {
  routeId: { type: "string", minLength: 1, maxLength: 256 }, groupId: { type: "string", pattern: groupIdPattern.source },
  folderId: { type: "string", pattern: folderIdPattern.source }
} } as const;

export type AgentGroupFilesContext = {
  /** Exact Route lookup; never discover another Route from group or instance. */
  route: (routeId: string) => GatewayDefinition | undefined;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  readFiles?: typeof readNapCatGroupFiles;
};

function safeOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined;
    return url.origin;
  } catch { return undefined; }
}

function groupFilesAllowed(definition: GatewayDefinition, groupId: string): boolean {
  const configured = definition.messageAdapterPolicies?.napcat?.readableGroupFileIds;
  return configured === undefined || normalizeReadableGroupFileIds(configured).includes(groupId);
}

/** Public bounded metadata read; only an explicitly configured group list restricts an admitted caller. */
export async function handleAgentGroupFiles(
  request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse, context: AgentGroupFilesContext
): Promise<boolean> {
  if (request.method !== "GET" || requestUrl.pathname !== PATH) return false;
  response.setHeader("cache-control", "no-store");
  const deny = (status: number, errorCode: string, message?: string): true => {
    context.jsonResponse(response, status, { code: -1, errorCode, ...(message ? { message } : {}) });
    return true;
  };
  let principal: ReturnType<typeof assertTrustedLanAgentPrincipal>;
  try { principal = assertTrustedLanAgentPrincipal(request); }
  catch { return deny(403, "QQ_GROUP_FILES_NOT_AUTHORIZED"); }
  const authorized = () => {
    try {
      // Keep the original ingress lease; revocation must never select local fallback.
      if (assertTrustedLanAgentPrincipal(request) !== principal) return false;
      if (principal) return true;
      if (getTrustedLanAgentSource(request) || hasLanAgentBodyGuard(request)) return false;
      if (hasAuthenticatedConnectionRequest(request)) return true;
      if (request.headers["x-rabilink-tunnel-local"] || request.headers["x-rabilink-resource-owner"] || request.headers["x-rabiroute-peer-proxy"]) return false;
      return !getTrustedLanAgentSource(request) && !hasLanAgentBodyGuard(request)
        && localModelSettingsRequestAllowed(request);
    } catch { return false; }
  };
  if (!authorized()) return deny(403, "QQ_GROUP_FILES_TRUSTED_SOURCE_REQUIRED");
  if (request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) return deny(400, "QQ_GROUP_FILES_BODY_NOT_ALLOWED");
  const fields = [...requestUrl.searchParams.entries()];
  const keys = fields.map(([key]) => key);
  if (fields.length < 2 || fields.length > 3 || !keys.includes("routeId") || !keys.includes("groupId")
    || new Set(keys).size !== fields.length || keys.some(key => !Object.keys(queryContract.properties).includes(key))) return deny(400, "QQ_GROUP_FILES_INVALID_QUERY");
  const routeId = requestUrl.searchParams.get("routeId") ?? "";
  const groupId = requestUrl.searchParams.get("groupId") ?? "";
  const folderId = requestUrl.searchParams.get("folderId") ?? undefined;
  if (!routeId || routeId.length > queryContract.properties.routeId.maxLength || !groupIdPattern.test(groupId)
    || (folderId !== undefined && !folderIdPattern.test(folderId))) return deny(400, "QQ_GROUP_FILES_INVALID_QUERY");
  const definition = context.route(routeId);
  if (!definition || definition.id !== routeId || definition.enabled !== true || !authorized()) return deny(403, "QQ_GROUP_FILES_NOT_AUTHORIZED");
  if (!definitionUsesNapcat(definition)) return deny(409, "QQ_GROUP_FILES_NAPCAT_DISABLED");
  if (!groupFilesAllowed(definition, groupId)) return deny(403, "QQ_GROUP_FILES_GROUP_NOT_ALLOWED",
    `Route ${routeId} group ${groupId} is excluded by messageAdapterPolicies.napcat.readableGroupFileIds=${JSON.stringify(definition.messageAdapterPolicies?.napcat?.readableGroupFileIds)}. Edit this Route setting; remove the field to allow all groups.`);
  // Inspect the raw list: normalizeNapCatInstances deliberately discards surplus legacy entries.
  const raw = definition.napcatInstances;
  if (!Array.isArray(raw) || raw.length !== 1 || raw[0]?.enabled === false) return deny(409, "QQ_GROUP_FILES_INSTANCE_AMBIGUOUS");
  const instances = normalizeNapCatInstances(definition).filter(instance => instance.enabled !== false);
  if (instances.length !== 1) return deny(409, "QQ_GROUP_FILES_INSTANCE_AMBIGUOUS");
  const instance = instances[0]!;
  const origin = safeOrigin(instance.httpUrl);
  const configuredInstance = { ...raw[0] };
  if (!origin) return deny(409, "QQ_GROUP_FILES_ENDPOINT_UNSAFE");
  if (!authorized()
    || !groupFilesAllowed(definition, groupId)) return deny(403, "QQ_GROUP_FILES_NOT_AUTHORIZED");
  try {
    const page: GroupFilesPage = await (context.readFiles ?? readNapCatGroupFiles)(
      { httpUrl: origin, accessToken: instance.accessToken ?? "" }, groupId, folderId
    );
    const current = context.route(routeId);
    const configured = current?.napcatInstances;
    if (!authorized() || !current || current.id !== routeId || current.enabled !== true || !definitionUsesNapcat(current)
      || !Array.isArray(configured) || configured.length !== 1 || configured[0]?.enabled === false
      || configured[0]?.id !== configuredInstance.id || configured[0]?.httpUrl !== configuredInstance.httpUrl
      || configured[0]?.accessToken !== configuredInstance.accessToken
      || !groupFilesAllowed(current, groupId)) {
      return deny(403, "QQ_GROUP_FILES_NOT_AUTHORIZED");
    }
    context.jsonResponse(response, 200, { code: 0, data: { routeId, groupId, folderId: folderId ?? null, instanceId: instance.id, ...page } });
  } catch {
    if (!authorized()) return deny(403, "QQ_GROUP_FILES_NOT_AUTHORIZED");
    // No upstream error body or URL: either may carry an access token or private data.
    return deny(503, "QQ_GROUP_FILES_UPSTREAM_UNAVAILABLE");
  }
  return true;
}

export function createAgentGroupFilesOperation(context: AgentGroupFilesContext): ApiOperationDefinition {
  const text = { type: "string", minLength: 1, maxLength: NAPCAT_GROUP_FILES_LIMITS.fieldChars, pattern: "^[^\\x00-\\x1f\\x7f]+$" };
  const number = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  const error = { mediaType: "application/json", schema: { type: "object", required: ["code", "errorCode"], additionalProperties: false,
    properties: { code: { const: -1 }, errorCode: { type: "string" }, message: { type: "string" } } } };
  return { contract: {
    operationId: "agent.qq.group-files.read", contractVersion: "1.0.0", method: "GET", pathTemplate: PATH,
    aliases: [`agent:GET:${PATH}`],
    description: "Read one bounded QQ group-file metadata projection without downloading files or exposing signed URLs.", exposure: "public", transport: "http",
    request: { path: { type: "object", properties: {}, additionalProperties: false }, query: queryContract,
      headers: { type: "object", properties: { "content-length": false, "transfer-encoding": false }, additionalProperties: true }, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], additionalProperties: false,
      properties: { code: { const: 0 }, data: { type: "object", required: ["routeId", "groupId", "folderId", "instanceId", "files", "folders", "completenessUnknown", "potentiallyTruncated", "projectionTruncated"],
        additionalProperties: false, properties: { routeId: { type: "string" }, groupId: { type: "string" }, folderId: { anyOf: [{ type: "null" }, { type: "string" }] }, instanceId: { type: "string" },
          files: { type: "array", maxItems: NAPCAT_GROUP_FILES_LIMITS.pageEntries, items: { type: "object", required: ["fileId", "fileName"], additionalProperties: false,
            properties: { fileId: text, fileName: text, fileSize: number, uploadTime: number, uploader: { ...text, maxLength: 32 }, busid: number } } },
          folders: { type: "array", maxItems: NAPCAT_GROUP_FILES_LIMITS.pageEntries, items: { type: "object", required: ["folderId", "folderName"], additionalProperties: false,
            properties: { folderId: text, folderName: text, totalFileCount: number } } }, completenessUnknown: { const: true }, potentiallyTruncated: { const: true }, projectionTruncated: { type: "boolean" }
        } } } } }, "400": error, "403": error, "409": error, "503": error },
    effects: { mode: "read", description: "Uses one bounded upstream group-file metadata read; does not download, send, change a Route, or infer a complete directory." },
    recovery: { strategy: "repeatable-read", description: "Repeat only for the same selected Route/group/folder and current connection. A truncated projection is not proof of file absence." },
    validators: [{ id: "agent.qq.group-files.current-owner", description: "The existing owner revalidates ingress and the exact enabled Route/instance before and after the read. Only an explicitly configured readableGroupFileIds list restricts groups; absent context bindings do not deny an authenticated connection." },
      { id: "agent.qq.group-files.bounds", description: `The provider owner limits the upstream response to ${NAPCAT_GROUP_FILES_LIMITS.responseBytes} bytes and the combined file/folder projection to ${NAPCAT_GROUP_FILES_LIMITS.pageEntries} entries; timeout is bounded, endpoint safety and metadata normalization remain server-owned.` }]
  }, async handler(input) {
    let result: ApiOperationResult | undefined;
    await handleAgentGroupFiles(input.request, input.url, input.response, { ...context,
      jsonResponse: (_response, status, body) => { result = { status, body, headers: { "cache-control": "no-store" } }; } });
    if (!result) throw new Error("Group-file metadata read did not produce a response.");
    return result;
  } };
}
