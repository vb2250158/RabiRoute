import type http from "node:http";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { validateLanAgentRequestBody } from "./lanAgentBodyAuthority.js";
import { executeDurableDelivery } from "./durableDeliveryIdempotency.js";
import { ArchiveAdminError, archiveAdminDigest, archiveSettingsEtag, validateArchiveAdminInput, type RecordingArchiveBindings, type ArchiveAdminResult } from "./recordingArchiveBindings.js";

export interface RecordingArchiveAdminOptions {
  bindings: RecordingArchiveBindings;
  receiptRoot: string;
  identity(): { applicationGenerationId: string; managerInstanceId: string };
  workerId(): string;
  readOnly(): boolean;
  changed?(): Promise<void> | void;
}
type Result = { status: 200; data: ArchiveAdminResult } | { status: number; code: string };
/** Mount before the legacy resource-cache handler. Device resources tunnels remain non-administrative. */
export function recordingArchiveAdminHandler(options: RecordingArchiveAdminOptions) {
  return (request: http.IncomingMessage, url: URL, response: http.ServerResponse): boolean => {
    if (url.pathname !== "/api/resource-cache/archive-settings") return false;
    let mutationStarted = false;
    let deliveryDispatched = false;
    let originalPrincipal: ReturnType<typeof assertTrustedLanAgentPrincipal>;
    let principalCaptured = false;
    const assertAccess = () => {
      const principal = assertTrustedLanAgentPrincipal(request);
      if (principalCaptured && principal !== originalPrincipal) throw new ArchiveAdminError(403, "authorization_revoked");
      // An enabled authenticated Agent and a verified RabiRoute connection are both sufficient;
      // an unverified tunnel header alone never is.
      const verifiedConnection = hasAuthenticatedConnectionRequest(request);
      if (!localModelSettingsRequestAllowed(request)
        || !principal && !verifiedConnection && Object.keys(request.headers).some(key => key.startsWith("x-rabilink-")))
        throw new ArchiveAdminError(403, "administrative_authorization_required");
      originalPrincipal = principal; principalCaptured = true;
    };
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      if (response.headersSent) { response.destroy(); return; }
      try { assertAccess(); }
      catch { status = 403; body = { code: "authorization_revoked", commitState: mutationStarted || deliveryDispatched ? "unknown" : "not_started" }; headers = {}; }
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); response.end(JSON.stringify(body));
    };
    const header = (name: string) => {
      const values = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === name);
      const value = request.headers[name];
      return values.length === 1 && typeof value === "string" ? value : "";
    };
    void (async () => {
      assertAccess();
      if (request.method === "GET") {
        const data = await options.bindings.listBindings();
        json(200, { code: 0, data: { workerId: options.workerId(), ...data } }, { etag: archiveSettingsEtag(data) }); return;
      }
      if (request.method !== "PUT") { json(405, { code: "method_not_allowed" }); return; }
      const identity = options.identity();
      const generation = header("x-rabiroute-expected-application-generation-id"), instance = header("x-rabiroute-expected-manager-instance-id");
      if (!generation || !instance) { json(400, { code: "identity_required" }); return; }
      const assertMutation = () => {
        assertAccess();
        if (options.readOnly()) throw new ArchiveAdminError(423, "read_only");
        const now = options.identity();
        if (!identity.applicationGenerationId || !identity.managerInstanceId || generation !== now.applicationGenerationId || instance !== now.managerInstanceId)
          throw new ArchiveAdminError(409, "generation_changed");
      };
      assertMutation();
      const key = header("idempotency-key"), etag = header("if-match");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || !/^"[^"\r\n]+"$/.test(etag)) { json(400, { code: "strong_preconditions_required" }); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(header("content-type"))) { json(415, { code: "json_required" }); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { assertAccess(); size += chunk.length; if (size > 8192) { json(413, { code: "body_too_large" }); return; } chunks.push(Buffer.from(chunk)); }
      assertMutation();
      let input;
      try {
        const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        validateLanAgentRequestBody(request, body);
        input = validateArchiveAdminInput(body);
      }
      catch { json(400, { code: "invalid_request" }); return; }
      const digest = archiveAdminDigest(input, etag);
      const outcome = await executeDurableDelivery<Result>({
        rootDir: options.receiptRoot, namespace: "recording-archive-admin", deliveryId: key,
        payload: { input, etag }, waitForCompletionMs: 0, recoverExistingUncertain: true,
        deliver: async () => {
          // Recheck the principal, body authority and identity at the mutation boundary.
          assertMutation();
          validateLanAgentRequestBody(request, input);
          deliveryDispatched = true;
          try {
            return { status: 200, data: await options.bindings.configureAdministrative(input, etag, key, {
              assertCurrent: assertMutation,
              beforeMutation: () => { assertMutation(); mutationStarted = true; }
            }) };
          } catch (error) {
            if (!mutationStarted && error instanceof ArchiveAdminError) return { status: error.status, code: error.code };
            throw error;
          }
        },
        recover: async () => {
          assertAccess();
          const result = await options.bindings.recoverAdministrative(key, digest);
          assertAccess();
          return result ? { state: "completed", result: { status: 200, data: result } } : { state: "uncertain", reason: "No exact configuration operation stamp; read back before further action." };
        }
      });
      if (outcome.state !== "completed") { json(outcome.state === "conflict" ? 409 : 503, { code: outcome.state, commitState: "unknown", nextAction: "read_back_same_operation" }, { "idempotency-key": key }); return; }
      const result = outcome.result;
      if (result.status !== 200 || !("data" in result)) { json(result.status, { code: "code" in result ? result.code : "invalid_result", commitState: "not_started" }, { "idempotency-key": key }); return; }
      assertAccess();
      try { await options.changed?.(); } catch { /* A refresh failure never retracts committed settings. */ }
      const after = options.identity();
      if (after.applicationGenerationId !== generation || after.managerInstanceId !== instance) { json(503, { code: "generation_changed", commitState: "committed", nextAction: "rediscover_and_read_back" }, { "idempotency-key": key }); return; }
      json(200, { code: 0, data: { workerId: options.workerId(), revision: result.data.revision, ownerRoleBindings: result.data.ownerRoleBindings }, duplicate: outcome.duplicate }, { etag: result.data.etag, "idempotency-key": key });
    })().catch(error => {
      if (error instanceof ArchiveAdminError && !mutationStarted && !deliveryDispatched) json(error.status, { code: error.code, commitState: "not_started" });
      else json(503, { code: "archive_settings_unavailable", commitState: mutationStarted || deliveryDispatched ? "unknown" : "not_started", nextAction: "read_back_same_operation" });
    });
    return true;
  };
}
