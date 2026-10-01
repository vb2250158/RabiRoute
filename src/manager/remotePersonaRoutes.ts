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
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function personaFile(value: string | null | undefined): string {
  const file = value?.trim() || "persona.md";
  if (path.basename(file) !== file || /[\\/]/.test(file) || !/\.(md|markdown)$/i.test(file)) {
    throw new RemotePersonaError("人格正文必须是人格目录内的 Markdown 文件。", 400, "INVALID_PERSONA_FILE");
  }
  return file;
}
function validRole(value: string): string {
  const roleId = sanitizeRoleId(value);
  if (!roleId || roleId !== value) throw new RemotePersonaError("人格标识无效。", 400, "INVALID_PERSONA_ID");
  return roleId;
}
async function boundedRoleFile(roleDir: string, file: string, maxBytes: number, optional = false): Promise<string> {
  const directory = await fs.realpath(roleDir).catch(() => { throw new RemotePersonaError("人格目录不存在。", 404, "PERSONA_NOT_FOUND"); });
  const target = await fs.realpath(path.join(directory, file)).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === "ENOENT") return "";
    throw new RemotePersonaError("人格文件不存在。", 404, "PERSONA_FILE_NOT_FOUND");
  });
  if (!target) return "{}";
  if (path.dirname(target) !== directory) throw new RemotePersonaError("人格文件离开所属目录。", 400, "INVALID_PERSONA_FILE");
  const handle = await fs.open(target, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new RemotePersonaError("人格文件超过大小限制。", 413, "PERSONA_FILE_TOO_LARGE");
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new RemotePersonaError("人格文件超过大小限制。", 413, "PERSONA_FILE_TOO_LARGE");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

export async function readPersonaReferenceSnapshot(roleDir: string, roleId: string, file: string, identity: Identity): Promise<PersonaReferenceSnapshot> {
  validRole(roleId); personaFile(file);
  const [document, configText] = await Promise.all([
    boundedRoleFile(roleDir, file, MAX_DOCUMENT_BYTES),
    boundedRoleFile(roleDir, "personaConfig.json", MAX_CONFIG_BYTES, true)
  ]);
  let raw: unknown;
  try { raw = JSON.parse(configText); } catch { throw new RemotePersonaError("人格配置不是有效 JSON。", 409, "INVALID_PERSONA_CONFIG"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RemotePersonaError("人格配置必须是 JSON 对象。", 409, "INVALID_PERSONA_CONFIG");
  return { ...identity, schemaVersion: 1, roleId, file, document, personaConfig: personaConfigFragmentFromValue(raw),
    revision: createHash("sha256").update(document).update("\0").update(configText).digest("hex") };
}

type JsonReply = (response: http.ServerResponse, status: number, data: unknown) => void;
function failure(response: http.ServerResponse, json: JsonReply, error: unknown): void {
  if (error instanceof TunnelDenied) error = new RemotePersonaError("RabiLink 人格访问鉴权失败，请核对应用连接及设备身份。", 403, "REMOTE_PERSONA_ACCESS_DENIED");
  const known = error instanceof RemotePersonaError ? error : undefined;
  json(response, known?.statusCode ?? 503, { code: -1, error: known?.code ?? "REMOTE_PERSONA_UNAVAILABLE",
    message: known?.message ?? "人格读取失败，请检查远端设备、版本及 RabiLink 连接。" });
}
export function handlePersonaBootstrapApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, context: {
  allowed(request: http.IncomingMessage, url: URL): boolean;
  identity(): Identity;
  readJson(request: http.IncomingMessage, maxBytes: number): Promise<unknown>;
  ensure(deviceId: string): Promise<void>;
  json: JsonReply;
}): boolean {
  if (url.pathname !== "/api/rabilink/peer/persona/bootstrap") return false;
  response.setHeader("cache-control", "no-store");
  if (request.method !== "POST") { context.json(response, 405, { code: -1, error: "METHOD_NOT_ALLOWED" }); return true; }
  if (!context.allowed(request, url)) { failure(response, context.json, new TunnelDenied("peer_control_denied")); return true; }
  const before = context.identity();
  void (async () => {
    const raw = await context.readJson(request, 8192);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RemotePersonaError("设备请求无效。", 400, "INVALID_DEVICE_ID");
    const body = raw as Record<string, unknown>;
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId) || Object.keys(body).some(key => key !== "deviceId")) {
      throw new RemotePersonaError("设备 ID 无效。", 400, "INVALID_DEVICE_ID");
    }
    await context.ensure(deviceId);
    if (!sameIdentity(before, context.identity())) throw new RemotePersonaError("Manager 身份已变化，请重新读取。", 409, "MANAGER_IDENTITY_MISMATCH");
    context.json(response, 200, { code: 0, data: { deviceId } });
  })().catch(error => {
    const message = error instanceof Error ? error.message : "";
    if (message === "peer_persona_upgrade_required" || message === "peer_upgrade_required") {
      error = new RemotePersonaError("来源 PC 需要更新以提供远端人格服务。", 426, "REMOTE_PERSONA_UPGRADE_REQUIRED");
    } else if (!(error instanceof RemotePersonaError) && /(?:denied|not_trusted|identity_changed|signature|auth)/.test(message)) {
      error = new TunnelDenied(message);
    }
    failure(response, context.json, error);
  });
  return true;
}
export function handlePersonaReferenceApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, context: {
  roleDirectory(roleId: string): string;
  identity(): Identity;
  json: JsonReply;
}): boolean {
  const match = url.pathname.match(/^\/api\/roles\/([^/]+)\/persona-reference$/);
  if (!match) return false;
  response.setHeader("cache-control", "no-store");
  if (request.method !== "GET") { context.json(response, 405, { code: -1, error: "METHOD_NOT_ALLOWED", message: "GET is required." }); return true; }
  void (async () => {
    const roleId = validRole(decodeURIComponent(match[1]!));
    const file = personaFile(url.searchParams.get("file"));
    const before = context.identity();
    const snapshot = await readPersonaReferenceSnapshot(context.roleDirectory(roleId), roleId, file, before);
    if (!sameIdentity(before, context.identity())) throw new RemotePersonaError("Manager 身份已变化，请重新读取。", 409, "MANAGER_IDENTITY_MISMATCH");
    context.json(response, 200, { code: 0, data: snapshot });
  })().catch(error => failure(response, context.json, error));
  return true;
}

export function handlePersonaReferenceLanguageStyleApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, context: {
  roleDirectory(roleId: string): string;
  identity(): Identity;
  readJson(request: http.IncomingMessage, maxBytes: number): Promise<unknown>;
  validate(input: { text: string; styleSkillUrl: string; scope: "outbound_message" }): Promise<LanguageStyleValidationResult>;
  json: JsonReply;
}): boolean {
  const match = url.pathname.match(/^\/api\/roles\/([^/]+)\/persona-reference\/language-style$/);
  if (!match) return false;
  response.setHeader("cache-control", "no-store");
  if (request.method !== "POST") { context.json(response, 405, { code: -1, error: "METHOD_NOT_ALLOWED", message: "POST is required." }); return true; }
  void (async () => {
    const roleId = validRole(decodeURIComponent(match[1]!));
    const raw = await context.readJson(request, MAX_CONFIG_BYTES);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RemotePersonaError("人格风格检查请求无效。", 400, "INVALID_PERSONA_STYLE_REQUEST");
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some(key => !["text", "file", "revision"].includes(key))
      || typeof body.text !== "string" || !body.text.trim() || body.text.length > 200_000
      || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)
      || (body.file !== undefined && typeof body.file !== "string")) {
      throw new RemotePersonaError("只接受正文、人格文件名及当前 revision；风格由来源人格决定。", 400, "INVALID_PERSONA_STYLE_REQUEST");
    }
    const file = personaFile(body.file as string | undefined);
    const before = context.identity();
    const roleDir = context.roleDirectory(roleId);
    const snapshot = await readPersonaReferenceSnapshot(roleDir, roleId, file, before);
    if (snapshot.revision !== body.revision) throw new RemotePersonaError("人格配置已变化，请重新读取后检查。", 409, "PERSONA_REVISION_MISMATCH");
    const binding = snapshot.personaConfig.languageStyle;
    if (!binding) throw new RemotePersonaError("来源人格未配置语言风格。", 400, "REMOTE_LANGUAGE_STYLE_NOT_CONFIGURED");
    const result = await context.validate({ text: body.text, styleSkillUrl: binding.styleSkillUrl, scope: "outbound_message" });
    const after = await readPersonaReferenceSnapshot(roleDir, roleId, file, context.identity());
    if (!sameIdentity(before, context.identity()) || !sameIdentity(before, after) || after.revision !== snapshot.revision) {
      throw new RemotePersonaError("检查期间人格配置或 Manager 身份已变化。", 409, "PERSONA_REVISION_MISMATCH");
    }
    // Preserve the owner's configured reference; canonical file URLs belong to the owner PC.
    context.json(response, 200, { code: 0, data: { ...result, styleSkillUrl: binding.styleSkillUrl } });
  })().catch(error => failure(response, context.json, error));
  return true;
}
function sameIdentity(left: Identity, right: Identity): boolean {
  return Boolean(left.applicationGenerationId && left.managerInstanceId && left.applicationGenerationId === right.applicationGenerationId && left.managerInstanceId === right.managerInstanceId);
}
async function boundedJson(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  if (reader) try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new RemotePersonaError("远端人格响应超过大小限制。", 413, "PERSONA_FILE_TOO_LARGE"); chunks.push(chunk.value); }
  } finally { await reader.cancel().catch(() => {}); }
  let payload: any;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* HTTP status still determines permission failures. */ }
  if (!response.ok) {
    if (response.status === 404 && ["PERSONA_NOT_FOUND", "PERSONA_FILE_NOT_FOUND"].includes(payload?.error)) {
      throw new RemotePersonaError("远端人格或正文文件不存在，请检查来源 PC。", 404, "REMOTE_PERSONA_NOT_FOUND");
    }
    const code = response.status === 404 ? "REMOTE_PERSONA_UPGRADE_REQUIRED" : response.status === 403 || response.status === 401 ? "REMOTE_PERSONA_ACCESS_DENIED" : "REMOTE_PERSONA_UNAVAILABLE";
    throw new RemotePersonaError(response.status === 404 ? "远端 PC 需要升级以提供人格配置引用。" : "远端人格不可用，请检查 RabiLink 连接、设备身份及来源运行状态。", response.status === 404 ? 426 : response.status, code);
  }
  if (payload === undefined) throw new RemotePersonaError("远端响应不支持人格配置引用，请更新远端 PC。", 426, "REMOTE_PERSONA_UPGRADE_REQUIRED");
  return payload;
}
export async function resolveRemotePersonaSnapshot(definition: Pick<GatewayDefinition, "agentRoleDeviceId" | "agentRoleId" | "agentRoleFile">, context: RemotePersonaReadContext): Promise<RemotePersonaSnapshot> {
  const reference = normalizeRemotePersonaReference(definition);
  if (!reference.agentRoleDeviceId) throw new RemotePersonaError("此路由未引用远端人格。", 400, "REMOTE_PERSONA_NOT_CONFIGURED");
  const deviceId = reference.agentRoleDeviceId;
  const roleId = validRole(reference.agentRoleId);
  const file = personaFile(definition.agentRoleFile);
  const beforeLocal = context.identity();
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
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
    throw new RemotePersonaError("远端人格响应与所选人格不匹配。", 502, "INVALID_REMOTE_PERSONA");
  }
  if (Buffer.byteLength(snapshot.document, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new RemotePersonaError("远端人格正文超过大小限制。", 413, "PERSONA_FILE_TOO_LARGE");
  }
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
  if (!binding) throw new RemotePersonaError("远端人格未绑定语言风格。", 400, "REMOTE_LANGUAGE_STYLE_NOT_CONFIGURED");
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
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
    context.json(response, 403, { code: -1, error: "PERSONA_CAPABILITY_REQUIRED", message: "此请求不能读取该路由的远端人格。" }); return true;
  }
  if (!sameIdentity(identity, suppliedIdentity)) { context.json(response, 409, { code: -1, error: "MANAGER_IDENTITY_MISMATCH", message: "Manager generation changed." }); return true; }
  try {
    if (personaFile(url.searchParams.get("file")) !== personaFile(definition.agentRoleFile)) { context.json(response, 403, { code: -1, error: "PERSONA_CAPABILITY_REQUIRED", message: "人格文件与路由绑定不匹配。" }); return true; }
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
