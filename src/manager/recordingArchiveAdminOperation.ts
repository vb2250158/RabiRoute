import type { ApiOperationResult } from "./apiOperationContract.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { validateLanAgentRequestBody } from "./lanAgentBodyAuthority.js";
import { executeDurableDelivery } from "./durableDeliveryIdempotency.js";
import { ArchiveAdminError, archiveAdminDigest, archiveSettingsEtag, validateArchiveAdminInput, type RecordingArchiveBindings, type ArchiveAdminResult } from "./recordingArchiveBindings.js";
import { resourceRequestJson, type ResourceApiInput } from "./resourceApiRequest.js";
import { RESOURCE_SETTINGS_MAX_BYTES } from "./resourceCacheProtocol.js";

export interface RecordingArchiveAdminOptions {
  bindings: RecordingArchiveBindings;
  receiptRoot: string;
  identity(): { applicationGenerationId: string; managerInstanceId: string };
  workerId(): string;
  readOnly(): boolean;
  changed?(): Promise<void> | void;
}
type Result = { status: 200; data: ArchiveAdminResult } | { status: number; code: string };

/** One durable administrative owner for executable and compatibility entry points. */
export async function runRecordingArchiveAdminOperation(options: RecordingArchiveAdminOptions, invocation: ResourceApiInput): Promise<ApiOperationResult> {
  const { request } = invocation;
  let mutationStarted = false, deliveryDispatched = false;
  let originalPrincipal: ReturnType<typeof assertTrustedLanAgentPrincipal>, principalCaptured = false;
  const assertAccess = () => {
    const principal = assertTrustedLanAgentPrincipal(request);
    if (principalCaptured && principal !== originalPrincipal) throw new ArchiveAdminError(403, "authorization_revoked");
    const verifiedConnection = hasAuthenticatedConnectionRequest(request);
    if (!localModelSettingsRequestAllowed(request)
      || !principal && !verifiedConnection && Object.keys(request.headers).some(key => key.startsWith("x-rabilink-")))
      throw new ArchiveAdminError(403, "administrative_authorization_required");
    originalPrincipal = principal; principalCaptured = true;
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): ApiOperationResult => {
    try { assertAccess(); }
    catch { status = 403; body = { code: "authorization_revoked", commitState: mutationStarted || deliveryDispatched ? "unknown" : "not_started" }; headers = {}; }
    return { status, headers: { "cache-control": "no-store", ...headers }, body };
  };
  const header = (name: string) => {
    const values = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]!.toLowerCase() === name);
    const value = request.headers[name];
    return values.length === 1 && typeof value === "string" ? value : "";
  };
  try {
    assertAccess();
    if (request.method === "GET") {
      const data = await options.bindings.listBindings();
      return json(200, { code: 0, data: { workerId: options.workerId(), ...data } }, { etag: archiveSettingsEtag(data) });
    }
    if (request.method !== "PUT") return json(405, { code: "method_not_allowed" });
    const identity = options.identity();
    const generation = header("x-rabiroute-expected-application-generation-id"), instance = header("x-rabiroute-expected-manager-instance-id");
    if (!generation || !instance) return json(400, { code: "identity_required" });
    const assertMutation = () => {
      assertAccess();
      if (options.readOnly()) throw new ArchiveAdminError(423, "read_only");
      const now = options.identity();
      if (!identity.applicationGenerationId || !identity.managerInstanceId || generation !== now.applicationGenerationId || instance !== now.managerInstanceId)
        throw new ArchiveAdminError(409, "generation_changed");
    };
    assertMutation();
    const key = header("idempotency-key"), etag = header("if-match");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || !/^"[^"\r\n]+"$/.test(etag)) return json(400, { code: "strong_preconditions_required" });
    if (!/^application\/json(?:\s*;|$)/i.test(header("content-type"))) return json(415, { code: "json_required" });
    let input;
    try {
      const body = await resourceRequestJson(invocation, RESOURCE_SETTINGS_MAX_BYTES, true);
      assertMutation(); validateLanAgentRequestBody(request, body);
      input = validateArchiveAdminInput(body);
    } catch (error) {
      if ((error as { status?: number })?.status === 413) return json(413, { code: "body_too_large" });
      if (error instanceof ArchiveAdminError && error.status !== 400) throw error;
      return json(400, { code: "invalid_request" });
    }
    const digest = archiveAdminDigest(input, etag);
    const outcome = await executeDurableDelivery<Result>({
      rootDir: options.receiptRoot, namespace: "recording-archive-admin", deliveryId: key,
      payload: { input, etag }, waitForCompletionMs: 0, recoverExistingUncertain: true,
      deliver: async () => {
        assertMutation(); validateLanAgentRequestBody(request, input); deliveryDispatched = true;
        try { return { status: 200, data: await options.bindings.configureAdministrative(input, etag, key, {
          assertCurrent: assertMutation, beforeMutation: () => { assertMutation(); mutationStarted = true; }
        }) }; }
        catch (error) { if (!mutationStarted && error instanceof ArchiveAdminError) return { status: error.status, code: error.code }; throw error; }
      },
      recover: async () => {
        assertAccess(); const result = await options.bindings.recoverAdministrative(key, digest); assertAccess();
        return result ? { state: "completed", result: { status: 200, data: result } }
          : { state: "uncertain", reason: "No exact configuration operation stamp; read back before further action." };
      }
    });
    if (outcome.state !== "completed") return json(outcome.state === "conflict" ? 409 : 503,
      { code: outcome.state, commitState: "unknown", nextAction: "read_back_same_operation" }, { "idempotency-key": key });
    const result = outcome.result;
    if (result.status !== 200 || !("data" in result)) return json(result.status,
      { code: "code" in result ? result.code : "invalid_result", commitState: "not_started" }, { "idempotency-key": key });
    assertAccess();
    try { await options.changed?.(); } catch { /* Refresh failure cannot retract committed settings. */ }
    const after = options.identity();
    if (after.applicationGenerationId !== generation || after.managerInstanceId !== instance) return json(503,
      { code: "generation_changed", commitState: "committed", nextAction: "rediscover_and_read_back" }, { "idempotency-key": key });
    return json(200, { code: 0, data: { workerId: options.workerId(), revision: result.data.revision, ownerRoleBindings: result.data.ownerRoleBindings }, duplicate: outcome.duplicate },
      { etag: result.data.etag, "idempotency-key": key });
  } catch (error) {
    if (error instanceof ArchiveAdminError && !mutationStarted && !deliveryDispatched) return json(error.status, { code: error.code, commitState: "not_started" });
    return json(503, { code: "archive_settings_unavailable", commitState: mutationStarted || deliveryDispatched ? "unknown" : "not_started", nextAction: "read_back_same_operation" });
  }
}
