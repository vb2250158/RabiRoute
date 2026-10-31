import type { IncomingMessage } from "node:http";
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from "./apiOperationContract.js";
import type { LanAgentRoutesContext } from "./lanAgentRoutes.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

export type LanAgentReadContext = Pick<LanAgentRoutesContext, "authority" | "enabled" | "resources" | "releases" | "isReleaseRequestAuthorized" | "isManagementRequestAuthorized">;
const string = { type: "string" }, hash = { type: "string", pattern: "^[a-f0-9]{64}$" }, size = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const exact = (properties: Record<string, ApiSchema>) => ({ type: "object", required: Object.keys(properties), properties, additionalProperties: false });
const resourceContent = exact({ id: string, content: string, sha256: hash, sizeBytes: size });
const resourceMetadata = exact({ id: string, kind: { enum: ["skill", "document"] }, name: string, description: string, sha256: hash,
  sizeBytes: size, references: { type: "array", items: string } });
const releaseManifest = exact({ version: string, platform: { const: "node" }, minNodeVersion: string,
  files: { type: "array", items: exact({ path: string, sha256: hash, size, downloadUrl: string }) }, publicKey: string, publicKeySha256: hash, signature: string });
const json = (schema: ApiSchema) => ({ mediaType: "application/json", schema });
const failure = json({ type: "object", required: ["code"], properties: { code: { const: -1 }, error: string, message: string }, additionalProperties: false });
export const LAN_AGENT_READ_ROUTES = Object.freeze([
  { key: "resources.list", pathTemplate: "/api/lan-agent/resources" },
  { key: "resources.read", pathTemplate: "/api/lan-agent/resources/read" },
  { key: "releases.manifest", pathTemplate: "/api/lan-agent/releases/manifest" },
  { key: "releases.asset", pathTemplate: "/api/lan-agent/releases/:version/:platform/:assetPath" }
] as const);
for (const route of LAN_AGENT_READ_ROUTES) Object.freeze(route);
type ReadRoute = typeof LAN_AGENT_READ_ROUTES[number];

function contract(route: ReadRoute): ApiOperationContract {
  const asset = route.key === "releases.asset";
  const success = asset ? { mediaType: "application/octet-stream", binary: { maxBytes: Number.MAX_SAFE_INTEGER },
    alternatives: ["text/javascript; charset=utf-8", "text/plain; charset=utf-8", "application/json; charset=utf-8"].map(mediaType => ({ mediaType, binary: { maxBytes: Number.MAX_SAFE_INTEGER } })) }
    : json(route.key === "releases.manifest" ? exact({ code: { const: 0 }, release: releaseManifest })
      : exact({ code: { const: 0 }, data: route.key === "resources.read" ? resourceContent : { type: "array", items: resourceMetadata } }));
  return { operationId: `manager.lan-agent.${route.key}`, contractVersion: "1.0.0", method: "GET", pathTemplate: route.pathTemplate, exposure: "public", transport: "http",
    description: asset ? "Read one file from the existing signed connector release, retaining nested asset paths and original bytes."
      : "Read the original public Agent resource catalog or signed connector release manifest.",
    request: { ...(asset ? { pathTails: ["assetPath"] } : {}), path: asset ? exact({ version: string, platform: string, assetPath: string }) : exact({}),
      query: { type: "object", ...(route.key === "resources.read" ? { properties: { id: { anyOf: [string, { type: "array", items: string }] } } }
        : asset ? { properties: { release: { ...string, description: "Immutable signed snapshot identifier from the manifest download URL; pins bytes while the node release selection changes." } } } : {}), additionalProperties: true },
      headers: { type: "object", additionalProperties: true }, body: { kind: "none" } },
    responses: { "200": success, ...Object.fromEntries([400, 401, 403, 404, 503].map(status => [String(status), failure])) },
    effects: { mode: route.key.startsWith("releases.") ? "read-with-existing-signing-identity" : "read", description: "Reads the existing resource/release owner. Manifest construction may provision its original private signing identity when absent; it does not install, update or execute connector code." },
    recovery: { strategy: "read-current-publication", description: "Rediscover Manager identity and the current manifest. Verify its pinned public-key digest, signature and file digest with the existing download workflow. Never use discovery as an installation receipt." },
    validators: [{ id: "lan-agent.original-read-admission", description: "Authenticated public connections need no Agent registration, persona binding or second grant. Release bootstrap tickets retain their existing release-only entry. Revalidate the original connection after awaited reads; revoked nodes cannot fall back to loopback identity." },
      { id: "lan-agent.original-resource-boundaries", description: "The resource owner enforces its published document/Skill IDs, same-package references, size limits and symlink/path rules. The release owner verifies the requested version, platform, published asset membership and root confinement. Legacy resource-read queries use the first id value and ignore other fields." }] };
}

