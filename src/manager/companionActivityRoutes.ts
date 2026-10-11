import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import type http from "node:http";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { CompanionActivity, CompanionError } from "./companionActivity.js";
import type { CompanionContinuationStore } from "./companionContinuation.js";

export function companionActivityHandler(service: CompanionActivity, options: {
  local(request: http.IncomingMessage): boolean; readOnly(): boolean;
  verifyGateway(roleId: string, gatewayId: string | undefined): string;
  saveSummaryDefault(roleId: string): Promise<boolean>;
  last(roleId: string): Promise<unknown>;
  continuation?: CompanionContinuationStore;
}) {
  return (request: http.IncomingMessage, url: URL, response: http.ServerResponse): boolean => {
    const match = /^\/api\/roles\/([^/]+)\/companion(?:\/(start|command|observation|review|reply|frame|last))?$/.exec(url.pathname);
    if (!match) return false;
    let authorize: (() => void) | undefined;
    const send = (status: number, body: unknown, fence = true) => {
      if (response.writableEnded || response.destroyed) return;
      if (fence) authorize?.();
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    void (async () => {
      const lease = assertTrustedLanAgentPrincipal(request);
      authorize = () => {
        if (lease) {
          if (assertTrustedLanAgentPrincipal(request) !== lease) throw new CompanionError("Activity authorization changed", 403);
        } else if (!localModelSettingsRequestAllowed(request) || !options.local(request) || request.headers["x-rabilink-tunnel-local"]) {
          throw new CompanionError("Activity authorization denied", 403);
        }
        if (request.method !== "GET" && options.readOnly()) throw new CompanionError("Read only", 403);
      };
      authorize();
      const roleId = decodeURIComponent(match[1]), action = match[2] || "";
      if (!sanitizeRoleId(roleId) || /[\\/]/.test(roleId) || roleId === "." || roleId === "..") throw new CompanionError("Invalid persona");
      if (request.method === "GET") {
        if (!action) {
          const snapshot = service.snapshot(roleId);
          const resumeIntent = snapshot.session?.status === "active" || snapshot.session?.status === "paused"
            ? null : await options.continuation?.read(roleId) ?? null;
          send(200, { code: 0, data: { ...snapshot, resumeIntent } }); return;
        }
        if (action === "last") { send(200, { code: 0, data: await options.last(roleId) }); return; }
        if (action === "frame") {
          const bytes = service.frameFor(roleId, url.searchParams.get("reviewId") || "");
          authorize();
          response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, no-store" }); response.end(bytes); return;
        }
      }
      if (request.method !== "POST") throw new CompanionError("Unsupported activity operation", 405);
      if (options.readOnly()) throw new CompanionError("Read only", 403);
      if (!String(request.headers["content-type"]).toLowerCase().startsWith("application/json")) throw new CompanionError("Use application/json", 415);
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { authorize(); size += chunk.length; if (size > 3 * 1024 * 1024) throw new CompanionError("Activity body exceeds 3 MiB", 413); chunks.push(Buffer.from(chunk)); }
      authorize();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new CompanionError("Expected JSON object");
      let data: unknown;
      if (action === "start") {
        const gatewayId = options.verifyGateway(roleId, body.gatewayId);
        const saveSummary = body.saveSummary ?? (body.observationOwner === "desktop" ? await options.saveSummaryDefault(roleId) : false);
        authorize();
        data = await service.start(roleId, { ...body, gatewayId, saveSummary });
        const session = service.snapshot(roleId).session!;
        if (session.observationOwner === "desktop") await options.continuation?.save(session);
        else await options.continuation?.clear(roleId);
      }
      else if (action === "command") {
        data = await service.command(roleId, body);
        if (body.action === "stop" || body.action === "pause") await options.continuation?.clear(roleId);
        else if (body.action === "resume") {
          const session = service.snapshot(roleId).session;
          if (session) await options.continuation?.save(session);
        }
      }
      else if (action === "observation") data = service.observe(roleId, body.sessionId, body.revision, body.observation);
      else if (action === "review") data = await service.review(roleId, body.sessionId, body.revision, body.text || "");
      else if (action === "reply") data = await service.reply(roleId, body);
      else throw new CompanionError("Unsupported activity operation", 405);
      send(200, { code: 0, data });
    })().catch(error => {
      try { authorize?.(); } catch { error = new CompanionError("Activity authorization denied", 403); }
      send(error instanceof CompanionError ? error.statusCode : 400, { code: -1, message: error instanceof Error ? error.message : String(error) }, false);
    });
    return true;
  };
}
