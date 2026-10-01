import type { NotificationRule, RouteProfile } from "../config.js";
import { personaConfigFragmentFromValue } from "../manager/configMigration.js";
import {
  ROLE_CONTEXT_CAPABILITY_HEADER,
  ROLE_CONTEXT_GENERATION_HEADER,
  ROLE_CONTEXT_MANAGER_HEADER,
  ROLE_CONTEXT_ROUTE_HEADER
} from "../manager/roleContextProjection.js";
import { normalizeRecentMessageLimit, normalizeRecentMessageLimits, notificationRulesFromPersonaAutomations } from "../shared/gatewayConfigModel.js";
import type { RemotePersonaSnapshot } from "../manager/remotePersonaRoutes.js";

export type { RemotePersonaSnapshot } from "../manager/remotePersonaRoutes.js";

export class RemotePersonaUnavailableError extends Error {
  constructor(message: string, readonly code = "REMOTE_PERSONA_UNAVAILABLE", readonly statusCode = 503) {
    super(message);
    this.name = "RemotePersonaUnavailableError";
  }
}

type RemotePersonaRequest = {
  managerBaseUrl: string;
  routeId: string;
  capability: string;
  applicationGenerationId: string;
  managerInstanceId: string;
  deviceId: string;
  roleId: string;
  file: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

function managerOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new RemotePersonaUnavailableError("Remote persona Manager address must be the current loopback HTTP origin.", "INVALID_MANAGER_URL", 400);
  }
  return url.origin;
}

/** One request-scoped snapshot from the owning Manager. Nothing is cached or written locally. */
export async function fetchRemotePersonaSnapshot(input: RemotePersonaRequest): Promise<RemotePersonaSnapshot> {
  if (![input.routeId, input.capability, input.applicationGenerationId, input.managerInstanceId, input.deviceId, input.roleId].every(value => value.trim())) {
    throw new RemotePersonaUnavailableError("Remote persona resolution requires the owning Route capability and Manager identity.", "REMOTE_PERSONA_IDENTITY_REQUIRED", 403);
  }
  const origin = managerOrigin(input.managerBaseUrl);
  const url = new URL("/api/internal/remote-persona/resolve", origin);
  url.search = new URLSearchParams({ routeId: input.routeId, file: input.file }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Remote persona request timed out.")), input.timeoutMs ?? 25_000);
  timeout.unref?.();
  const abort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      headers: {
        [ROLE_CONTEXT_ROUTE_HEADER]: input.routeId,
        [ROLE_CONTEXT_CAPABILITY_HEADER]: input.capability,
        [ROLE_CONTEXT_GENERATION_HEADER]: input.applicationGenerationId,
        [ROLE_CONTEXT_MANAGER_HEADER]: input.managerInstanceId
      },
      redirect: "error",
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({})) as {
      code?: number; error?: string; message?: string; data?: Partial<RemotePersonaSnapshot>;
    };
    if (!response.ok || payload.code !== 0) {
      throw new RemotePersonaUnavailableError(
        String(payload.message || `Remote persona resolution failed with HTTP ${response.status}.`),
        String(payload.error || "REMOTE_PERSONA_UNAVAILABLE"), response.status
      );
    }
    const snapshot = payload.data;
    const expectedKnowledgeBase = `${origin}/api/rabilink/peer/http/${encodeURIComponent(input.deviceId)}/persona`;
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.deviceId !== input.deviceId
      || snapshot.roleId !== input.roleId || snapshot.file !== input.file
      || snapshot.applicationGenerationId !== input.applicationGenerationId || snapshot.managerInstanceId !== input.managerInstanceId
      || typeof snapshot.remoteApplicationGenerationId !== "string" || !snapshot.remoteApplicationGenerationId.trim()
      || typeof snapshot.remoteManagerInstanceId !== "string" || !snapshot.remoteManagerInstanceId.trim()
      || snapshot.knowledgeApiBaseUrl !== expectedKnowledgeBase
      || typeof snapshot.document !== "string" || !snapshot.document.trim()
      || typeof snapshot.revision !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.revision)
      || !snapshot.personaConfig || typeof snapshot.personaConfig !== "object" || Array.isArray(snapshot.personaConfig)) {
      throw new RemotePersonaUnavailableError("Remote persona response failed its Route and Manager identity fence.", "REMOTE_PERSONA_IDENTITY_MISMATCH", 409);
    }
    return snapshot as RemotePersonaSnapshot;
  } catch (error) {
    if (error instanceof RemotePersonaUnavailableError) throw error;
    throw new RemotePersonaUnavailableError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}

/** Remote message policy is a transient projection; remote schedules and scripts keep their remote owner. */
export function routeWithRemotePersonaConfig(route: RouteProfile, snapshot: RemotePersonaSnapshot): RouteProfile {
  const fragment = personaConfigFragmentFromValue(snapshot.personaConfig);
  const automationRules = (fragment.automationRules ?? []).filter(rule => rule.trigger.type === "message" && rule.action.type === "deliver_agent");
  const notificationRules: NotificationRule[] = notificationRulesFromPersonaAutomations(automationRules).map(rule => ({
    ...rule,
    name: rule.name || rule.id,
    enabled: rule.enabled !== false,
    routeKinds: (rule.routeKinds ?? []) as NotificationRule["routeKinds"],
    schedules: undefined
  }));
  return {
    ...route,
    automationRules,
    notificationRules,
    recentMessageLimit: normalizeRecentMessageLimit(snapshot.personaConfig.recentMessageLimit),
    recentMessageLimits: fragment.recentMessageLimits ?? normalizeRecentMessageLimits(undefined),
    speechTriggerKeywords: fragment.speechTriggerKeywords,
    personaAutomationScriptsEnabled: false
  };
}
