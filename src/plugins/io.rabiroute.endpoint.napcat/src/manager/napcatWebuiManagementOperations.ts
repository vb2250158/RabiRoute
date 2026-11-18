import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { compileApiContract, type ApiOperationContract, type ApiOperationDefinition, type ApiOperationInput, type ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import { executeDurableDelivery, readDurableDeliveryReceipt } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { definitionUsesNapcat } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { boundedBytes } from "./qqMessageMedia.js";
import { assertNapcatApiRequestAuthority, NapcatApiError, napcatApiFailure, type NapcatApiTransportContext } from "./napcatApiTransport.js";
import { napcatWebuiManagementDescriptors, type NapcatWebuiManagementDescriptor } from "./napcatWebuiManagementContracts.js";

type Row = Record<string, unknown>;
export type NapcatWebuiManagementSelection = Readonly<{ routeId: string; instanceId: string; expectedUserId: string; assertCurrent(): void }>;
export type NapcatWebuiManagementSession = {
  assertCurrent(): void;
  requestManagement(method: "GET" | "POST", pathname: string, body: Row, signal: AbortSignal): Promise<Response>;
  runBindingOperation<T>(operation: () => Promise<T>): Promise<T>;
};
export type NapcatWebuiManagementContext = NapcatApiTransportContext & {
  rootDir: string;
  readOnly(): boolean;
  openManagementSession(selection: NapcatWebuiManagementSelection, signal: AbortSignal): Promise<NapcatWebuiManagementSession>;
};
class ManagementError extends NapcatApiError {
  constructor(code: string, status = 503) { super(status, `QQ_WEBUI_${code}`); }
}
const namespace = "napcat-webui-management-v1";
const short = { type: "string", minLength: 1, maxLength: 256 } as const;
const empty = { type: "object", additionalProperties: false } as const;
const failure = { type: "object", additionalProperties: false, required: ["code", "errorCode"], properties: { code: { const: -1 }, errorCode: short } } as const;
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagementError("RESPONSE_INVALID");
  return value as Row;
}
function digest(value: unknown): string {
  const stable = (input: unknown): unknown => Array.isArray(input) ? input.map(stable) : input && typeof input === "object"
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, stable((input as Row)[key])])) : input;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
function fingerprint(value: unknown): Row {
  if (typeof value !== "string" || !value) throw new ManagementError("NATIVE_IDENTITY_UNAVAILABLE");
  return { present: true, fingerprint256: createHash("sha256").update(value).digest("hex") };
}
function safeOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return;
  let url: URL;
  try { url = new URL(value); } catch { throw new ManagementError("NATIVE_CONFIG_INVALID"); }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new ManagementError("NATIVE_CONFIG_INVALID");
  return url.origin;
}
function onebotView(value: unknown): Row {
  const source = object(value), network = object(source.network), output: Row = {};
  for (const key of ["httpServers", "httpSseServers", "httpClients", "websocketServers", "websocketClients", "plugins"]) {
    if (!Array.isArray(network[key])) throw new ManagementError("NATIVE_CONFIG_INVALID");
    output[key] = (network[key] as unknown[]).map(item => {
      const native = object(item);
      const dto: Row = { tokenPresent: typeof native.token === "string" && native.token.length > 0 };
      for (const field of ["name", "host", "messagePostFormat"]) if (typeof native[field] === "string") dto[field] = native[field];
      for (const field of ["enable", "reportSelfMessage", "debug"]) if (typeof native[field] === "boolean") dto[field] = native[field];
      for (const field of ["port", "heartInterval"]) if (Number.isSafeInteger(native[field]) && Number(native[field]) >= 0) dto[field] = native[field];
      const urlOrigin = safeOrigin(native.url);
      if (urlOrigin) dto.urlOrigin = urlOrigin;
      return dto;
    });
  }
  const result: Row = { configDigest: digest(source), network: output };
  for (const field of ["enableLocalFile2Url", "parseMultMsg"]) if (typeof source[field] === "boolean") result[field] = source[field];
  const musicSignOrigin = safeOrigin(source.musicSignUrl), imageDownloadProxyOrigin = safeOrigin(source.imageDownloadProxy);
  if (musicSignOrigin) result.musicSignOrigin = musicSignOrigin;
  if (imageDownloadProxyOrigin) result.imageDownloadProxyOrigin = imageDownloadProxyOrigin;
  if (source.timeout) result.timeout = Object.fromEntries(Object.entries(object(source.timeout)).filter(([key, value]) =>
    ["baseTimeout", "uploadSpeedKBps", "downloadSpeedKBps", "maxTimeout"].includes(key) && Number.isSafeInteger(value) && Number(value) >= 0));
  return result;
}
function backups(value: unknown, prefix: string): Row {
  if (!Array.isArray(value)) throw new ManagementError("RESPONSE_INVALID");
  const items: Array<{ backupName: string }> = [];
  let invalidItems = 0;
  for (const backupName of value) {
    if (typeof backupName !== "string" || backupName.length > 256 || !backupName.startsWith(prefix) || /[/\\:]|\.\./.test(backupName)) invalidItems++;
    else items.push({ backupName });
  }
  return { items, invalidItems };
}

