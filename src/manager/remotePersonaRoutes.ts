import { ReadSettingsError } from "../shared/readSettingsError.js";
import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { personaReadSettings } from "../shared/personaReadSettings.js";
import { assertRoleAcceptsWork } from "../roleLifecycle.js";
import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";
import { createHash } from "node:crypto";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { normalizeRemotePersonaReference } from "../shared/remotePersonaReference.js";
import type { LanguageStyleValidationResult } from "../languageStyleValidation.js";
import { TunnelDenied } from "../peerTunnel/security.js";
import { personaConfigFragmentFromValue } from "./configMigration.js";
import { ROLE_CONTEXT_ROUTE_HEADER, ROLE_CONTEXT_CAPABILITY_HEADER, ROLE_CONTEXT_GENERATION_HEADER, ROLE_CONTEXT_MANAGER_HEADER } from "./roleContextProjection.js";
import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { preparePersonaResourceAdmission } from "./personaResourceAdmission.js";

type Identity = { applicationGenerationId: string; managerInstanceId: string };
export type RemotePersonaReadContext = {
  identity(): Identity;
  managerBaseUrl: string;
  remoteGeneration(deviceId: string): Promise<string>;
  fetchRemote(deviceId: string, pathname: string, init: RequestInit): Promise<Response>;
  signal?: AbortSignal;
};
export type PersonaReferenceSnapshot = Identity & {
  schemaVersion: 1;
  roleId: string;
  file: string;
  document: string;
  personaConfig: Partial<GatewayDefinition>;
  revision: string;
};
export type RemotePersonaSnapshot = PersonaReferenceSnapshot & {
  deviceId: string;
  remoteApplicationGenerationId: string;
  remoteManagerInstanceId: string;
  knowledgeApiBaseUrl: string;
};
export class RemotePersonaError extends Error {
  constructor(message: string, readonly statusCode = 503, readonly code = "REMOTE_PERSONA_UNAVAILABLE") { super(message); }
}


function personaFile(value: string | null | undefined): string {
  const file = value?.trim() || "persona.md";
  if (path.basename(file) !== file || /[\\/]/.test(file) || !/\.(md|markdown)$/i.test(file)) {
    throw new RemotePersonaError("角色正文必须是角色目录内的 Markdown 文件。", 400, "INVALID_PERSONA_FILE");
  }
  return file;
}
function validRole(value: string): string {
  const roleId = sanitizeRoleId(value);
  if (!roleId || roleId !== value) throw new RemotePersonaError("角色标识无效。", 400, "INVALID_PERSONA_ID");
  return roleId;
}
function checkPersonaQuota(name: string, maximum: number, actual: number): void {
  if (maximum && actual > maximum) throw new RemotePersonaError(`${name}=${maximum} exceeded (actual ${actual} bytes). Adjust this Manager environment setting or set 0 to remove the application quota.`, 413, "PERSONA_FILE_TOO_LARGE");
}
function decodePersonaBytes(chunks: Uint8Array[]): string {
  try { return Buffer.concat(chunks).toString("utf8"); }
  catch (error) { if (error instanceof RangeError || (error as NodeJS.ErrnoException)?.code === "ERR_STRING_TOO_LONG") throw new RemotePersonaError("Persona data exceeds the current runtime buffer or string capacity.", 503, "PERSONA_RUNTIME_CAPACITY_EXCEEDED"); throw error; }
}
async function boundedRoleFile(roleDir: string, file: string, maxBytes: number, setting: string, optional = false): Promise<string> {
  const directory = await fs.realpath(roleDir).catch(() => { throw new RemotePersonaError("角色目录不存在。", 404, "PERSONA_NOT_FOUND"); });
  const target = await fs.realpath(path.join(directory, file)).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === "ENOENT") return "";
    throw new RemotePersonaError("角色文件不存在。", 404, "PERSONA_FILE_NOT_FOUND");
  });
  if (!target) return "{}";
  if (path.dirname(target) !== directory) throw new RemotePersonaError("角色文件离开所属目录。", 400, "INVALID_PERSONA_FILE");
  const handle = await fs.open(target, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new RemotePersonaError("角色正文必须是普通文件。", 400, "INVALID_PERSONA_FILE");
    checkPersonaQuota(setting, maxBytes, stat.size);
    const buffer = Buffer.alloc(64 * 1024);
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead; checkPersonaQuota(setting, maxBytes, size);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return decodePersonaBytes(chunks);
  } finally { await handle.close(); }
}

