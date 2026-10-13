import type http from "node:http";
import { definitionUsesNapcat, normalizeNapCatInstances, normalizeReadableGroupFileIds, type GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { readNapCatGroupFiles, type GroupFilesPage } from "../napcat.js";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";

const PATH = "/api/agent/qq/group-files";
const groupIdPattern = /^[1-9][0-9]{0,15}$/;
const folderIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

type Authority = { provider: string; sessionId: string };
export type AgentGroupFilesContext = {
  /** Exact Route lookup; never discover another Route from group or instance. */
  route: (routeId: string) => GatewayDefinition | undefined;
  /** Legacy context wiring only; ingress principal owns Agent authorization. */
  approvedBinding?: (nodeId: string, agentId: string) => Authority | null;
  isAgentEnabled?: (nodeId: string, agentId: string) => boolean;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  readFiles?: typeof readNapCatGroupFiles;
};

function safeOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
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
  const deny = (status: number, errorCode: string): true => {
    context.jsonResponse(response, status, { code: -1, errorCode });
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
    || new Set(keys).size !== fields.length || keys.some(key => !["routeId", "groupId", "folderId"].includes(key))) return deny(400, "QQ_GROUP_FILES_INVALID_QUERY");
  const routeId = requestUrl.searchParams.get("routeId") ?? "";
  const groupId = requestUrl.searchParams.get("groupId") ?? "";
  const folderId = requestUrl.searchParams.get("folderId") ?? undefined;
  if (!routeId || routeId.length > 256 || !groupIdPattern.test(groupId)
    || (folderId !== undefined && !folderIdPattern.test(folderId))) return deny(400, "QQ_GROUP_FILES_INVALID_QUERY");
  const definition = context.route(routeId);
  if (!definition || definition.id !== routeId || definition.enabled !== true || !authorized()) return deny(403, "QQ_GROUP_FILES_NOT_AUTHORIZED");
  if (!definitionUsesNapcat(definition)) return deny(409, "QQ_GROUP_FILES_NAPCAT_DISABLED");
  if (!groupFilesAllowed(definition, groupId)) return deny(403, "QQ_GROUP_FILES_GROUP_NOT_ALLOWED");
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