/** Original connection authority with an optional configured QQ during first-login management. */
export function selectNapcatWebuiManagementInstance(context: NapcatApiTransportContext, request: IncomingMessage,
  routeId: string, instanceId: string, signal?: AbortSignal): NapcatWebuiManagementSelection {
  const authorize = () => assertNapcatApiRequestAuthority(context, request, signal);
  authorize();
  const definition = context.route(routeId);
  if (!definition || definition.id !== routeId || definition.enabled !== true || !definitionUsesNapcat(definition)) throw new ManagementError("ROUTE_UNAVAILABLE", 409);
  const matches = definition.napcatInstances?.filter(item => item.id === instanceId && item.enabled !== false) ?? [];
  if (matches.length !== 1) throw new ManagementError("INSTANCE_UNAVAILABLE", 409);
  const expectedUserId = String(matches[0]!.botUserId ?? "");
  if (expectedUserId && !/^[1-9]\d{0,19}$/.test(expectedUserId)) throw new ManagementError("CONFIGURED_ACCOUNT_INVALID", 409);
  return Object.freeze({ routeId, instanceId, expectedUserId, assertCurrent: () => {
    authorize();
    const current = context.route(routeId);
    const instances = current?.napcatInstances?.filter(item => item.id === instanceId && item.enabled !== false) ?? [];
    if (current !== definition || current.enabled !== true || !definitionUsesNapcat(current) || instances.length !== 1
      || String(instances[0]!.botUserId ?? "") !== expectedUserId) throw new ManagementError("BINDING_CHANGED", 409);
  } });
}

