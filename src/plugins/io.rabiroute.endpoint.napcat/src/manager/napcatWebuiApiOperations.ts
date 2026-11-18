import { createHash, X509Certificate } from "node:crypto";
import { compileApiContract, type ApiOperationContract, type ApiOperationDefinition, type ApiOperationInput, type ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { napcatWebuiApiReadRoutes } from "./napcatWebuiApiRoutes.js";
import { boundedBytes } from "./qqMessageMedia.js";
import { NapcatApiError, napcatApiFailure, selectNapcatApiInstance, verifyNapcatApiIdentity,
  type NapcatApiSelection, type NapcatApiTransportContext } from "./napcatApiTransport.js";

/** Supplied by the original WebUI session owner, which retains its credential and target snapshot. */
export type NapcatWebuiApiSession = {
  requestFixed(method: "GET" | "POST", pathname: string, signal: AbortSignal): Promise<Response>;
  assertCurrent(): void;
};
export type NapcatWebuiApiContext = NapcatApiTransportContext & {
  openWebuiSession(selection: NapcatApiSelection, signal: AbortSignal): Promise<NapcatWebuiApiSession>;
};
type Params = Record<string, unknown>;
type Row = Record<string, unknown>;
type ReadSpec = Readonly<{
  id: string;
  title: string;
  upstreamPath: string;
  method: "GET" | "POST";
  params: ApiSchema;
  response: ApiSchema;
  kind?: "resource" | "log-events" | "system-events";
  relatedOperations?: readonly string[];
}>;
const text = { type: "string", maxLength: 4096 } as const;
const shortText = { type: "string", maxLength: 256 } as const;
const boolean = { type: "boolean" } as const;
const count = { type: "integer", minimum: 0 } as const;
const object = (properties: Record<string, ApiSchema> = {}, required: string[] = []): ApiSchema =>
  ({ type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const array = (items: ApiSchema): ApiSchema => ({ type: "array", items });
const empty = object();
const summarySchema = object({ bytes: count, lines: count, sha256: shortText }, ["bytes", "lines", "sha256"]);
const itemList = (item: ApiSchema) => object({ items: array(item), invalidItems: count }, ["items", "invalidItems"]);
const pluginId = { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" } as const;
const pluginSchema = object({ id: shortText, name: text, version: shortText, description: text, author: text,
  status: shortText, hasConfig: boolean, hasPages: boolean, downloadOrigin: shortText }, ["id"]);
const schemaSummary = object({ action: shortText, title: text, tags: array(shortText), parametersDeclared: boolean,
  responseDeclared: boolean, relatedOperation: shortText }, ["action", "parametersDeclared", "responseDeclared", "relatedOperation"]);
const cpuSchema = object({ core: count, model: text, speed: shortText,
  usage: object({ system: shortText, qq: shortText }) });
const statusSchema = object({ cpu: cpuSchema, memory: object({ total: shortText, usage: object({ system: shortText, qq: shortText }) }), arch: shortText });
const sampleParams = object({ maxEvents: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum events before stream end or the configured read deadline." } });
const sampleResponse = (item: ApiSchema) => object({ mode: { const: "sample" }, events: array(item), invalidEvents: count, ended: boolean, timedOut: boolean },
  ["mode", "events", "invalidEvents", "ended", "timedOut"]);

/** Reviewed 4.18.4 paths. Callers choose an operation, never an upstream method, URL or credential. */
export const napcatWebuiApiReadSpecs: readonly ReadSpec[] = [
  { ...napcatWebuiApiReadRoutes["mirrors"]!, params: empty,
    response: itemList(object({ origin: shortText }, ["origin"])) },
  { ...napcatWebuiApiReadRoutes["file-hash"]!, params: empty,
    response: object({ hash: shortText, file: shortText, algorithm: shortText }, ["hash", "file", "algorithm"]) },
  { ...napcatWebuiApiReadRoutes["version"]!, params: empty,
    response: object({ version: shortText }, ["version"]) },
  { ...napcatWebuiApiReadRoutes["system-events"]!, params: sampleParams,
    response: sampleResponse(statusSchema), kind: "system-events" },
  { ...napcatWebuiApiReadRoutes["qq-version"]!, params: empty,
    response: object({ version: shortText }, ["version"]) },
  { ...napcatWebuiApiReadRoutes["theme"]!, params: empty,
    response: object({ fontMode: shortText, darkEntries: count, lightEntries: count }, ["darkEntries", "lightEntries"]) },
  { ...napcatWebuiApiReadRoutes["schemas"]!, params: empty,
    response: itemList(schemaSummary) },
  { ...napcatWebuiApiReadRoutes["log"]!,
    params: object({ id: { type: "string", minLength: 1, maxLength: 200, pattern: "^[^/\\\\:\\u0000-\\u001f]+$" } }, ["id"]), response: summarySchema,
    relatedOperations: ["manager.napcat.health"] },
  { ...napcatWebuiApiReadRoutes["log-files"]!, params: empty,
    response: itemList(shortText) },
  { ...napcatWebuiApiReadRoutes["log-events"]!, params: sampleParams,
    response: sampleResponse(summarySchema), kind: "log-events" },
  { ...napcatWebuiApiReadRoutes["plugin-icon"]!,
    params: object({ pluginId }, ["pluginId"]), response: object({ bytes: count, sha256: shortText, contentType: shortText }, ["bytes", "sha256", "contentType"]), kind: "resource" },
  { ...napcatWebuiApiReadRoutes["plugins"]!, params: empty,
    response: itemList(pluginSchema) },
  { ...napcatWebuiApiReadRoutes["plugin-page"]!,
    params: object({ pluginId, pagePath: { type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\\\:\\u0000-\\u001f?#]+$" } }, ["pluginId", "pagePath"]),
    response: object({ bytes: count, sha256: shortText, contentType: shortText }, ["bytes", "sha256", "contentType"]), kind: "resource" },
  { ...napcatWebuiApiReadRoutes["store-plugin"]!,
    params: object({ id: pluginId }, ["id"]), response: pluginSchema },
  { ...napcatWebuiApiReadRoutes["store-plugins"]!,
    params: object({ forceRefresh: boolean }), response: itemList(pluginSchema) },
  { ...napcatWebuiApiReadRoutes["health"]!, params: empty,
    response: object({ authenticated: { const: true } }, ["authenticated"]), relatedOperations: ["manager.napcat.health"] },
  { ...napcatWebuiApiReadRoutes["ssl-status"]!, params: empty,
    response: object({ enabled: boolean, certExists: boolean, keyExists: boolean, certificate: object({ status: { enum: ["parsed", "missing", "invalid"] },
      subject: text, issuer: text, validFrom: shortText, validTo: shortText, serialNumber: shortText, fingerprint256: shortText }, ["status"]) },
    ["enabled", "certExists", "keyExists", "certificate"]) },
];

function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NapcatApiError(503, "QQ_WEBUI_RESPONSE_INVALID");
  return value as Row;
}
function strings(value: Row, fields: readonly string[], maxLength = 4096): Row {
  return Object.fromEntries(fields.filter(key => typeof value[key] === "string").map(key => [key, String(value[key]).slice(0, maxLength)]));
}
function origin(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try { const url = new URL(value); if (["http:", "https:"].includes(url.protocol)) return url.origin; } catch { /* Invalid metadata is counted by the list owner. */ }
}
function plugin(value: unknown): Row {
  const source = row(value);
  if (typeof source.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(source.id)) throw new NapcatApiError(503, "QQ_WEBUI_PLUGIN_METADATA_INVALID");
  const result = { ...strings(source, ["name", "description", "author"]), ...strings(source, ["id", "version", "status"], 256) };
  for (const key of ["hasConfig", "hasPages"]) if (typeof source[key] === "boolean") result[key] = source[key];
  const downloadOrigin = origin(source.downloadUrl);
  if (downloadOrigin) result.downloadOrigin = downloadOrigin;
  return result;
}
function list(value: unknown, project: (value: unknown) => unknown): Row {
  if (!Array.isArray(value)) throw new NapcatApiError(503, "QQ_WEBUI_RESPONSE_INVALID");
  const items: unknown[] = [];
  let invalidItems = 0;
  for (const item of value) {
    try { items.push(project(item)); } catch { invalidItems++; }
  }
  return { items, invalidItems };
}
function summarizeText(value: unknown): Row {
  if (typeof value !== "string") throw new NapcatApiError(503, "QQ_WEBUI_RESPONSE_INVALID");
  return { bytes: Buffer.byteLength(value), lines: value ? value.split(/\r?\n/).length : 0, sha256: createHash("sha256").update(value).digest("hex") };
}
export function projectNapcatWebuiSslStatus(value: unknown): Row {
  const data = row(value);
  if (["enabled", "certExists", "keyExists"].some(key => typeof data[key] !== "boolean")) throw new NapcatApiError(503, "QQ_WEBUI_RESPONSE_INVALID");
  let certificate: Row = { status: "missing" };
  if (typeof data.certContent === "string" && data.certContent) {
    try {
      const parsed = new X509Certificate(data.certContent);
      certificate = { status: "parsed", subject: parsed.subject.slice(0, 4096), issuer: parsed.issuer.slice(0, 4096), validFrom: parsed.validFrom.slice(0, 256),
        validTo: parsed.validTo.slice(0, 256), serialNumber: parsed.serialNumber.slice(0, 256), fingerprint256: parsed.fingerprint256 };
    } catch { certificate = { status: "invalid" }; }
  }
  return { enabled: data.enabled, certExists: data.certExists, keyExists: data.keyExists, certificate };
}
function projectJson(id: string, value: unknown): unknown {
  if (id === "health") return { authenticated: true };
  if (id === "qq-version") {
    if (typeof value !== "string") throw new NapcatApiError(503, "QQ_WEBUI_RESPONSE_INVALID");
    return { version: value.slice(0, 256) };
  }
  if (id === "log") return summarizeText(value);
  if (id === "log-files") return list(value, item => {
    if (typeof item !== "string" || !item || item.length > 256 || /[/\\:]|\.\./.test(item)) throw new Error("Invalid log identifier");
    return item;
  });
  const data = row(value);
  switch (id) {
    case "ssl-status": return projectNapcatWebuiSslStatus(data);
    case "version": return strings(data, ["version"], 256);
    case "file-hash": return strings(data, ["hash", "file", "algorithm"], 256);
    case "mirrors": return list(data.mirrors, item => { const value = origin(item); if (!value) throw new Error("Invalid origin"); return { origin: value }; });
    case "theme": return { ...strings(data, ["fontMode"]), darkEntries: Object.keys(row(data.dark)).length, lightEntries: Object.keys(row(data.light)).length };
    case "plugins": case "store-plugins": return list(data.plugins, plugin);
    case "store-plugin": return plugin(data);
    case "schemas": return list(Object.entries(data), item => {
      const [action, raw] = item as [string, unknown];
      if (action.length > 200 || !/^\.?[A-Za-z_][A-Za-z0-9_]*$/.test(action)) throw new Error("Invalid action");
      const schema = row(raw);
      return { action, ...(typeof schema.description === "string" ? { title: schema.description.slice(0, 4096) } : {}),
        ...(Array.isArray(schema.tags) ? { tags: schema.tags.filter((tag): tag is string => typeof tag === "string").map(tag => tag.slice(0, 256)) } : {}),
        parametersDeclared: schema.payload !== undefined, responseDeclared: schema.response !== undefined,
        relatedOperation: `agent.qq.onebot.${action}` };
    });
    default: throw new NapcatApiError(404, "QQ_WEBUI_OPERATION_NOT_REGISTERED");
  }
}

function upstreamPath(spec: ReadSpec, params: Params): string {
  let pathname = spec.upstreamPath;
  for (const key of ["pluginId", "pagePath", "id"]) {
    if (!pathname.includes(`:${key}`)) continue;
    const value = String(params[key]);
    if (value.split("/").some(part => !part || part === "." || part === "..")) throw new NapcatApiError(400, "QQ_WEBUI_PARAMETERS_INVALID");
    pathname = pathname.replace(`:${key}`, encodeURIComponent(value));
  }
  const query = new URLSearchParams();
  if (spec.id === "log") {
    if (String(params.id).includes("..")) throw new NapcatApiError(400, "QQ_WEBUI_PARAMETERS_INVALID");
    query.set("id", String(params.id));
  }
  if (spec.id === "store-plugins" && params.forceRefresh !== undefined) query.set("forceRefresh", String(params.forceRefresh));
  return pathname + (query.size ? `?${query}` : "");
}

async function readWebuiJson(response: Response): Promise<unknown> {
  const bytes = await boundedBytes(response, qqReadSettings.jsonBytes, "RABIROUTE_QQ_JSON_MAX_BYTES");
  let envelope: { code?: unknown; data?: unknown };
  try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw new NapcatApiError(503, "QQ_WEBUI_RESPONSE_INVALID"); }
  if (!envelope || envelope.code !== 0) throw new NapcatApiError(503, "QQ_WEBUI_UPSTREAM_REJECTED");
  return envelope.data;
}

async function verifyWebuiAccount(session: NapcatWebuiApiSession, selection: NapcatApiSelection, signal: AbortSignal): Promise<void> {
  const actual = row(await readWebuiJson(await session.requestFixed("POST", "/api/QQLogin/GetQQLoginInfo", signal)));
  selection.assertCurrent(); session.assertCurrent();
  if (String(actual.uin ?? "") !== selection.botUserId) throw new NapcatApiError(409, "QQ_WEBUI_ACCOUNT_MISMATCH");
}

async function readSample(response: Response, spec: ReadSpec, maxEvents: number, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new NapcatApiError(503, "QQ_WEBUI_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let pending = "";
  let size = 0;
  let seenEvents = 0;
  let invalidEvents = 0;
  let ended = false;
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (seenEvents < maxEvents) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) { ended = true; break; }
      size += next.value.length;
      if (size > qqReadSettings.jsonBytes) throw new NapcatApiError(413, "QQ_WEBUI_RESPONSE_TOO_LARGE");
      pending = (pending + decoder.decode(next.value, { stream: true })).replaceAll("\r\n", "\n");
      let boundary: number;
      while (seenEvents < maxEvents && (boundary = pending.indexOf("\n\n")) !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        seenEvents++;
        if (spec.kind === "log-events") events.push(summarizeText(data));
        else {
          try { events.push(projectStatus(JSON.parse(data))); }
          catch { invalidEvents++; }
        }
      }
    }
    return { mode: "sample", events, invalidEvents, ended, timedOut: false };
  } catch (error) {
    if (signal.aborted && signal.reason?.name === "TimeoutError") return { mode: "sample", events, invalidEvents, ended: false, timedOut: true };
    throw error;
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function projectStatus(value: unknown): Row {
  const data = row(value), cpu = row(data.cpu), memory = row(data.memory);
  return { ...strings(data, ["arch"], 256), cpu: { ...strings(cpu, ["model"]), ...strings(cpu, ["speed"], 256), ...(Number.isSafeInteger(cpu.core) && Number(cpu.core) >= 0 ? { core: cpu.core } : {}),
    usage: strings(row(cpu.usage), ["system", "qq"], 256) }, memory: { ...strings(memory, ["total"], 256), usage: strings(row(memory.usage), ["system", "qq"], 256) } };
}

function contractFor(spec: ReadSpec): ApiOperationContract {
  return { operationId: `agent.qq.webui.${spec.id}`, contractVersion: "1.0.0", method: "POST", pathTemplate: `/api/agent/qq/webui/${spec.id}`,
    description: `${spec.title}. Fixed NapCat 4.18.4 ${spec.method} ${spec.upstreamPath}; results contain reviewed fields or content summaries.`,
    exposure: "public", transport: "http", request: { path: empty, query: empty, headers: { type: "object" }, deadlineMs: qqReadSettings.readTimeoutMs,
      body: { kind: "json", maxBytes: qqReadSettings.jsonBytes, schema: object({ routeId: { type: "string", minLength: 1, maxLength: 256 },
        instanceId: { type: "string", minLength: 1, maxLength: 256 }, params: spec.params }, ["routeId", "instanceId", "params"]) } },
    responses: { "200": { mediaType: "application/json", schema: object({ code: { const: 0 }, data: spec.response }, ["code", "data"]) },
      default: { mediaType: "application/json", schema: object({ code: { const: -1 }, errorCode: shortText }, ["code", "errorCode"]) } },
    effects: { mode: "read", description: "Verify the exact configured QQ account and original WebUI session. SSE reads return bounded samples and release their reader." },
    recovery: { strategy: "read", description: "Repeat the same read after resolving its original binding or authentication error." },
    validators: [{ id: "napcat.webui.fixed-contract", description: "Fixed method/path, closed parameters, bounded result and original WebUI credential owner." }] };
}

export function createNapcatWebuiApiOperations(context: NapcatWebuiApiContext): readonly ApiOperationDefinition[] {
  return napcatWebuiApiReadSpecs.map(spec => {
    const contract = contractFor(spec);
    const compiled = compileApiContract({ contract });
    return { contract, discovery: { title: spec.title, category: { id: "qq-webui", title: "QQ / NapCat management reads" }, relatedOperations: spec.relatedOperations },
      handler: async (input: ApiOperationInput) => {
        try {
          if (input.url.pathname !== contract.pathTemplate || input.url.search || Object.keys(input.query ?? {}).length || Object.keys(input.path ?? {}).length || !compiled.bodyValidator?.(input.body)) {
            throw new NapcatApiError(400, "QQ_WEBUI_PARAMETERS_INVALID");
          }
          const body = input.body as { routeId: string; instanceId: string; params: Params };
          const pathname = upstreamPath(spec, body.params);
          const selection = selectNapcatApiInstance(context, input.request, body.routeId, body.instanceId, input.signal);
          const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(qqReadSettings.readTimeoutMs)]) : AbortSignal.timeout(qqReadSettings.readTimeoutMs);
          await verifyNapcatApiIdentity(context, selection, signal);
          const session = await context.openWebuiSession(selection, signal);
          selection.assertCurrent(); session.assertCurrent();
          await verifyWebuiAccount(session, selection, signal);
          const response = await session.requestFixed(spec.method, pathname, signal);
          selection.assertCurrent(); session.assertCurrent();
          let data: unknown;
          if (spec.kind === "log-events" || spec.kind === "system-events") data = await readSample(response, spec, Number(body.params.maxEvents ?? 1), signal);
          else if (spec.kind !== "resource") data = projectJson(spec.id, await readWebuiJson(response));
          else {
            const bytes = await boundedBytes(response, qqReadSettings.mediaBytes, "RABIROUTE_QQ_MEDIA_MAX_BYTES");
            const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
            if (spec.id === "plugin-icon" && !/^image\/[a-z0-9.+-]+$/i.test(contentType) || spec.id === "plugin-page" && contentType !== "text/html") {
              throw new NapcatApiError(503, "QQ_WEBUI_RESOURCE_TYPE_INVALID");
            }
            data = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentType };
          }
          selection.assertCurrent(); session.assertCurrent();
          const result = { code: 0, data };
          if (!compiled.responseValidators.get("200")?.[0]?.body?.(result)) throw new NapcatApiError(503, "QQ_WEBUI_RESPONSE_INVALID");
          return { status: 200, body: result, headers: { "cache-control": "private, no-store" } };
        } catch (error) { return napcatApiFailure(error); }
      } };
  });
}
