import { getTimeoutMs } from "../shared/timeoutSettings.js";
import type { AgentScanOptions } from "../agentAdapters/managerApi.js";
import { freezeApiData, type ApiOperationContract, type ApiSchema } from "./apiOperationContract.js";
import { DSH_CONNECTION_BODY_MAX_BYTES, DSH_CONNECTION_REQUEST_TIMEOUT_MS } from "./dshConnectionRoutes.js";

const grok = { grokBotLimit: 100, grokBotOffset: 0, grokBotQuery: null, grokBotAgentId: null, grokBotProfilePath: null, grokBotBackendUrl: null };
const dsh = { dshLimit: 200, dshOffset: 0, dshQuery: null, dshBaseUrl: null };
export const AGENT_SCAN_QUERY_FIELDS = freezeApiData({ all: { ...grok, codexLimit: 200, codexOffset: 0, codexQuery: null, ...dsh }, dsh, grokBot: grok });
export type AgentCatalogScanKind = keyof typeof AGENT_SCAN_QUERY_FIELDS;
export function agentCatalogScanOptions(kind: AgentCatalogScanKind, url: URL): AgentScanOptions {
  return Object.fromEntries(Object.entries(AGENT_SCAN_QUERY_FIELDS[kind]).map(([name, fallback]) => {
    const value = url.searchParams.get(name);
    return [name, fallback === null ? value || undefined : Number(value || String(fallback))];
  }));
}
export const AGENT_CATALOG_OPERATIONS = freezeApiData([
  { key: "catalog", method: "GET", path: "/api/agent-adapters/catalog" },
  { key: "all", method: "GET", path: "/api/scan/agents" },
  { key: "dsh", method: "GET", path: "/api/scan/agents/dsh" },
  { key: "grokBot", method: "GET", path: "/api/scan/agents/grokBot" },
  { key: "connection", method: "GET", path: "/api/agent-adapters/dsh/connection" },
  { key: "connections", method: "GET", path: "/api/agent-adapters/dsh/connections" },
  { key: "connect", method: "POST", path: "/api/agent-adapters/dsh/connection" },
  { key: "disconnect", method: "DELETE", path: "/api/agent-adapters/dsh/connection" },
  { key: "hooks", method: "POST", path: "/api/agent-adapters/hooks/update" }
] as const);
export type AgentCatalogOperationKey = typeof AGENT_CATALOG_OPERATIONS[number]["key"];
const text = { type: "string" } as const;
const bool = { type: "boolean" } as const;
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const fields = (names: string) => Object.fromEntries(names.split(" ").map(name => [name, text]));
const stringArray = { type: "array", items: text };
const transport = { type: "object", required: ["protocol", "mode"], properties: fields("protocol mode"), additionalProperties: false };
const host = { type: "object", required: ["name", "required"], properties: { name: text, required: bool }, additionalProperties: false };
const manifestFields = { ...fields("type label maturity"), transport, host };
const capabilities = { type: "object", properties: { managedTasks: { type: "object", additionalProperties: { const: true } } }, additionalProperties: false };
const manifest = { type: "object", required: ["type", "label", "maturity", "transport", "capabilities"],
  properties: { ...manifestFields, capabilities }, additionalProperties: false };
const session = { type: "object", required: ["name"], properties: { ...fields("id ownerId name projectPath projectId updatedAt status"), userNamed: bool, live: bool }, additionalProperties: true };
const model = { type: "object", required: ["id", "name"], properties: { ...fields("id name provider providerName description defaultReasoningEffort"), isDefault: bool,
  reasoningEfforts: { type: "array", items: { type: "object", required: ["id"], properties: fields("id description"), additionalProperties: false } } }, additionalProperties: true };