async function call(session: NapcatWebuiManagementSession, binding: NapcatWebuiManagementSelection, method: "GET" | "POST",
  pathname: string, params: Row, signal: AbortSignal): Promise<unknown> {
  binding.assertCurrent(); session.assertCurrent();
  let response: Response;
  try { response = await session.requestManagement(method, pathname, params, signal); }
  catch (error) { if (error instanceof NapcatApiError) throw error; throw new ManagementError("TRANSPORT_UNAVAILABLE"); }
  const bytes = await boundedBytes(response, qqReadSettings.jsonBytes, "RABIROUTE_QQ_JSON_MAX_BYTES");
  binding.assertCurrent(); session.assertCurrent();
  let envelope: { code?: unknown; data?: unknown };
  try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw new ManagementError("RESPONSE_INVALID"); }
  if (!response.ok || !envelope || envelope.code !== 0) throw new ManagementError("AUTH_OR_OPERATION_REJECTED");
  return envelope.data;
}
async function bootstrap(session: NapcatWebuiManagementSession, binding: NapcatWebuiManagementSelection, signal: AbortSignal) {
  const status = object(await call(session, binding, "POST", "/api/QQLogin/CheckLoginStatus", {}, signal));
  if (typeof status.isLogin !== "boolean") throw new ManagementError("LOGIN_STATUS_NOT_EXPLICIT");
  const value = await call(session, binding, "POST", "/api/QQLogin/GetQQLoginInfo", {}, signal);
  const account = value == null ? {} : object(value);
  const actual = account.uin === 0 || account.uin === "0" ? "" : String(account.uin ?? "");
  if (actual && !/^[0-9]{5,20}$/.test(actual)) throw new ManagementError("LOGIN_ACCOUNT_INVALID");
  if (actual && !binding.expectedUserId) throw new ManagementError("CONFIGURED_ACCOUNT_REQUIRED", 409);
  if (actual && actual !== binding.expectedUserId) throw new ManagementError("ACCOUNT_MISMATCH", 409);
  if (status.isLogin && !actual) throw new ManagementError("LOGIN_ACCOUNT_NOT_OBSERVED");
  return { loggedIn: status.isLogin };
}
function project(id: string, value: unknown, params: Row): Row {
  if (id === "webui-config") {
    const source = object(value);
    return Object.fromEntries(["host", "port", "loginRate", "disableWebUI", "accessControlMode", "ipWhitelist", "ipBlacklist", "enableXForwardedFor"].map(key => [key, source[key]]));
  }
  if (id === "webui-disabled") return { disabled: value };
  if (id === "webui-client-ip") return { ip: object(value).ip };
  if (id === "onebot-config") return onebotView(value);
  if (id === "platform") return { platform: object(value).platform };
  if (id === "login-qr") {
    const qrcode = object(value).qrcode;
    if (typeof qrcode !== "string" || !qrcode) throw new ManagementError("LOGIN_QR_NOT_AVAILABLE");
    return { available: true, payloadFingerprint: digest(qrcode), relatedOperation: "manager.napcat.login-panel" };
  }
  if (id === "quick-login-legacy") {
    if (!Array.isArray(value)) throw new ManagementError("RESPONSE_INVALID");
    const userIds = value.filter(item => typeof item === "string" && /^[0-9]{5,20}$/.test(item));
    return { userIds, invalidItems: value.length - userIds.length };
  }
  if (id === "quick-login-preference") return { userId: value };
  if (id === "windows-guid") return fingerprint(object(value).guid);
  if (id === "windows-guid-backups") return backups(value, "Registry20.bak.");
  if (id === "linux-mac") return fingerprint(object(value).mac);
  if (id === "linux-machine-id") return fingerprint(object(value).machineId);
  if (id === "linux-machine-backups") return backups(value, "machine-info.bak.");
  if (id === "linux-guid-compute") {
    const source = object(value);
    if (typeof source.machineId !== "string" || !source.machineId || typeof source.mac !== "string" || !source.mac
      || typeof source.guid !== "string" || !/^[0-9a-f]{32}$/i.test(source.guid)) throw new ManagementError("NATIVE_IDENTITY_UNAVAILABLE");
    const expected = createHash("md5").update(source.machineId, "ascii").update(source.mac, "ascii").digest("hex");
    if (expected !== source.guid.toLowerCase()) throw new ManagementError("IDENTITY_DIGEST_MISMATCH");
    return { guidFingerprint256: fingerprint(source.guid).fingerprint256, inputSource: params.mac && params.machineId ? "explicit" : "native-file", nativeIdentityExposed: false };
  }
  throw new ManagementError("OPERATION_NOT_REGISTERED", 404);
}

function contractFor(spec: NapcatWebuiManagementDescriptor): ApiOperationContract {
  const mutation = spec.effects === "configuration-mutation";
  return { operationId: `agent.qq.webui.management.${spec.id}`, contractVersion: "1.0.0", method: "POST",
    pathTemplate: `/api/agent/qq/webui-management/${spec.id}`, exposure: "public", transport: "http", description: spec.description,
    request: { path: empty, query: empty, headers: { type: "object" }, deadlineMs: qqReadSettings.readTimeoutMs,
      body: { kind: "json", maxBytes: qqReadSettings.jsonBytes, schema: { type: "object", additionalProperties: false,
        required: ["routeId", "instanceId", "params", ...(mutation ? ["deliveryId"] : [])], properties: { routeId: short, instanceId: short, params: spec.params,
          ...(mutation ? { deliveryId: { type: "string", minLength: 1, maxLength: 200 } } : {}) } } } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["code", "data"],
      properties: { code: { const: 0 }, data: spec.response, delivery: { type: "object" } } } },
    "202": { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["code", "delivery"], properties: { code: { const: 0 }, delivery: { type: "object" } } } },
    default: { mediaType: "application/json", schema: failure } },
    effects: { mode: mutation ? "external-mutation" : "read", description: mutation
      ? "Original native config/binding owner with durable original deliveryId and sanitized readback result. Preference writes do not submit a QQ login. Native account is rechecked immediately before writing and after readback. External native clients do not share an atomic CAS with Rabi."
      : "Explicit native login state and original configured management session, including first-login metadata." },
    recovery: { strategy: mutation ? "original-receipt-no-replay" : "read", receiptPath: "/api/agent/qq/webui-management-receipts/:deliveryId",
      description: "Authentication and transport failures are not logged-out evidence. Original uncertain mutation receipts remain uncertain; existing legacy requests are not relabelled." },
    validators: [{ id: "napcat.management.binding", description: "Original connection authority and immutable Route/instance/WebUI snapshot. Only explicit native false enters bootstrap." }] };
}

