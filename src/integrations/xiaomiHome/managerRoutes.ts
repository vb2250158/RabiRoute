import { createHash } from "node:crypto";
import { assertTrustedLanAgentPrincipal } from "../../manager/lanAgentRequestAccess.js";
import { createXiaomiHomeRequestAuthority, XiaomiHomeRequestAuthorityError, type XiaomiHomeRequestAuthority } from "./requestAuthority.js";
import type http from "node:http";
import {
  XiaomiHomeManagerApiError
} from "./managerApi.js";
import type { ApiOperationResult } from "../../manager/apiOperationContract.js";
import { hasAuthenticatedConnectionRequest } from "../../manager/connectionRequestAccess.js";
import type { XiaomiHomeEvent, XiaomiHomeEventDeliveryContext } from "../../xiaomiHomeEventDelivery.js";
import type { XiaomiHomeArtifactInput } from "./artifactStore.js";
import type {
  XiaomiHomeAuthorizationMutationRequest,
  XiaomiHomeAuthorizeRequest
} from "../../shared/xiaomiHomeAuthContract.js";
import type { XiaomiHomeRuntimeController } from "./settingsRuntime.js";
import { XiaomiHomeAuthMutationReceipts } from "./authMutationReceipts.js";
import { randomBytes } from "node:crypto";
import { vacuumCloudConnectPage } from "./vacuumCloudPage.js";
import { parseHomeDirectoryQuery } from "./directoryQuery.js";

export type XiaomiHomeManagerRoutesContext = {
  /** Activation readiness, not a feature grant; no native work may precede published handoff. */
  assertRuntimeAvailable?: () => void;
  runtime: XiaomiHomeRuntimeController;
  lifecycleFence: Readonly<{
    applicationGenerationId: string;
    managerInstanceId: string;
  }>;
  authMutationReceipts?: XiaomiHomeAuthMutationReceipts;
  controlPlaneAccessAllowed?: (request: http.IncomingMessage, requestUrl: URL) => boolean;
  deliverEvent: (event: XiaomiHomeEvent, context: XiaomiHomeEventDeliveryContext, authority?: XiaomiHomeRequestAuthority) => Promise<unknown>;
};

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  return normalized === "::1" || normalized === "localhost" || normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

export function presentedXiaomiHomeError(error: unknown): { status: number; code: string; message: string; outcome?: string } {
  if (error instanceof XiaomiHomeRequestAuthorityError) return { status: error.status, code: error.code, message: error.message, outcome: error.outcome };
  if (error instanceof XiaomiHomeManagerApiError) return { status: error.status, code: error.code, message: error.message };
  return { status: 500, code: "xiaomi_home_integration_error", message: "Xiaomi Home integration failed." };
}

const receiptStores = new WeakMap<XiaomiHomeRuntimeController, XiaomiHomeAuthMutationReceipts>();

function authReceipts(context: XiaomiHomeManagerRoutesContext): XiaomiHomeAuthMutationReceipts {
  if (context.authMutationReceipts) return context.authMutationReceipts;
  const existing = receiptStores.get(context.runtime);
  if (existing) return existing;
  const created = new XiaomiHomeAuthMutationReceipts(context.runtime.artifacts.runtimeDir);
  receiptStores.set(context.runtime, created);
  return created;
}