export async function readPersonaReferenceSnapshot(roleDir: string, roleId: string, file: string, identity: Identity): Promise<PersonaReferenceSnapshot> {
  validRole(roleId); personaFile(file);
  await assertRoleAcceptsWork(roleDir);
  const documentBytes = personaReadSettings.documentBytes, configBytes = personaReadSettings.configBytes;
  const [document, configText] = await Promise.all([
    boundedRoleFile(roleDir, file, documentBytes, "RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES"),
    boundedRoleFile(roleDir, "personaConfig.json", configBytes, "RABIROUTE_PERSONA_CONFIG_MAX_BYTES", true)
  ]);
  let raw: unknown;
  try { raw = JSON.parse(configText); } catch { throw new RemotePersonaError("角色配置不是有效 JSON。", 409, "INVALID_PERSONA_CONFIG"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RemotePersonaError("角色配置必须是 JSON 对象。", 409, "INVALID_PERSONA_CONFIG");
  return { ...identity, schemaVersion: 1, roleId, file, document, personaConfig: personaConfigFragmentFromValue(raw),
    revision: createHash("sha256").update(document).update("\0").update(configText).digest("hex") };
}

type JsonReply = (response: http.ServerResponse, status: number, data: unknown) => void;
function personaFailure(error: unknown): ApiOperationResult {
  if (error instanceof TunnelDenied) error = new RemotePersonaError("RabiLink 角色访问鉴权失败，请核对应用连接及设备身份。", 403, "REMOTE_PERSONA_ACCESS_DENIED");
  const known = error instanceof RemotePersonaError || error instanceof ReadSettingsError ? error : undefined;
  return { status: known?.statusCode ?? 503, body: { code: -1, error: known?.code ?? "REMOTE_PERSONA_UNAVAILABLE",
    message: known?.message ?? "角色读取失败，请检查远端设备、版本及 RabiLink 连接。" }, headers: { "cache-control": "no-store" } };
}
function failure(response: http.ServerResponse, json: JsonReply, error: unknown): void {
  const result = personaFailure(error);
  json(response, result.status, result.body);
}
export function createPersonaBootstrapOperation(context: {
  allowed(request: http.IncomingMessage, url: URL): boolean;
  identity(): Identity;
  ensure(deviceId: string): Promise<void>;
}): ApiOperationDefinition {
  const rejected = (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    if (message === "peer_persona_upgrade_required" || message === "peer_upgrade_required") {
      error = new RemotePersonaError("来源 PC 需要更新以提供远端角色服务。", 426, "REMOTE_PERSONA_UPGRADE_REQUIRED");
    } else if (!(error instanceof RemotePersonaError) && /(?:denied|not_trusted|identity_changed|signature|auth)/.test(message)) {
      error = new TunnelDenied(message);
    }
    return personaFailure(error);
  };
  const prepare: NonNullable<ApiOperationDefinition["prepare"]> = ({ request, url, signal }) => {
    try {
      const before = { ...context.identity() };
      const authenticated = () => {
        try { return hasAuthenticatedConnectionRequest(request); }
        catch { throw new TunnelDenied("peer_control_denied"); }
      };
      const originallyAuthenticated = authenticated();
      const assertCurrent = () => {
        signal?.throwIfAborted();
        if (!sameIdentity(before, context.identity())) throw new RemotePersonaError("Manager 身份已变化，请重新读取。", 409, "MANAGER_IDENTITY_MISMATCH");
        if ((originallyAuthenticated && !authenticated()) || !context.allowed(request, url)) throw new TunnelDenied("peer_control_denied");
      };
      assertCurrent();
      return async input => {
        try {
          assertCurrent();
          const { deviceId } = input.body as { deviceId: string };
          await context.ensure(deviceId);
          assertCurrent();
          return { status: 200, body: { code: 0, data: { deviceId } }, headers: { "cache-control": "no-store" } };
        } catch (error) { signal?.throwIfAborted(); return rejected(error); }
      };
    } catch (error) { signal?.throwIfAborted(); return rejected(error); }
  };
  return { contract: {
    operationId: "manager.rabilink.peer.persona.bootstrap", contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/rabilink/peer/persona/bootstrap",
    description: "Ensure the selected device's original application connection before remote persona access; retain the original caller and Manager identity.", exposure: "public", transport: "http",
    request: { path: { type: "object", additionalProperties: false }, query: { type: "object" }, headers: { type: "object" }, body: {
      kind: "json", maxBytes: 8192, allowAnyContentType: true, schema: { type: "object", required: ["deviceId"], additionalProperties: false,
        properties: { deviceId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } } }
    } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], additionalProperties: false, properties: {
      code: { const: 0 }, data: { type: "object", required: ["deviceId"], additionalProperties: false, properties: { deviceId: { type: "string" } } }
    } } }, ...Object.fromEntries([400, 403, 409, 426, 503].map(status => [status, { mediaType: "application/json", schema: { type: "object", required: ["code", "error", "message"], additionalProperties: false,
      properties: { code: { const: -1 }, error: { type: "string" }, message: { type: "string" } } } }])) },
    effects: { mode: "connection-control", description: "Uses the existing application bootstrap and shared connection owner; may establish trust and connectivity, without changing the selected device or persona." },
    recovery: { strategy: "original-device", description: "Keep the requested device ID. Resolve connection and version errors before repeating; never select a replacement device implicitly." },
    validators: [{ id: "original-persona-bootstrap-caller", description: "Check original control admission before body reading and after body/connection awaits, and retain the original Manager generation and instance." }]
  }, prepare, handler: async input => { const prepared = await prepare(input); return typeof prepared === "function" ? prepared(input) : prepared; } };
}
export function createPersonaReferenceOwner(context: {
  roleDirectory(roleId:string):string; identity():Identity;
  validate(input:{text:string;styleSkillUrl:string;scope:"outbound_message"}):Promise<LanguageStyleValidationResult>;
}) {
  return {
    prepare(request:http.IncomingMessage,rawRoleId:string,signal?:AbortSignal) {
      const admission=preparePersonaResourceAdmission(request,signal,context.identity);
      const roleId=validRole(rawRoleId),roleDir=context.roleDirectory(roleId),before=Object.freeze({...context.identity()});
      const assertCurrent=()=>{admission();if(path.resolve(context.roleDirectory(roleId))!==path.resolve(roleDir))throw new RemotePersonaError("Persona directory changed while reading the original reference.",409,"PERSONA_DIRECTORY_CHANGED");if(!sameIdentity(before,context.identity()))throw new RemotePersonaError("Manager 身份已变化，请重新读取。",409,"MANAGER_IDENTITY_MISMATCH");};
      return {
        async read(rawFile:string|null) {
          assertCurrent();const file=personaFile(rawFile);
          const snapshot=await readPersonaReferenceSnapshot(roleDir,roleId,file,before);assertCurrent();return snapshot;
        },
        async validateStyle(raw:unknown) {
          assertCurrent();
          if(!raw || typeof raw!=="object" || Array.isArray(raw))throw new RemotePersonaError("角色风格检查请求无效。",400,"INVALID_PERSONA_STYLE_REQUEST");
          const body=raw as Record<string,unknown>;
          if(Object.keys(body).some(key=>!["text","file","revision"].includes(key)) || typeof body.text!=="string" || !body.text.trim() || body.text.length>200_000
            || typeof body.revision!=="string" || !/^[a-f0-9]{64}$/.test(body.revision) || (body.file!==undefined && typeof body.file!=="string")) {
            throw new RemotePersonaError("只接受正文、角色文件名及当前 revision；风格由来源角色决定。",400,"INVALID_PERSONA_STYLE_REQUEST");
          }
          const file=personaFile(body.file as string|undefined),snapshot=await readPersonaReferenceSnapshot(roleDir,roleId,file,before);assertCurrent();
          if(snapshot.revision!==body.revision)throw new RemotePersonaError("角色配置已变化，请重新读取后检查。",409,"PERSONA_REVISION_MISMATCH");
          const binding=snapshot.personaConfig.languageStyle;
          if(!binding)throw new RemotePersonaError("来源角色未配置语言风格。",400,"REMOTE_LANGUAGE_STYLE_NOT_CONFIGURED");
          const result=await context.validate({text:body.text,styleSkillUrl:binding.styleSkillUrl,scope:"outbound_message"});assertCurrent();
          const after=await readPersonaReferenceSnapshot(roleDir,roleId,file,context.identity());assertCurrent();
          if(!sameIdentity(before,after) || after.revision!==snapshot.revision)throw new RemotePersonaError("检查期间角色配置或 Manager 身份已变化。",409,"PERSONA_REVISION_MISMATCH");
          return {...result,styleSkillUrl:binding.styleSkillUrl};
        }
      };
    }
  };
}
function sameIdentity(left: Identity, right: Identity): boolean {
  return Boolean(left.applicationGenerationId && left.managerInstanceId && left.applicationGenerationId === right.applicationGenerationId && left.managerInstanceId === right.managerInstanceId);
}
async function boundedJson(response: Response): Promise<any> {
  let maximum: number;
  try { maximum = personaReadSettings.responseBytes; }
  catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  if (reader) try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
      checkPersonaQuota("RABIROUTE_PERSONA_RESPONSE_MAX_BYTES", maximum, bytes); chunks.push(chunk.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const text = decodePersonaBytes(chunks);
  let payload: any;
  try { payload = JSON.parse(text); } catch { /* HTTP status still determines permission failures. */ }
  if (!response.ok) {
    if (response.status === 404 && ["PERSONA_NOT_FOUND", "PERSONA_FILE_NOT_FOUND"].includes(payload?.error)) {
      throw new RemotePersonaError("远端角色或正文文件不存在，请检查来源 PC。", 404, "REMOTE_PERSONA_NOT_FOUND");
    }
    const code = response.status === 404 ? "REMOTE_PERSONA_UPGRADE_REQUIRED" : response.status === 403 || response.status === 401 ? "REMOTE_PERSONA_ACCESS_DENIED" : "REMOTE_PERSONA_UNAVAILABLE";
    throw new RemotePersonaError(response.status === 404 ? "远端 PC 需要升级以提供角色配置引用。" : "远端角色不可用，请检查 RabiLink 连接、设备身份及来源运行状态。", response.status === 404 ? 426 : response.status, code);
  }
  if (payload === undefined) throw new RemotePersonaError("远端响应不支持角色配置引用，请更新远端 PC。", 426, "REMOTE_PERSONA_UPGRADE_REQUIRED");
  return payload;
}
export async function resolveRemotePersonaSnapshot(definition: Pick<GatewayDefinition, "agentRoleDeviceId" | "agentRoleId" | "agentRoleFile">, context: RemotePersonaReadContext): Promise<RemotePersonaSnapshot> {
  const reference = normalizeRemotePersonaReference(definition);
  if (!reference.agentRoleDeviceId) throw new RemotePersonaError("此路由未引用远端角色。", 400, "REMOTE_PERSONA_NOT_CONFIGURED");
  const deviceId = reference.agentRoleDeviceId;
  const roleId = validRole(reference.agentRoleId);
  const file = personaFile(definition.agentRoleFile);
  const beforeLocal = context.identity();
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(getTimeoutMs("backend.manager.remotePersonaRoutes.resolveRemotePersonaSnapshot.AbortSignal.timeout.request", 20_000))]) : AbortSignal.timeout(getTimeoutMs("backend.manager.remotePersonaRoutes.resolveRemotePersonaSnapshot.AbortSignal.timeout.request", 20_000));
  const read = async (pathname: string) => boundedJson(await context.fetchRemote(deviceId, pathname, { method: "GET", signal }));
  const remoteGeneration = await context.remoteGeneration(deviceId);
  const before = await read("/meta");
  if (!before.applicationGenerationId || !before.managerInstanceId || before.applicationGenerationId !== remoteGeneration
    || !before.health?.live || !before.health?.requiredReady || !["healthy", "degraded"].includes(before.health?.state)) {
    throw new RemotePersonaError("远端 Manager 身份或就绪状态不匹配。", 409, "REMOTE_MANAGER_IDENTITY_MISMATCH");
  }
  const payload = await read(`/api/roles/${encodeURIComponent(roleId)}/persona-reference?file=${encodeURIComponent(file)}`);
  const snapshot = payload?.data;
  if (payload.code !== 0 || snapshot?.schemaVersion !== 1 || snapshot.roleId !== roleId || snapshot.file !== file
    || typeof snapshot.document !== "string" || !snapshot.personaConfig || typeof snapshot.personaConfig !== "object"
    || Array.isArray(snapshot.personaConfig) || typeof snapshot.revision !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.revision)) {
    throw new RemotePersonaError("远端角色响应与所选角色不匹配。", 502, "INVALID_REMOTE_PERSONA");
  }
  checkPersonaQuota("RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES", personaReadSettings.documentBytes, Buffer.byteLength(snapshot.document, "utf8"));
  const after = await read("/meta");
  if (!sameIdentity(before, snapshot) || !sameIdentity(before, after) || await context.remoteGeneration(deviceId) !== remoteGeneration || !sameIdentity(beforeLocal, context.identity())) {
    throw new RemotePersonaError("读取期间 Manager 身份已变化，请重新读取。", 409, "REMOTE_MANAGER_IDENTITY_MISMATCH");
  }
  return { ...snapshot, ...beforeLocal, personaConfig: personaConfigFragmentFromValue(snapshot.personaConfig), deviceId,
    remoteApplicationGenerationId: before.applicationGenerationId, remoteManagerInstanceId: before.managerInstanceId,
    knowledgeApiBaseUrl: `${context.managerBaseUrl.replace(/\/$/, "")}/api/rabilink/peer/http/${encodeURIComponent(deviceId)}/persona` };
}