export function createNapcatWebuiManagementOperations(context: NapcatWebuiManagementContext): readonly ApiOperationDefinition[] {
  return napcatWebuiManagementDescriptors.map(spec => {
    const mutation = spec.effects === "configuration-mutation", contract = contractFor(spec), compiled = compileApiContract({ contract });
    return { contract, discovery: { title: `NapCat ${spec.id}`, category: { id: "qq-webui", title: "QQ / NapCat management" },
      relatedOperations: spec.id === "login-qr" ? ["manager.napcat.login-panel"] : spec.id === "onebot-config" ? ["manager.napcat.configure-onebot"] : [] },
      handler: async (input: ApiOperationInput) => {
        try {
          if (input.url.pathname !== contract.pathTemplate || input.url.search || Object.keys(input.query ?? {}).length || Object.keys(input.path ?? {}).length
            || !compiled.bodyValidator?.(input.body)) throw new ManagementError("PARAMETERS_INVALID", 400);
          if (mutation && context.readOnly()) throw new ManagementError("READ_ONLY", 403);
          const body = input.body as { routeId: string; instanceId: string; params: Row; deliveryId?: string };
          const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(qqReadSettings.readTimeoutMs)]) : AbortSignal.timeout(qqReadSettings.readTimeoutMs);
          const binding = selectNapcatWebuiManagementInstance(context, input.request, body.routeId, body.instanceId, signal);
          const session = await context.openManagementSession(binding, signal);
          binding.assertCurrent(); session.assertCurrent();
          const state = await bootstrap(session, binding, signal);
          if (spec.binding === "login-required" && !state.loggedIn) throw new ManagementError("LOGIN_REQUIRED", 409);
          if (spec.binding === "login-required-false" && state.loggedIn) throw new ManagementError("ALREADY_LOGGED_IN", 409);
          if (spec.binding === "windows-native-file") {
            const platform = object(await call(session, binding, "POST", "/api/QQLogin/GetPlatformInfo", {}, signal)).platform;
            if (platform !== "win32") throw new ManagementError("WINDOWS_DPAPI_REQUIRED", 409);
          }
          const validateResult = (data: Row) => {
            if (!compiled.responseValidators.get("200")?.[0]?.body?.({ code: 0, data })) throw new ManagementError("RESPONSE_INVALID");
            return data;
          };
          if (!mutation) {
            const data = validateResult(project(spec.id, await call(session, binding, spec.method, spec.nativePath, body.params, signal), body.params));
            return { status: 200, headers: { "cache-control": "private, no-store" }, body: { code: 0, data } };
          }
          if (spec.id === "quick-login-preference.set" && body.params.userId && body.params.userId !== binding.expectedUserId) throw new ManagementError("ACCOUNT_MISMATCH", 409);
          const outcome = await session.runBindingOperation(() => executeDurableDelivery({ rootDir: context.rootDir, namespace, deliveryId: body.deliveryId,
            payload: { operation: spec.id, routeId: body.routeId, instanceId: body.instanceId, expectedUserId: binding.expectedUserId, params: body.params },
            audit: { operation: spec.id, routeId: body.routeId, instanceId: body.instanceId, expectedUserId: binding.expectedUserId }, requestAuthority: binding.assertCurrent,
            deliver: async () => {
              const preference = spec.id === "quick-login-preference.set";
              let expectedReadback: unknown = body.params.userId;
              if (!preference) {
                await bootstrap(session, binding, signal);
                const before = object(await call(session, binding, "GET", "/api/base/Theme", {}, signal));
                const patch = object(body.params.theme);
                expectedReadback = { ...before, ...patch,
                  dark: { ...object(before.dark), ...object(patch.dark) },
                  light: { ...object(before.light), ...object(patch.light) } };
              }
              const nativeParams = preference ? { uin: body.params.userId } : { theme: body.params.theme };
              await bootstrap(session, binding, signal);
              await call(session, binding, spec.method, spec.nativePath, nativeParams, signal);
              const readback = await call(session, binding, preference ? "POST" : "GET", preference ? "/api/QQLogin/GetQuickLoginQQ" : "/api/base/Theme", {}, signal);
              await bootstrap(session, binding, signal);
              if (digest(readback) !== digest(expectedReadback)) throw new ManagementError("WRITE_READBACK_MISMATCH");
              return validateResult({ applied: true, afterDigest: digest(readback) });
            } }));
          binding.assertCurrent(); session.assertCurrent();
          if (outcome.state === "conflict") throw new ManagementError("DELIVERY_CONFLICT", 409);
          return outcome.state === "completed" ? { status: 200, body: { code: 0, data: outcome.result,
            delivery: { deliveryId: outcome.deliveryId, state: outcome.state, duplicate: outcome.duplicate, nativeCrossClientCas: false } } }
            : { status: 202, body: { code: 0, delivery: { deliveryId: outcome.deliveryId, state: outcome.state, retryable: false, nativeCrossClientCas: false } } };
        } catch (error) { return napcatApiFailure(error); }
      } };
  });
}

