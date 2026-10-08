import type http from "node:http";
import { definitionUsesNapcat, normalizeNapCatInstances, normalizeReadableGroupFileIds, type GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { resolvePrimaryAgentTarget } from "../shared/routeAgentTargets.js";
import { readNapCatGroupFiles, type GroupFilesPage } from "../napcat.js";
import { getTrustedLanAgentSource, type TrustedLanAgentSource } from "./lanAgentBodyAuthority.js";

const PATH = "/api/agent/qq/group-files";
const groupIdPattern = /^[1-9][0-9]{0,15}$/;
const folderIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

type Authority = { provider: string; sessionId: string };
export type AgentGroupFilesContext = {
  /** Exact Route lookup; never discover another Route from group or instance. */
  route: (routeId: string) => GatewayDefinition | undefined;
  approvedBinding: (nodeId: string, agentId: string) => Authority | null;
  isAgentEnabled: (nodeId: string, agentId: string) => boolean;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  readFiles?: typeof readNapCatGroupFiles;
};

function authorized(source: TrustedLanAgentSource, definition: GatewayDefinition, context: AgentGroupFilesContext): boolean {
  const binding = context.approvedBinding(source.nodeId, source.agentId);
  const provider = binding?.provider === "codex-desktop" ? "codex" : binding?.provider;
  const primary = resolvePrimaryAgentTarget(definition);
  return context.isAgentEnabled(source.nodeId, source.agentId)
    && provider === source.provider && Boolean(binding?.sessionId) && binding?.sessionId === source.sessionId
    && primary?.provider === source.provider && primary.binding?.instanceId === source.nodeId
    && primary.binding.agentId === source.agentId;
}

function safeOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined;
    return url.origin;
  } catch { return undefined; }
}

/** HTTP handler requires the Manager's authenticated LAN Agent middleware to have installed a trusted source. */
export async function handleAgentGroupFiles(
  request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse, context: AgentGroupFilesContext
): Promise<boolean> {
  if (request.method !== "GET" || requestUrl.pathname !== PATH) return false;
  response.setHeader("cache-control", "no-store");
  const deny = (status: number, errorCode: string): true => {
    context.jsonResponse(response, status, { code: -1, errorCode });
    return true;
  };
  const source = getTrustedLanAgentSource(request);
  if (!source) return deny(403, "QQ_GROUP_FILES_TRUSTED_SOURCE_REQUIRED");
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
  if (!definition || definition.id !== routeId || definition.enabled !== true || !authorized(source, definition, context)) return deny(403, "QQ_GROUP_FILES_NOT_AUTHORIZED");
  if (!definitionUsesNapcat(definition)) return deny(409, "QQ_GROUP_FILES_NAPCAT_DISABLED");
  const allowlist = normalizeReadableGroupFileIds(definition.messageAdapterPolicies?.napcat?.readableGroupFileIds);
  if (!allowlist.includes(groupId)) return deny(403, "QQ_GROUP_FILES_GROUP_NOT_ALLOWED");
  // Inspect the raw list: normalizeNapCatInstances deliberately discards surplus legacy entries.
  const raw = definition.napcatInstances;
  if (!Array.isArray(raw) || raw.length !== 1 || raw[0]?.enabled === false) return deny(409, "QQ_GROUP_FILES_INSTANCE_AMBIGUOUS");
  const instances = normalizeNapCatInstances(definition).filter(instance => instance.enabled !== false);
  if (instances.length !== 1) return deny(409, "QQ_GROUP_FILES_INSTANCE_AMBIGUOUS");
  const instance = instances[0]!;
  const origin = safeOrigin(instance.httpUrl);
  if (!origin) return deny(409, "QQ_GROUP_FILES_ENDPOINT_UNSAFE");
  if (!authorized(source, definition, context)
    || !normalizeReadableGroupFileIds(definition.messageAdapterPolicies?.napcat?.readableGroupFileIds).includes(groupId)) return deny(403, "QQ_GROUP_FILES_NOT_AUTHORIZED");
  try {
    const page: GroupFilesPage = await (context.readFiles ?? readNapCatGroupFiles)(
      { httpUrl: origin, accessToken: instance.accessToken ?? "" }, groupId, folderId
    );
    const current = context.route(routeId);
    if (!current || current !== definition || !authorized(source, current, context)
      || !normalizeReadableGroupFileIds(current.messageAdapterPolicies?.napcat?.readableGroupFileIds).includes(groupId)) {
      return deny(403, "QQ_GROUP_FILES_NOT_AUTHORIZED");
    }
    context.jsonResponse(response, 200, { code: 0, data: { routeId, groupId, folderId: folderId ?? null, instanceId: instance.id, ...page } });
  } catch {
    // No upstream error body or URL: either may carry an access token or private data.
    return deny(503, "QQ_GROUP_FILES_UPSTREAM_UNAVAILABLE");
  }
  return true;
}
