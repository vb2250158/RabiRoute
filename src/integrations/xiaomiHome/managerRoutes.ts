import { createHash } from "node:crypto";
import { getTrustedLanAgentSource } from "../../manager/lanAgentBodyAuthority.js";
import type http from "node:http";
import {
  XiaomiHomeManagerApiError,
  type XiaomiHomeActionRequest
} from "./managerApi.js";
import type { ManagerPluginRouteHandler } from "../../manager/managerPluginRouteRegistry.js";
import type { XiaomiHomeEvent, XiaomiHomeEventDeliveryContext } from "../../xiaomiHomeEventDelivery.js";
import type { XiaomiHomeArtifactInput } from "./artifactStore.js";
import type { XiaomiHomeSettingsUpdate } from "../../shared/xiaomiHomeSettingsContract.js";
import type {
  XiaomiHomeAuthorizationMutationRequest,
  XiaomiHomeAuthorizeRequest
} from "../../shared/xiaomiHomeAuthContract.js";
import type { XiaomiHomeRuntimeController } from "./settingsRuntime.js";
import { XiaomiHomeAuthMutationReceipts } from "./authMutationReceipts.js";
import { randomBytes } from "node:crypto";
import { vacuumCloudConnectPage } from "./vacuumCloudPage.js";
import type { HomeAssistantDeploymentConfig } from "../../shared/homeAssistantDeploymentContract.js";

export type XiaomiHomeManagerRoutesContext = {
  runtime: XiaomiHomeRuntimeController;
  lifecycleFence: Readonly<{
    applicationGenerationId: string;
    managerInstanceId: string;
  }>;
  authMutationReceipts?: XiaomiHomeAuthMutationReceipts;
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  trackOperation?: <T>(operation: Promise<T>) => Promise<T>;
  controlPlaneAccessAllowed?: (request: http.IncomingMessage, requestUrl: URL) => boolean;
  deliverEvent: (event: XiaomiHomeEvent, context: XiaomiHomeEventDeliveryContext) => Promise<unknown>;
};

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  return normalized === "::1" || normalized === "localhost" || normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

function presentedError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof XiaomiHomeManagerApiError) return { status: error.status, code: error.code, message: error.message };
  return { status: 500, code: "xiaomi_home_integration_error", message: "Xiaomi Home integration failed." };
}

function respond<T>(response: http.ServerResponse, context: XiaomiHomeManagerRoutesContext, operation: Promise<T>, status = 200): void {
  const tracked = context.trackOperation?.(operation) ?? operation;
  void tracked.then(data => context.jsonResponse(response, status, { code: 0, data })).catch(error => {
    const presented = presentedError(error);
    context.jsonResponse(response, presented.status, { code: -1, error: { code: presented.code, message: presented.message } });
  });
}

function requireIdempotencyKey(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: XiaomiHomeManagerRoutesContext
): string | undefined {
  const key = String(request.headers["idempotency-key"] || "").trim();
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(key)) {
    context.jsonResponse(response, 400, {
      code: -1,
      error: { code: "xiaomi_home_idempotency_key_required", message: "A stable Idempotency-Key is required." }
    });
    return undefined;
  }
  return key;
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

function requireLifecycleFence(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: XiaomiHomeManagerRoutesContext
): boolean {
  const expectedApplicationGenerationId = String(request.headers["x-rabiroute-expected-application-generation-id"] || "").trim();
  const expectedManagerInstanceId = String(request.headers["x-rabiroute-expected-manager-instance-id"] || "").trim();
  if (!expectedApplicationGenerationId || !expectedManagerInstanceId) {
    context.jsonResponse(response, 400, {
      code: -1,
      error: { code: "xiaomi_home_lifecycle_fence_required", message: "Current application generation and Manager instance headers are required." }
    });
    return false;
  }
  if (
    expectedApplicationGenerationId !== context.lifecycleFence.applicationGenerationId
    || expectedManagerInstanceId !== context.lifecycleFence.managerInstanceId
  ) {
    context.jsonResponse(response, 409, {
      code: -1,
      error: { code: "xiaomi_home_lifecycle_fence_stale", message: "Manager lifecycle changed; reload /meta before retrying." }
    });
    return false;
  }
  return true;
}

export function handleXiaomiHomeManagerApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: XiaomiHomeManagerRoutesContext
): boolean {
  const root = "/api/agent/xiaomi-home";
  if (!requestUrl.pathname.startsWith(root)) return false;
  const loopback = isLoopbackAddress(request.socket.remoteAddress);
  const authenticatedAgent = Boolean(getTrustedLanAgentSource(request));
  const controlPlaneConfigurationAccess = context.controlPlaneAccessAllowed?.(request, requestUrl) === true;
  const deploymentRequest = requestUrl.pathname.startsWith(`${root}/deployment`);
  if ((!loopback && deploymentRequest) || (!loopback && !authenticatedAgent && !controlPlaneConfigurationAccess)) {
    context.jsonResponse(response, 403, { code: -1, error: {
      code: deploymentRequest ? "xiaomi_home_loopback_required" : "xiaomi_home_connection_auth_required",
      message: deploymentRequest ? "Installation operations execute on the local PC." : "A verified Manager connection is required."
    } });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/health`) {
    respond(response, context, context.runtime.health());
    return true;
  }
  const cloudRoot = `${root}/vacuum-cloud`;
  const remoteRoot = `${root}/vacuum-remote`;
  if(requestUrl.pathname.startsWith(remoteRoot)){
    const command=requestUrl.pathname.slice(remoteRoot.length+1);
    const allowedQuery=command==="capabilities"?["resourceId"]:command==="status"?["sessionId","idempotencyKey"]:[];
    if([...requestUrl.searchParams.keys()].some(k=>!allowedQuery.includes(k)||requestUrl.searchParams.getAll(k).length!==1)){
      context.jsonResponse(response,400,{code:-1,error:{code:"xiaomi_vacuum_remote_query_invalid",message:"Unexpected remote query parameter."}});return true;
    }
    response.setHeader("Cache-Control","no-store");
    if(request.method==="GET" && command==="capabilities"){respond(response,context,context.runtime.vacuumRemote.capabilities(requestUrl.searchParams.get("resourceId") || ""));return true;}
    if(request.method==="GET" && command==="status"){
      respond(response,context,Promise.resolve().then(()=>{
        if(requestUrl.searchParams.has("sessionId")===requestUrl.searchParams.has("idempotencyKey"))throw new XiaomiHomeManagerApiError(400,"xiaomi_vacuum_remote_query_invalid","Choose one session or original action key.");
        return requestUrl.searchParams.has("sessionId")?context.runtime.vacuumRemote.status(requestUrl.searchParams.get("sessionId")!):context.runtime.vacuumRemote.receipt(requestUrl.searchParams.get("idempotencyKey")!);
      }));return true;
    }
    if(request.method==="POST" && ["start","pulse","stop","exit"].includes(command)){
      const key=requireLifecycleFence(request,response,context) && requireIdempotencyKey(request,response,context);if(!key)return true;
      respond(response,context,context.readJsonBody<Record<string,unknown>>(request).then(body=>context.runtime.vacuumRemote.command(command,body,key)));return true;
    }
  }
  if (requestUrl.pathname.startsWith(cloudRoot)) {
    const suffix = requestUrl.pathname.slice(cloudRoot.length);
    const allowedQuery = ["/video/network", "/position", "/telemetry"].includes(suffix) ? ["deviceId", "region"] : suffix === "/video/password" ? ["deviceId", "region", "idempotencyKey"] : suffix === "/video/status" ? ["sessionId", "idempotencyKey"] : ["/video/stream", "/video/frame"].includes(suffix) ? ["sessionId"] : suffix === "/devices" ? ["region"] : ["/plugin-package", "/plugin-information"].includes(suffix) ? ["deviceId", "region", "sdkVersion"] : suffix === "/trajectory" ? ["deviceId", "region", "poseId"] : suffix === "/feedback" ? ["deviceId", "region", "slot", "scope", "poseId"] : suffix === "/path" ? ["deviceId", "region", "slot", "mapHash", "targetX", "targetY", "clearanceMm"] : suffix === "/map" ? ["deviceId", "region", "slot"] : suffix === "/connect" ? ["deviceId", "view"] : [];
    if ([...requestUrl.searchParams.keys()].some(key => !allowedQuery.includes(key) || requestUrl.searchParams.getAll(key).length !== 1)) {
      context.jsonResponse(response, 400, { code: -1, error: { code: "xiaomi_vacuum_cloud_query_invalid", message: "Unexpected or repeated cloud query parameter." } });
      return true;
    }
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && suffix === "/video/status") {
      respond(response, context, Promise.resolve().then(() => {
        if (requestUrl.searchParams.has("sessionId") && requestUrl.searchParams.has("idempotencyKey")) throw new XiaomiHomeManagerApiError(400, "xiaomi_vacuum_video_query_invalid", "Choose a session or action key.");
        return requestUrl.searchParams.has("idempotencyKey") ? context.runtime.vacuumCloud.video.receipt(requestUrl.searchParams.get("idempotencyKey")!) : context.runtime.vacuumCloud.video.status(requestUrl.searchParams.get("sessionId") || undefined);
      })); return true;
    }
    if (request.method === "GET" && suffix === "/video/network") {
      respond(response, context, context.runtime.vacuumCloud.videoNetwork(requestUrl.searchParams.get("deviceId") || "", requestUrl.searchParams.get("region") || "cn")); return true;
    }
    if (request.method === "GET" && suffix === "/video/password") {
      respond(response, context, Promise.resolve().then(() => {
        if (requestUrl.searchParams.has("idempotencyKey")) {
          if (requestUrl.searchParams.has("deviceId") || requestUrl.searchParams.has("region")) throw new XiaomiHomeManagerApiError(400, "xiaomi_vacuum_video_query_invalid", "Choose a device or action key.");
          return context.runtime.vacuumCloud.videoPasswordReceipt(requestUrl.searchParams.get("idempotencyKey")!);
        }
        return context.runtime.vacuumCloud.videoPasswordStatus(requestUrl.searchParams.get("deviceId") || "", requestUrl.searchParams.get("region") || "cn");
      })); return true;
    }
    if (request.method === "POST" && ["/video/start", "/video/stop", "/video/password/forget"].includes(suffix)) {
      const key = requireLifecycleFence(request, response, context) && requireIdempotencyKey(request, response, context);
      if (!key) return true;
      respond(response, context, context.readJsonBody<Record<string, unknown>>(request).then<unknown>(body => {
        const allowed = suffix === "/video/start" ? ["deviceId", "region", "password", "rememberPassword"] : suffix === "/video/password/forget" ? ["deviceId", "region"] : ["sessionId"];
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) throw new XiaomiHomeManagerApiError(400, "xiaomi_vacuum_video_body_invalid", "Unexpected video parameter.");
        if (suffix === "/video/stop") {
          if (typeof body.sessionId !== "string") throw new XiaomiHomeManagerApiError(400, "xiaomi_vacuum_video_body_invalid", "Supply a video session ID.");
          return context.runtime.vacuumCloud.video.stop(body.sessionId);
        }
        if (typeof body.deviceId !== "string" || body.region !== undefined && typeof body.region !== "string") throw new XiaomiHomeManagerApiError(400, "xiaomi_vacuum_video_body_invalid", "Supply a numeric device ID and optional region.");
        if (suffix === "/video/password/forget") return context.runtime.vacuumCloud.forgetVideoPassword(body.deviceId, String(body.region || "cn"), key);
        if (body.rememberPassword !== undefined && typeof body.rememberPassword !== "boolean") throw new XiaomiHomeManagerApiError(400, "xiaomi_vacuum_video_body_invalid", "rememberPassword must be boolean.");
        if (body.password !== undefined && typeof body.password !== "string") throw new XiaomiHomeManagerApiError(400, "xiaomi_vacuum_video_body_invalid", "视频密码必须是四位数字字符串。");
        const password = body.password as string | undefined; delete body.password;
        return context.runtime.vacuumCloud.video.start(body.deviceId, String(body.region || "cn"), key, password, body.rememberPassword === true);
      })); return true;
    }
    if (request.method === "GET" && ["/video/stream", "/video/frame"].includes(suffix)) {
      const operation = context.runtime.vacuumCloud.video.stream(requestUrl.searchParams.get("sessionId") || "", response, suffix === "/video/frame");
      void (context.trackOperation?.(operation) ?? operation).catch(error => {
        if (response.headersSent) { if (!response.destroyed) response.destroy(); return; }
        const shown = presentedError(error); context.jsonResponse(response, shown.status, { code: -1, error: { code: shown.code, message: shown.message } });
      }); return true;
    }
    if (request.method === "GET" && suffix === "/connect") {
      if (requestUrl.searchParams.has("view") && requestUrl.searchParams.get("view") !== "embedded"
        || requestUrl.searchParams.has("deviceId") && !/^\d{1,32}$/.test(requestUrl.searchParams.get("deviceId")!)) {
        context.jsonResponse(response, 400, { code: -1, error: { code: "xiaomi_vacuum_cloud_query_invalid", message: "Invalid map view or device ID." } }); return true;
      }
      const nonce = randomBytes(16).toString("base64");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`, "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
      response.end(vacuumCloudConnectPage(nonce)); return true;
    }
    if (request.method === "GET" && suffix === "/status") {
      respond(response, context, Promise.resolve().then(() => context.runtime.vacuumCloud.status())); return true;
    }
    if (request.method === "POST" && suffix === "/login") {
      const key = requireLifecycleFence(request, response, context) && requireIdempotencyKey(request, response, context);
      if (!key) return true;
      respond(response, context, context.readJsonBody<Record<string, never>>(request).then(body => {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new XiaomiHomeManagerApiError(400, "xiaomi_vacuum_cloud_body_invalid", "QR login accepts an empty JSON object.");
        return context.runtime.vacuumCloud.begin(key);
      })); return true;
    }
    if (request.method === "POST" && suffix === "/login/poll") {
      if (!requireLifecycleFence(request, response, context)) return true;
      respond(response, context, context.readJsonBody<{ sessionId: string }>(request).then(body => {
        if (!body || typeof body !== "object" || Object.keys(body).some(key => key !== "sessionId") || typeof body.sessionId !== "string") throw new XiaomiHomeManagerApiError(400, "xiaomi_vacuum_cloud_body_invalid", "Supply only the current sessionId.");
        return context.runtime.vacuumCloud.poll(body.sessionId);
      })); return true;
    }
    if (request.method === "GET" && suffix === "/devices") {
      respond(response, context, context.runtime.vacuumCloud.devices(requestUrl.searchParams.get("region") || "cn")); return true;
    }
    if (request.method === "GET" && suffix === "/plugin-package") {
      respond(response, context, context.runtime.vacuumCloud.pluginPackage(requestUrl.searchParams.get("deviceId") || "", requestUrl.searchParams.get("region") || "cn", Number(requestUrl.searchParams.get("sdkVersion") || 10112))); return true;
    }
    if (request.method === "GET" && suffix === "/plugin-information") {
      respond(response, context, context.runtime.vacuumCloud.pluginInformation(requestUrl.searchParams.get("deviceId") || "", requestUrl.searchParams.get("region") || "cn", Number(requestUrl.searchParams.get("sdkVersion") || 10112))); return true;
    }
    if (request.method === "GET" && suffix === "/map") {
      respond(response, context, context.runtime.vacuumCloud.map(requestUrl.searchParams.get("deviceId") || "", requestUrl.searchParams.get("region") || "cn", requestUrl.searchParams.get("slot") || "0")); return true;
    }
    if (request.method === "GET" && suffix === "/path") {
      respond(response, context, context.runtime.vacuumCloud.path(requestUrl.searchParams.get("deviceId") || "", requestUrl.searchParams.get("region") || "cn", requestUrl.searchParams.get("slot") || "0", requestUrl.searchParams.get("mapHash") || "", requestUrl.searchParams.get("targetX") || "", requestUrl.searchParams.get("targetY") || "", requestUrl.searchParams.get("clearanceMm") || "250")); return true;
    }
    if (request.method === "GET" && suffix === "/trajectory") {
      respond(response, context, context.runtime.vacuumCloud.trajectory(requestUrl.searchParams.get("deviceId") || "", requestUrl.searchParams.get("region") || "cn", requestUrl.searchParams.get("poseId") || "")); return true;
    }
    if (request.method === "GET" && suffix === "/feedback") {
      respond(response, context, context.runtime.vacuumCloud.feedback(requestUrl.searchParams.get("deviceId") || "", requestUrl.searchParams.get("region") || "cn", requestUrl.searchParams.get("slot") || "0", requestUrl.searchParams.get("scope") || "", requestUrl.searchParams.get("poseId") || "")); return true;
    }
    if (request.method === "GET" && suffix === "/position") {
      respond(response, context, context.runtime.vacuumCloud.position(requestUrl.searchParams.get("deviceId") || "", requestUrl.searchParams.get("region") || "cn")); return true;
    }
    if (request.method === "GET" && suffix === "/telemetry") {
      respond(response, context, context.runtime.vacuumCloud.telemetry(requestUrl.searchParams.get("deviceId") || "", requestUrl.searchParams.get("region") || "cn")); return true;
    }
  }
  // Local installation paths and process controls are intentionally loopback-only.
  if (request.method === "GET" && requestUrl.pathname === `${root}/deployment/events`) {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    response.flushHeaders();
    const unsubscribe = context.runtime.deployment.subscribe(snapshot => {
      if (!response.destroyed) response.write(`event: deployment\ndata: ${JSON.stringify(snapshot)}\n\n`);
    });
    response.once("close", unsubscribe);
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/deployment`) {
    respond(response, context, context.runtime.deployment.inspect());
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === `${root}/deployment`) {
    if (!requireLifecycleFence(request, response, context)) return true;
    respond(response, context, context.readJsonBody<{ config: HomeAssistantDeploymentConfig; revision: string }>(request)
      .then(body => context.runtime.deployment.save(body.config, body.revision)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/deployment/start`) {
    if (!requireLifecycleFence(request, response, context)) return true;
    respond(response, context, context.readJsonBody<{ revision: string }>(request)
      .then(body => context.runtime.deployment.ensureReady(body.revision)));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/deployment/install`) {
    if (!requireLifecycleFence(request, response, context)) return true;
    respond(response, context, context.readJsonBody<{ revision: string }>(request)
      .then(body => context.runtime.deployment.install(body.revision)));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/auth`) {
    respond(response, context, context.runtime.authorization());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/auth`) {
    const key = requireLifecycleFence(request, response, context) && requireIdempotencyKey(request, response, context);
    if (!key) return true;
    respond(response, context, context.readJsonBody<XiaomiHomeAuthorizeRequest>(request).then(body =>
      authReceipts(context).execute(key, {
        operation: "connect",
        baseUrl: body.baseUrl,
        settingsRevision: body.settingsRevision,
        authorizationRevision: body.authorizationRevision,
        tokenHash: createHash("sha256").update(String(body.accessToken || "")).digest("hex")
      }, () => context.runtime.authorize(body.accessToken, body.baseUrl, body.settingsRevision, body.authorizationRevision))));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/auth/refresh`) {
    const key = requireLifecycleFence(request, response, context) && requireIdempotencyKey(request, response, context);
    if (!key) return true;
    respond(response, context, context.readJsonBody<XiaomiHomeAuthorizationMutationRequest>(request).then(body =>
      authReceipts(context).execute(key, { operation: "refresh", authorizationRevision: body.authorizationRevision },
        () => context.runtime.refreshAuthorization(body.authorizationRevision))));
    return true;
  }
  if (request.method === "DELETE" && requestUrl.pathname === `${root}/auth`) {
    const key = requireLifecycleFence(request, response, context) && requireIdempotencyKey(request, response, context);
    if (!key) return true;
    respond(response, context, context.readJsonBody<XiaomiHomeAuthorizationMutationRequest>(request).then(body =>
      authReceipts(context).execute(key, { operation: "disconnect", authorizationRevision: body.authorizationRevision },
        () => context.runtime.disconnect(body.authorizationRevision))));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/settings`) {
    respond(response, context, Promise.resolve(context.runtime.settings()));
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === `${root}/settings`) {
    if (!requireLifecycleFence(request, response, context)) return true;
    respond(response, context, context.readJsonBody<XiaomiHomeSettingsUpdate>(request)
      .then(body => context.runtime.update(body.settings, String(body.revision || ""))));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/resources`) {
    if ([...requestUrl.searchParams.keys()].some(key => key !== "includeActions")
      || requestUrl.searchParams.getAll("includeActions").length > 1
      || requestUrl.searchParams.has("includeActions") && !["0", "1"].includes(requestUrl.searchParams.get("includeActions")!)) {
      context.jsonResponse(response, 400, {code: -1, error: {code: "xiaomi_home_query_invalid", message: "includeActions must be 0 or 1."}});
      return true;
    }
    respond(response, context, context.runtime.client.listResources(requestUrl.searchParams.get("includeActions") === "1"));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/devices`) {
    if (requestUrl.search) {
      context.jsonResponse(response, 400, { code: -1, error: { code: "xiaomi_home_query_invalid", message: "Device directory does not accept query parameters." } });
      return true;
    }
    respond(response, context, context.runtime.client.listDevices());
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/entity-actions`) {
    if (requestUrl.searchParams.getAll("resourceId").length !== 1 || !requestUrl.searchParams.get("resourceId")
      || [...requestUrl.searchParams.keys()].some(key => key !== "resourceId")) {
      context.jsonResponse(response, 400, {code: -1, error: {code: "xiaomi_home_query_invalid", message: "Supply one resourceId."}});
      return true;
    }
    respond(response, context, context.runtime.client.getResourceActions(requestUrl.searchParams.get("resourceId")!));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/capabilities`) {
    respond(response, context, Promise.resolve(context.runtime.client.getCapabilities()));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/action-requests`) {
    if (requestUrl.searchParams.getAll("idempotencyKey").length !== 1 || [...requestUrl.searchParams.keys()].some(key => key !== "idempotencyKey")) {
      context.jsonResponse(response, 400, { code: -1, error: { code: "xiaomi_home_idempotency_required", message: "Supply one idempotencyKey query parameter." } });
      return true;
    }
    respond(response, context, Promise.resolve().then(() => context.runtime.client.getActionReceipt(requestUrl.searchParams.get("idempotencyKey") || "")));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname.startsWith(`${root}/resources/`)) {
    const resourceId = decodeURIComponent(requestUrl.pathname.slice(`${root}/resources/`.length));
    respond(response, context, context.runtime.client.getResource(resourceId));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/action-requests`) {
    if (!requireLifecycleFence(request, response, context)) return true;
    const idempotencyKey = String(request.headers["idempotency-key"] || "");
    respond(response, context, context.readJsonBody<XiaomiHomeActionRequest>(request)
      .then(body => context.runtime.client.executeAction(body, idempotencyKey)), 202);
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/events`) {
    if (!requireLifecycleFence(request, response, context)) return true;
    respond(response, context, context.readJsonBody<{ event: XiaomiHomeEvent; agentRoleId: string }>(request)
      .then(body => context.deliverEvent(body.event, { agentRoleId: body.agentRoleId })), 202);
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/artifacts`) {
    respond(response, context, Promise.resolve(context.runtime.artifacts.list({
      resourceId: requestUrl.searchParams.get("resourceId") || undefined,
      eventKind: requestUrl.searchParams.get("eventKind") || undefined
    })));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/artifacts/lifecycle`) {
    respond(response, context, Promise.resolve(context.runtime.artifacts.lifecycleContract()));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname.startsWith(`${root}/artifacts/`) && requestUrl.pathname.endsWith("/content")) {
    const encoded = requestUrl.pathname.slice(`${root}/artifacts/`.length, -"/content".length);
    try {
      context.runtime.artifactAccess.stream(request, response, decodeURIComponent(encoded));
    } catch (error) {
      const presented = presentedError(error);
      context.jsonResponse(response, presented.status, { code: -1, error: { code: presented.code, message: presented.message } });
    }
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname.startsWith(`${root}/artifacts/`)) {
    const artifactId = decodeURIComponent(requestUrl.pathname.slice(`${root}/artifacts/`.length));
    const artifact = context.runtime.artifacts.get(artifactId);
    if (!artifact) context.jsonResponse(response, 404, { code: -1, error: { code: "xiaomi_home_artifact_not_found", message: "Artifact was not found." } });
    else context.jsonResponse(response, 200, { code: 0, data: artifact });
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/artifacts`) {
    if (!requireLifecycleFence(request, response, context)) return true;
    respond(response, context, context.readJsonBody<XiaomiHomeArtifactInput>(request).then(body => context.runtime.artifacts.register(body)), 201);
    return true;
  }
  context.jsonResponse(response, 404, { code: -1, error: { code: "xiaomi_home_route_not_found", message: "Xiaomi Home API route was not found." } });
  return true;
}

export function createXiaomiHomeManagerRouteHandler(context: XiaomiHomeManagerRoutesContext): ManagerPluginRouteHandler {
  return (request, requestUrl, response) => handleXiaomiHomeManagerApi(request, requestUrl, response, context);
}