export function createNapcatWebuiManagementReceiptOperation(context: NapcatWebuiManagementContext): ApiOperationDefinition {
  const contract: ApiOperationContract = { operationId: "agent.qq.webui.management.receipt.read", contractVersion: "1.0.0", method: "GET",
    pathTemplate: "/api/agent/qq/webui-management-receipts/:deliveryId", exposure: "public", transport: "http",
    description: "Read the original management receipt without a platform call, replay or state update.",
    request: { path: { type: "object", additionalProperties: false, required: ["deliveryId"], properties: { deliveryId: short } },
      query: { type: "object", additionalProperties: false, required: ["routeId", "instanceId"], properties: { routeId: short, instanceId: short } }, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["code", "receipt"], properties: { code: { const: 0 },
      receipt: { type: "object", additionalProperties: false, required: ["deliveryId", "state", "createdAt", "updatedAt", "operation", "retryable"], properties: {
        deliveryId: short, state: { enum: ["reserved", "sending", "completed", "uncertain"] }, createdAt: short, updatedAt: short, operation: short, retryable: { const: false } } } } } }, default: { mediaType: "application/json", schema: failure } },
    effects: { mode: "read", description: "Exact original receipt and configured management binding only." }, recovery: { strategy: "retain-original-id", description: "No platform query or mutation." }, validators: [] };
  const compiled = compileApiContract({ contract });
  return { contract, discovery: { title: "Read NapCat management receipt", category: { id: "qq-webui", title: "QQ / NapCat management" } }, handler: async input => {
    try {
      if (!compiled.pathValidator?.(input.path) || !compiled.queryValidator?.(input.query)) throw new ManagementError("PARAMETERS_INVALID", 400);
      const binding = selectNapcatWebuiManagementInstance(context, input.request, String(input.query.routeId), String(input.query.instanceId), input.signal);
      const receipt = readDurableDeliveryReceipt(context.rootDir, namespace, String(input.path.deliveryId));
      binding.assertCurrent();
      const audit = receipt?.audit as Row | undefined;
      if (!receipt || audit?.routeId !== binding.routeId || audit?.instanceId !== binding.instanceId || audit?.expectedUserId !== binding.expectedUserId
        || typeof audit.operation !== "string") throw new ManagementError("RECEIPT_NOT_FOUND", 404);
      return { status: 200, headers: { "cache-control": "private, no-store" }, body: { code: 0, receipt: {
        deliveryId: receipt.deliveryId, state: receipt.state, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt, operation: audit.operation, retryable: false } } };
    } catch (error) { return napcatApiFailure(error); }
  } };
}