const agent = { type: "object", required: ["type", "label", "maturity", "installed"], additionalProperties: true,
  properties: { ...manifestFields, installed: bool, warnings: stringArray,
    installCandidates: { type: "array", items: { type: "object", required: ["label"], properties: fields("label path url"), additionalProperties: false } },
    auth: { type: "object", required: ["required"], properties: { required: bool, loggedIn: bool, loginUrl: text, message: text }, additionalProperties: true },
    endpoints: { type: "array", items: { type: "object", required: ["label", "url"], properties: { label: text, url: text, healthy: bool }, additionalProperties: true } },
    projects: { type: "array", items: { type: "object", required: ["label", "path", "exists"], properties: { ...fields("id label path"), exists: bool }, additionalProperties: true } },
    sessions: { type: "array", items: session }, models: { type: "array", items: model },
    sessionPage: { type: "object", required: ["offset", "limit", "returned", "hasMore"], properties: { offset: integer, limit: integer, returned: integer, hasMore: bool, nextOffset: integer }, additionalProperties: false },
    agentPresets: { type: "array", items: { type: "object", required: ["id"], properties: fields("id name description broken"), additionalProperties: true } },
    plugins: { type: "array", items: { type: "object", required: ["id", "name", "installed"], properties: { ...fields("id name version"), installed: bool, healthy: bool, details: stringArray }, additionalProperties: true } } } };
const scan = { type: "object", required: ["agents", "cwdOptions"], properties: { agents: { type: "object", additionalProperties: agent }, cwdOptions: stringArray,
  threadNames: stringArray, copilotBins: stringArray, marvisAppIds: stringArray,
  copilotSessions: { type: "array", items: { type: "object", properties: { name: text, cwd: text, userNamed: bool }, additionalProperties: true } }, legacy: { type: "object" } }, additionalProperties: true };
const connection = { type: "object", required: ["baseUrl", "state"], properties: { baseUrl: text,
  state: { enum: ["connected", "saved", "disconnected", "not_connected", "expired"] }, updatedAt: text, expiresAt: integer, revision: integer }, additionalProperties: false };
const ownerError = { mediaType: "application/json", schema: { type: "object", required: ["ok", "message"], properties: { ok: { const: false }, message: text }, additionalProperties: false } };
const readError = { mediaType: "application/json", schema: { type: "object", required: ["code", "message"], properties: { code: { const: -1 }, message: text }, additionalProperties: false } };
const envelope = (data: ApiSchema) => ({ type: "object", required: ["code", "data"], properties: { code: { const: 0 }, data }, additionalProperties: false });