export function createLanAgentReadOperations(context: LanAgentReadContext): readonly ApiOperationDefinition[] {
  return LAN_AGENT_READ_ROUTES.map(route => ({ contract: contract(route), handler: input => runLanAgentReadOperation(context, route, input) }));
}
async function runLanAgentReadOperation(context: LanAgentReadContext, route: ReadRoute, input: ApiOperationInput): Promise<ApiOperationResult> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  const result = (status: number, body: unknown): ApiOperationResult => ({ status, body, headers });
  const request = input.request;
  const access = context.authority ? evaluateLanAgentRequest(request, context.authority, context.enabled?.() === true) : { kind: "unrelated" as const };
  if (access.kind === "denied") return result(access.status, { code: -1, error: access.error });
  const principal = assertTrustedLanAgentPrincipal(request);
  const release = route.key.startsWith("releases.");
  const allowed = () => hasAuthenticatedConnectionRequest(request) || (release
    ? context.isReleaseRequestAuthorized(request) : context.isManagementRequestAuthorized(request, input.url));
  if (!allowed()) return { ...result(401, { code: -1, error: "LAN_AGENT_TOKEN_REQUIRED", message: "Rabi Agent resource access requires the LAN connection Token." }),
    headers: { ...headers, "www-authenticate": 'Bearer realm="RabiRoute LAN Agent"' } };
  const guard = () => {
    if (assertTrustedLanAgentPrincipal(request) !== principal || !allowed()) throw Object.assign(new Error("Connection identity changed."), { status: 403 });
  };
  try {
    guard();
    if (!release) {
      if (!context.resources) return result(503, { code: -1, message: "Agent resources unavailable." });
      const data = route.key === "resources.read" ? await context.resources.read(input.url.searchParams.get("id") ?? "") : await context.resources.list();
      guard(); return result(200, { code: 0, data });
    }
    if (route.key === "releases.manifest") { const manifest = context.releases.manifest(principal?.nodeId); guard(); return result(200, { code: 0, release: manifest }); }
    const assetPath = input.path.assetPath!;
    const bytes = context.releases.readAsset(input.path.version!, input.path.platform!, assetPath, principal?.nodeId, input.url.searchParams.get("release") ?? undefined); guard();
    return { status: 200, headers: { ...headers, "content-length": String(bytes.length), "content-type": assetPath.endsWith(".mjs") ? "text/javascript; charset=utf-8"
      : assetPath.endsWith(".dll") ? "application/octet-stream" : assetPath.endsWith(".ps1") ? "text/plain; charset=utf-8" : "application/json; charset=utf-8" }, body: bytes };
  } catch (error) {
    try { guard(); } catch { return result(403, { code: -1, message: "Connection identity changed." }); }
    if ((error as { status?: number })?.status === 403) return result(403, { code: -1, message: "Connection identity changed." });
    return result(!release ? 400 : route.key === "releases.manifest" ? 503 : 404,
      { code: -1, message: !release ? "Agent resource is unavailable or disallowed." : error instanceof Error ? error.message : String(error) });
  }
}