export function createXiaomiHomeOperationsOwner(context: XiaomiHomeManagerRoutesContext) {
  const invalid = (code: string, message: string, status = 400): never => { throw new XiaomiHomeManagerApiError(status, code, message); };
  return Object.freeze({
    runtime: context.runtime,
    prepare(request: http.IncomingMessage, url: URL, configuration = false): XiaomiHomeRequestAuthority {
      context.assertRuntimeAvailable?.();
      let principal, authenticated;
      try { principal = assertTrustedLanAgentPrincipal(request); authenticated = hasAuthenticatedConnectionRequest(request); }
      catch { throw new XiaomiHomeRequestAuthorityError("not_started"); }
      if (!principal && !authenticated && !isLoopbackAddress(request.socket.remoteAddress) && !(configuration && context.controlPlaneAccessAllowed?.(request, url))) invalid("xiaomi_home_loopback_required", "Xiaomi Home public APIs require an authenticated admitted connection or loopback access; authorized WebGUI access covers configuration only.", 403);
      const original = createXiaomiHomeRequestAuthority(request); let dispatched = false;
      const assert = () => { context.assertRuntimeAvailable?.(); try { hasAuthenticatedConnectionRequest(request); original.assert(); } catch { throw new XiaomiHomeRequestAuthorityError(dispatched ? "unknown" : "not_started"); } };
      return Object.freeze({ assert, dispatch: () => { assert(); original.dispatch(); dispatched = true; } });
    },
    lifecycle(request: http.IncomingMessage) {
      const generation = String(request.headers["x-rabiroute-expected-application-generation-id"] || "").trim(), instance = String(request.headers["x-rabiroute-expected-manager-instance-id"] || "").trim();
      if (!generation || !instance) invalid("xiaomi_home_lifecycle_fence_required", "Current application generation and Manager instance headers are required.");
      if (generation !== context.lifecycleFence.applicationGenerationId || instance !== context.lifecycleFence.managerInstanceId) invalid("xiaomi_home_lifecycle_fence_stale", "Manager lifecycle changed; reload /meta before retrying.", 409);
    },
    key(request: http.IncomingMessage): string { const key = String(request.headers["idempotency-key"] || "").trim(); if (!/^[A-Za-z0-9._:-]{16,200}$/.test(key)) invalid("xiaomi_home_idempotency_key_required", "A stable Idempotency-Key is required."); return key; },
    query(url: URL, fields: readonly string[], code: string) { if ([...url.searchParams.keys()].some(key => !fields.includes(key) || url.searchParams.getAll(key).length !== 1)) invalid(code, "Unexpected or repeated query parameter."); },
    async result(authority: XiaomiHomeRequestAuthority, operation: () => unknown | Promise<unknown>, status = 200): Promise<ApiOperationResult> {
      try { authority.assert(); const data = await operation(); authority.assert(); return { status, body: { code: 0, data } }; }
      catch (cause) { try { authority.assert(); } catch (revoked) { cause = revoked; } const { status, ...error } = presentedXiaomiHomeError(cause); return { status, ...(error.outcome === "not_started" || error.outcome === "unknown" ? { mutationOutcome: error.outcome } : {}), body: { code: -1, error } }; }
    },
    authorize(body: XiaomiHomeAuthorizeRequest, key: string, authority: XiaomiHomeRequestAuthority) { return authReceipts(context).execute(key, { operation: "connect", baseUrl: body.baseUrl, settingsRevision: body.settingsRevision, authorizationRevision: body.authorizationRevision, tokenHash: createHash("sha256").update(String(body.accessToken || "")).digest("hex") }, () => context.runtime.authorize(body.accessToken, body.baseUrl, body.settingsRevision, body.authorizationRevision, authority)); },
    refresh(body: XiaomiHomeAuthorizationMutationRequest, key: string, authority: XiaomiHomeRequestAuthority) { return authReceipts(context).execute(key, { operation: "refresh", authorizationRevision: body.authorizationRevision }, () => context.runtime.refreshAuthorization(body.authorizationRevision, authority)); },
    disconnect(body: XiaomiHomeAuthorizationMutationRequest, key: string, authority: XiaomiHomeRequestAuthority) { return authReceipts(context).execute(key, { operation: "disconnect", authorizationRevision: body.authorizationRevision }, () => context.runtime.disconnect(body.authorizationRevision, authority)); },
    video(action: "start" | "stop" | "forget", body: Record<string, unknown>, key: string) {
      const allowed = action === "start" ? ["deviceId", "region", "password", "rememberPassword"] : action === "forget" ? ["deviceId", "region"] : ["sessionId"];
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) invalid("xiaomi_vacuum_video_body_invalid", "Unexpected video parameter.");
      if (action === "stop") { if (typeof body.sessionId !== "string") invalid("xiaomi_vacuum_video_body_invalid", "Supply a video session ID."); return context.runtime.vacuumCloud.video.stop(body.sessionId as string); }
      if (typeof body.deviceId !== "string" || body.region !== undefined && typeof body.region !== "string") invalid("xiaomi_vacuum_video_body_invalid", "Supply a numeric device ID and optional region.");
      if (action === "forget") return context.runtime.vacuumCloud.forgetVideoPassword(body.deviceId as string, String(body.region || "cn"), key);
      if (body.rememberPassword !== undefined && typeof body.rememberPassword !== "boolean") invalid("xiaomi_vacuum_video_body_invalid", "rememberPassword must be boolean.");
      if (body.password !== undefined && typeof body.password !== "string") invalid("xiaomi_vacuum_video_body_invalid", "视频密码必须是四位数字字符串。");
      const password = body.password as string | undefined; delete body.password;
      return context.runtime.vacuumCloud.video.start(body.deviceId as string, String(body.region || "cn"), key, password, body.rememberPassword === true);
    },
    cloudLogin(body: Record<string, unknown>, key: string) { if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) invalid("xiaomi_vacuum_cloud_body_invalid", "QR login accepts an empty JSON object."); return context.runtime.vacuumCloud.begin(key); },
    cloudPoll(body: Record<string, unknown>) { if (!body || typeof body !== "object" || Object.keys(body).some(key => key !== "sessionId") || typeof body.sessionId !== "string") invalid("xiaomi_vacuum_cloud_body_invalid", "Supply only the current sessionId."); return context.runtime.vacuumCloud.poll(body.sessionId as string); },
    event(body: { event: XiaomiHomeEvent; agentRoleId: string }, authority: XiaomiHomeRequestAuthority) { authority.dispatch(); return context.deliverEvent(body.event, { agentRoleId: body.agentRoleId }, authority); },
    artifact(body: XiaomiHomeArtifactInput, authority: XiaomiHomeRequestAuthority) { authority.dispatch(); return context.runtime.artifacts.register(body); },
    connect(url: URL) { if (url.searchParams.has("view") && url.searchParams.get("view") !== "embedded" || url.searchParams.has("deviceId") && !/^\d{1,32}$/.test(url.searchParams.get("deviceId")!)) invalid("xiaomi_vacuum_cloud_query_invalid", "Invalid map view or device ID."); const nonce = randomBytes(16).toString("base64"); return { status: 200, headers: { "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`, "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cache-control": "no-store" }, body: vacuumCloudConnectPage(nonce) }; },
    parseDirectory: parseHomeDirectoryQuery,
    invalid
  });
}