export function agentAdapterCatalogContract(definition: typeof AGENT_CATALOG_OPERATIONS[number]): ApiOperationContract {
  const { key, method, path: pathTemplate } = definition;
  const scanKind = key === "all" || key === "dsh" || key === "grokBot" ? key : undefined;
  const connectionOperation = ["connection", "connections", "connect", "disconnect"].includes(key);
  const query = scanKind ? Object.fromEntries(Object.entries(AGENT_SCAN_QUERY_FIELDS[scanKind]).map(([name, fallback]) => [name,
    { type: "string", ...(fallback !== null ? { default: String(fallback) } : {}), description: fallback === null ? "Existing optional string selection." : "Existing Number(value || default) normalization; provider owns paging bounds." }]))
    : key === "connection" ? { baseUrl: text } : key === "hooks" ? { adapter: text } : {};
  const data: ApiSchema = key === "catalog" ? envelope({ type: "object", required: ["schemaVersion", "adapters"], properties: { schemaVersion: { const: 1 }, adapters: { type: "array", items: manifest } }, additionalProperties: false })
    : scanKind ? scan : key === "hooks" ? { type: "object", required: ["ok", "message"], properties: { ok: { const: true }, message: text }, additionalProperties: false }
    : { type: "object", required: ["ok", "revision", ...(key === "connections" ? ["endpoints"] : key === "disconnect" ? [] : ["connection"])],
      properties: { ok: { const: true }, revision: integer, ...(key === "connections" ? { endpoints: { type: "array", maxItems: 100, items: connection } }
        : key === "disconnect" ? {} : { connection }) }, additionalProperties: false };
  const mutation = key === "connect" || key === "disconnect";
  return { operationId: `agent.adapters.${key}.${method.toLowerCase()}`, ...(key === "catalog" ? { aliases: [`agent:${method}:${pathTemplate}`] } : {}), contractVersion: "1.0.0", method, pathTemplate,
    description: key === "catalog" ? "Read registered adapter maturity, transport and implemented capabilities; metadata is not an API permission grant."
      : scanKind ? `Explicitly scan ${scanKind === "all" ? "available Agent hosts" : scanKind} through its existing bounded worker; never executes a prompt or creates a replacement session.`
      : key === "hooks" ? "Install/update existing Hook integration files for the selected adapter."
      : `Use the existing DSH connection owner for ${key}; metadata never includes credentials.`, exposure: "public", transport: "http",
    request: { ...(mutation ? { get deadlineMs() { return getTimeoutMs("agent.dsh.connection", DSH_CONNECTION_REQUEST_TIMEOUT_MS); } } : {}), path: { type: "object", properties: {}, additionalProperties: false }, query: { type: "object", properties: query, additionalProperties: false }, headers: { type: "object" },
      body: mutation ? { kind: "json", maxBytes: DSH_CONNECTION_BODY_MAX_BYTES, schema: { type: "object", required: key === "disconnect" ? ["baseUrl", "expectedRevision"] : ["expectedRevision"],
        properties: { baseUrl: text, expectedRevision: integer, ...(key === "connect" ? { launchUrl: text } : {}) }, additionalProperties: false,
        ...(key === "connect" ? { oneOf: [{ required: ["launchUrl"], properties: { launchUrl: true } }, { required: ["baseUrl"], properties: { baseUrl: true } }] } : {}) } } : { kind: "none" } },
    responses: { "200": { mediaType: "application/json", schema: data }, "500": connectionOperation || key === "hooks" ? ownerError : readError,
      "503": connectionOperation ? ownerError : readError, ...(connectionOperation ? { "400": ownerError, "401": ownerError, "403": ownerError, "405": ownerError, "409": ownerError, "413": ownerError, "415": ownerError } : {}) },
    effects: { mode: mutation ? "connection-write" : key === "hooks" ? "installation-write" : scanKind ? "explicit-scan" : "owner-read",
      description: mutation ? "Changes the existing machine-private protected DSH login store under its expectedRevision fence; no Agent prompt or session is created."
        : key === "hooks" ? "May replace installed Hook integration files through the existing installer; does not execute an Agent prompt."
        : scanKind ? "Probes local/selected host metadata, sessions and models through the worker owner. Only an explicit request scans; no background scan is introduced."
        : "Reads current safe owner metadata; this catalog neither grants nor denies public API access." },
    recovery: { strategy: mutation ? "read-connection-revision" : key === "hooks" ? "inspect-installed-hooks" : "owner-read",
      description: mutation ? "After timeout/disconnection or conflict, read the same connection metadata and revision before deciding another write. Never replay, replace the origin or reuse an old revision automatically."
        : key === "hooks" ? "Inspect installed Hook version/files after uncertainty before deciding another install; no automatic replay." : "Retain original host/provider/selection. Busy, cancellation or a missing host is not permission to launch a different Runtime, create a session or scan repeatedly." },
    validators: [{ id: "agent.adapters.existing-owner", description: "Manifest and native provider extras remain owned by the adapters. Scan queries retain shared numeric defaults and existing provider paging normalization. Worker capacity, five-minute default budget, cancellation and child-process cleanup remain with AgentAdapterCatalogService." },
      { id: "agent.adapters.dsh-owner", description: "DSH management retains authenticated-connection/local safety checks without persona grants, clean local-origin validation, existing 90-second verification deadline, protected credential storage and expectedRevision compare/write. launchUrl is write-only input and never appears in discovery or metadata output." }] };
}