/** Style files are resolved by the persona owner, including owner-local file URLs. */
export async function validateRemotePersonaLanguageStyle(snapshot: RemotePersonaSnapshot, text: string, context: RemotePersonaReadContext): Promise<LanguageStyleValidationResult> {
  const binding = snapshot.personaConfig.languageStyle;
  if (!binding) throw new RemotePersonaError("远端角色未绑定语言风格。", 400, "REMOTE_LANGUAGE_STYLE_NOT_CONFIGURED");
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(getTimeoutMs("backend.manager.remotePersonaRoutes.validateRemotePersonaLanguageStyle.AbortSignal.timeout.request", 20_000))]) : AbortSignal.timeout(getTimeoutMs("backend.manager.remotePersonaRoutes.validateRemotePersonaLanguageStyle.AbortSignal.timeout.request", 20_000));
  const remoteIdentity = { applicationGenerationId: snapshot.remoteApplicationGenerationId, managerInstanceId: snapshot.remoteManagerInstanceId };
  const assertOwner = async () => {
    const meta = await boundedJson(await context.fetchRemote(snapshot.deviceId, "/meta", { method: "GET", signal }));
    if (!sameIdentity(snapshot, context.identity()) || !sameIdentity(remoteIdentity, meta)
      || await context.remoteGeneration(snapshot.deviceId) !== remoteIdentity.applicationGenerationId) {
      throw new RemotePersonaError("语言风格检查期间 Manager 身份已变化，请重新检查。", 409, "REMOTE_MANAGER_IDENTITY_MISMATCH");
    }
    return meta;
  };
  const before = await assertOwner();
  if (!before.health?.live || !before.health?.requiredReady || !["healthy", "degraded"].includes(before.health?.state)) {
    throw new RemotePersonaError("远端语言风格检查尚未就绪。");
  }
  const payload = await boundedJson(await context.fetchRemote(snapshot.deviceId, `/api/roles/${encodeURIComponent(snapshot.roleId)}/persona-reference/language-style`, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ text, file: snapshot.file, revision: snapshot.revision })
  }));
  const result = payload?.data;
  if (payload.code !== 0 || typeof result?.passed !== "boolean" || !["passed", "failed", "unavailable"].includes(result.status)
    || result.passed !== (result.status === "passed") || result.styleSkillUrl !== binding.styleSkillUrl || result.scope !== "outbound_message"
    || !Array.isArray(result.violations) || !Array.isArray(result.checkedRuleIds) || !Array.isArray(result.skippedRuleIds)) {
    throw new RemotePersonaError("远端语言风格检查返回无效结果。", 502, "INVALID_REMOTE_LANGUAGE_STYLE");
  }
  await assertOwner();
  return result as LanguageStyleValidationResult;
}

export function handleRemotePersonaResolutionApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, context: {
  identity(): Identity;
  isLoopback(address?: string): boolean;
  definition(routeId: string): GatewayDefinition | undefined;
  verifyCapability(routeId: string, roleId: string, capability: string): boolean;
  resolve(definition: GatewayDefinition): Promise<RemotePersonaSnapshot>;
  json: JsonReply;
  reportFailure?(routeId: string, error: unknown): void;
}): boolean {
  if (url.pathname !== "/api/internal/remote-persona/resolve") return false;
  response.setHeader("cache-control", "no-store");
  if (request.method !== "GET") { context.json(response, 405, { code: -1, error: "METHOD_NOT_ALLOWED", message: "GET is required." }); return true; }
  const identity = context.identity();
  const routeId = String(request.headers[ROLE_CONTEXT_ROUTE_HEADER] || "");
  const capability = String(request.headers[ROLE_CONTEXT_CAPABILITY_HEADER] || "");
  const definition = context.definition(routeId);
  const suppliedIdentity = { applicationGenerationId: String(request.headers[ROLE_CONTEXT_GENERATION_HEADER] || ""), managerInstanceId: String(request.headers[ROLE_CONTEXT_MANAGER_HEADER] || "") };
  if (!context.isLoopback(request.socket.remoteAddress) || !definition?.agentRoleDeviceId || url.searchParams.get("routeId") !== routeId
    || !context.verifyCapability(routeId, String(definition.agentRoleId || ""), capability)) {
    context.json(response, 403, { code: -1, error: "PERSONA_CAPABILITY_REQUIRED", message: "此请求不能读取该路由的远端角色。" }); return true;
  }
  if (!sameIdentity(identity, suppliedIdentity)) { context.json(response, 409, { code: -1, error: "MANAGER_IDENTITY_MISMATCH", message: "Manager generation changed." }); return true; }
  try {
    if (personaFile(url.searchParams.get("file")) !== personaFile(definition.agentRoleFile)) { context.json(response, 403, { code: -1, error: "PERSONA_CAPABILITY_REQUIRED", message: "角色文件与路由绑定不匹配。" }); return true; }
  } catch (error) { failure(response, context.json, error); return true; }
  void context.resolve(definition).then(snapshot => {
    const current = context.definition(routeId);
    if (!sameIdentity(identity, context.identity()) || current?.agentRoleDeviceId !== definition.agentRoleDeviceId || current?.agentRoleId !== definition.agentRoleId || current?.agentRoleFile !== definition.agentRoleFile
      || !context.verifyCapability(routeId, String(definition.agentRoleId || ""), capability)) {
      throw new RemotePersonaError("路由绑定或 Manager 身份已变化。", 409, "MANAGER_IDENTITY_MISMATCH");
    }
    context.json(response, 200, { code: 0, data: snapshot });
  }).catch(error => { context.reportFailure?.(routeId, error); failure(response, context.json, error); });
  return true;
}
