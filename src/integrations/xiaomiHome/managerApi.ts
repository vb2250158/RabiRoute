import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  executeDurableDelivery,
  type DurableDeliveryOutcome
} from "../../manager/durableDeliveryIdempotency.js";

export type XiaomiHomeManagerConfigInput = {
  baseUrl?: string;
  tokenEnv?: string;
  requestTimeoutMs?: number;
  writeEnabled?: boolean;
  allowPublicBaseUrl?: boolean;
  runtimeDir?: string;
};

export type XiaomiHomeResource = {
  resourceId: string;
  entityId: string;
  kind: string;
  displayName: string;
  available: boolean;
  stateVersion: string;
  observedAt: string;
  state: string;
  attributes: Record<string, unknown>;
  capabilities: string[];
};

export type XiaomiHomeActionRequest = {
  requestId?: string;
  resourceId: string;
  capability: string;
  arguments?: Record<string, unknown>;
  expectedStateVersion: string;
  reason?: string;
  dryRun?: boolean;
};

export type XiaomiHomeActionReceipt = {
  requestId: string;
  idempotencyKey: string;
  resourceId: string;
  capability: string;
  status: "planned" | "succeeded" | "failed" | "uncertain";
  requestedAt: string;
  completedAt: string;
  beforeStateVersion: string;
  afterStateVersion?: string;
  provider: "home_assistant";
  error?: string;
};

type HomeAssistantState = {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
};

type FetchLike = typeof fetch;

export type ResolvedXiaomiHomeManagerConfig = {
  baseUrl: string;
  tokenEnv: string;
  requestTimeoutMs: number;
  writeEnabled: boolean;
};

type ActionMapping = {
  domain: string;
  service: string;
  data: Record<string, unknown>;
};

const defaultBaseUrl = "http://127.0.0.1:8123";
const defaultTokenEnv = "RABIROUTE_XIAOMI_HOME_HA_TOKEN";
const actionReceiptNamespace = "xiaomi-home-actions";
const stateVersionChangedReceiptError = "xiaomi_home_state_version_changed";

export class XiaomiHomeManagerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "XiaomiHomeManagerApiError";
  }
}

function isPrivateIpv4Literal(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const parts = hostname.split(".").map(Number);
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isPrivateIpv6Literal(hostname: string): boolean {
  if (isIP(hostname) !== 6) return false;
  if (hostname === "::1") return true;
  const firstHextet = Number.parseInt(hostname.split(":", 1)[0] || "0", 16);
  return (firstHextet & 0xfe00) === 0xfc00
    || (firstHextet & 0xffc0) === 0xfe80;
}

function isPrivateIpLiteral(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return isPrivateIpv4Literal(value) || isPrivateIpv6Literal(value);
}

function defaultRuntimeDir(): string {
  const local = String(process.env.LOCALAPPDATA || "").trim();
  return path.join(local || os.tmpdir(), "RabiRoute", "XiaomiHome");
}

function resolveActionReceiptRoot(runtimeDir: unknown): string {
  const candidate = String(runtimeDir || defaultRuntimeDir()).trim();
  try {
    const resolved = path.resolve(candidate);
    if (!candidate || (runtimeDir !== undefined && !path.isAbsolute(candidate))
      || candidate.startsWith("\\\\") || candidate.startsWith("//")
      || resolved.startsWith("\\\\") || resolved.startsWith("//")) {
      throw new Error("network path");
    }
    return resolved;
  } catch {
    throw new XiaomiHomeManagerApiError(500, "xiaomi_home_config_invalid", "Xiaomi Home runtimeDir must be an absolute local path.");
  }
}

export function resolveXiaomiHomeManagerConfig(input: XiaomiHomeManagerConfigInput = {}): ResolvedXiaomiHomeManagerConfig {
  const configuredBaseUrl = String(input.baseUrl || defaultBaseUrl).trim();
  let parsed: URL;
  try {
    parsed = new URL(configuredBaseUrl);
  } catch {
    throw new XiaomiHomeManagerApiError(500, "xiaomi_home_config_invalid", "Home Assistant baseUrl is invalid.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new XiaomiHomeManagerApiError(500, "xiaomi_home_config_invalid", "Home Assistant baseUrl must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new XiaomiHomeManagerApiError(500, "xiaomi_home_config_invalid", "Home Assistant baseUrl must be an origin without credentials, path, query, or fragment.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost") {
    // Pin localhost to a literal so a modified resolver cannot redirect the Bearer token.
    parsed.hostname = "127.0.0.1";
  } else if (input.allowPublicBaseUrl !== true && !isPrivateIpLiteral(hostname)) {
    throw new XiaomiHomeManagerApiError(500, "xiaomi_home_public_url_rejected", "Home Assistant baseUrl must use a literal loopback or private IP unless external hostnames are explicitly allowed.");
  }
  const tokenEnv = String(input.tokenEnv || defaultTokenEnv).trim();
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(tokenEnv)) {
    throw new XiaomiHomeManagerApiError(500, "xiaomi_home_config_invalid", "tokenEnv must be an uppercase environment variable name.");
  }
  const requestTimeoutMs = Number(input.requestTimeoutMs ?? 5000);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 250 || requestTimeoutMs > 30000) {
    throw new XiaomiHomeManagerApiError(500, "xiaomi_home_config_invalid", "requestTimeoutMs must be between 250 and 30000.");
  }
  return { baseUrl: parsed.origin, tokenEnv, requestTimeoutMs, writeEnabled: input.writeEnabled === true };
}

function stateVersion(state: HomeAssistantState): string {
  return `ha:${createHash("sha256").update(JSON.stringify({
    entityId: state.entity_id,
    state: state.state,
    attributes: state.attributes ?? {},
    lastUpdated: state.last_updated ?? state.last_changed ?? ""
  })).digest("hex").slice(0, 24)}`;
}

export function xiaomiHomeResourceId(entityId: string): string {
  return `home:ha:${entityId.trim().toLowerCase()}`;
}

export function xiaomiHomeEntityId(resourceId: string): string {
  const prefix = "home:ha:";
  const normalized = resourceId.trim();
  if (!normalized.startsWith(prefix) || !normalized.slice(prefix.length).includes(".")) {
    throw new XiaomiHomeManagerApiError(400, "xiaomi_home_resource_invalid", "resourceId is invalid.");
  }
  return normalized.slice(prefix.length);
}

function capabilitiesFor(entityId: string): string[] {
  const domain = entityId.split(".", 1)[0];
  const table: Record<string, string[]> = {
    light: ["home.light.turn_on@1", "home.light.turn_off@1", "home.light.set_brightness@1"],
    switch: ["home.switch.turn_on@1", "home.switch.turn_off@1"],
    fan: ["home.fan.turn_on@1", "home.fan.turn_off@1", "home.fan.set_percentage@1"],
    cover: ["home.cover.open@1", "home.cover.close@1", "home.cover.stop@1"],
    climate: ["home.climate.set_temperature@1", "home.climate.turn_off@1"],
    vacuum: ["home.vacuum.start@1", "home.vacuum.return_home@1"],
    event: ["home.event.read@1"]
  };
  return ["home.resource.read@1", ...(table[domain] ?? [])];
}

export function normalizeHomeAssistantState(state: HomeAssistantState): XiaomiHomeResource {
  const attributes = state.attributes && typeof state.attributes === "object" ? state.attributes : {};
  const kind = state.entity_id.split(".", 1)[0] || "unknown";
  return {
    resourceId: xiaomiHomeResourceId(state.entity_id),
    entityId: state.entity_id,
    kind,
    displayName: String(attributes.friendly_name || state.entity_id),
    available: state.state !== "unavailable" && state.state !== "unknown",
    stateVersion: stateVersion(state),
    observedAt: state.last_updated || state.last_changed || new Date().toISOString(),
    state: state.state,
    attributes,
    capabilities: capabilitiesFor(state.entity_id)
  };
}

function finiteNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new XiaomiHomeManagerApiError(400, "xiaomi_home_action_invalid", `${field} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function approximatelyEqual(left: unknown, right: number, tolerance = 1): boolean {
  const value = Number(left);
  return Number.isFinite(value) && Math.abs(value - right) <= tolerance;
}

export function xiaomiHomeActionSatisfied(request: XiaomiHomeActionRequest, resource: XiaomiHomeResource): boolean {
  const args = request.arguments ?? {};
  const stateTargets: Record<string, string[]> = {
    "home.light.turn_on@1": ["on"],
    "home.light.turn_off@1": ["off"],
    "home.switch.turn_on@1": ["on"],
    "home.switch.turn_off@1": ["off"],
    "home.fan.turn_on@1": ["on"],
    "home.fan.turn_off@1": ["off"],
    "home.cover.open@1": ["open"],
    "home.cover.close@1": ["closed"],
    "home.cover.stop@1": ["open", "closed", "stopped"],
    "home.climate.turn_off@1": ["off"],
    "home.vacuum.start@1": ["cleaning"],
    "home.vacuum.return_home@1": ["returning", "docked"]
  };
  const expectedStates = stateTargets[request.capability];
  if (expectedStates) return expectedStates.includes(resource.state);
  if (request.capability === "home.light.set_brightness@1") {
    const expectedPercent = Number(args.brightnessPercent);
    return approximatelyEqual(resource.attributes.brightness, Math.round(expectedPercent * 2.55), 3);
  }
  if (request.capability === "home.fan.set_percentage@1") {
    return approximatelyEqual(resource.attributes.percentage, Number(args.percentage));
  }
  if (request.capability === "home.climate.set_temperature@1") {
    return approximatelyEqual(resource.attributes.temperature, Number(args.temperature), 0.2);
  }
  return false;
}

export function mapXiaomiHomeAction(request: XiaomiHomeActionRequest): ActionMapping {
  const entityId = xiaomiHomeEntityId(request.resourceId);
  const args = request.arguments ?? {};
  const fixed: Record<string, { domain: string; service: string }> = {
    "home.light.turn_on@1": { domain: "light", service: "turn_on" },
    "home.light.turn_off@1": { domain: "light", service: "turn_off" },
    "home.switch.turn_on@1": { domain: "switch", service: "turn_on" },
    "home.switch.turn_off@1": { domain: "switch", service: "turn_off" },
    "home.fan.turn_on@1": { domain: "fan", service: "turn_on" },
    "home.fan.turn_off@1": { domain: "fan", service: "turn_off" },
    "home.cover.open@1": { domain: "cover", service: "open_cover" },
    "home.cover.close@1": { domain: "cover", service: "close_cover" },
    "home.cover.stop@1": { domain: "cover", service: "stop_cover" },
    "home.climate.turn_off@1": { domain: "climate", service: "turn_off" },
    "home.vacuum.start@1": { domain: "vacuum", service: "start" },
    "home.vacuum.return_home@1": { domain: "vacuum", service: "return_to_base" }
  };
  let mapping = fixed[request.capability];
  let data: Record<string, unknown> = { entity_id: entityId };
  if (request.capability === "home.light.set_brightness@1") {
    mapping = { domain: "light", service: "turn_on" };
    data.brightness_pct = finiteNumber(args.brightnessPercent, "brightnessPercent", 0, 100);
  } else if (request.capability === "home.fan.set_percentage@1") {
    mapping = { domain: "fan", service: "set_percentage" };
    data.percentage = finiteNumber(args.percentage, "percentage", 0, 100);
  } else if (request.capability === "home.climate.set_temperature@1") {
    mapping = { domain: "climate", service: "set_temperature" };
    data.temperature = finiteNumber(args.temperature, "temperature", 5, 35);
  }
  if (!mapping || mapping.domain !== entityId.split(".", 1)[0]) {
    throw new XiaomiHomeManagerApiError(403, "xiaomi_home_capability_rejected", "The requested capability is not allowed for this resource.");
  }
  return { ...mapping, data };
}

export class XiaomiHomeManagerApiClient {
  private readonly config: ResolvedXiaomiHomeManagerConfig;
  private readonly actionReceiptRoot: string;

  constructor(
    input: XiaomiHomeManagerConfigInput = {},
    private readonly fetchImpl: FetchLike = fetch,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.config = resolveXiaomiHomeManagerConfig(input);
    this.actionReceiptRoot = resolveActionReceiptRoot(input.runtimeDir);
  }

  private token(): string {
    const token = String(this.env[this.config.tokenEnv] || "").trim();
    if (!token) {
      throw new XiaomiHomeManagerApiError(503, "xiaomi_home_authorization_required", `Set ${this.config.tokenEnv} in the local RabiRoute runtime environment after Home Assistant authorization.`);
    }
    return token;
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}${pathname}`, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.token()}`,
          "content-type": "application/json",
          ...(init.headers ?? {})
        }
      });
      if (response.status >= 300 && response.status < 400) {
        throw new XiaomiHomeManagerApiError(502, "xiaomi_home_redirect_rejected", "Home Assistant redirects are not allowed.");
      }
      const text = await response.text();
      const body = text ? JSON.parse(text) as T : undefined as T;
      if (!response.ok) {
        throw new XiaomiHomeManagerApiError(response.status, "xiaomi_home_provider_error", `Home Assistant request failed with HTTP ${response.status}.`);
      }
      return body;
    } catch (error) {
      if (error instanceof XiaomiHomeManagerApiError) throw error;
      const code = error instanceof Error && error.name === "AbortError" ? "xiaomi_home_provider_timeout" : "xiaomi_home_provider_unreachable";
      throw new XiaomiHomeManagerApiError(503, code, "Home Assistant is unavailable.");
    } finally {
      clearTimeout(timeout);
    }
  }

  async getHealth(): Promise<Record<string, unknown>> {
    const tokenConfigured = Boolean(String(this.env[this.config.tokenEnv] || "").trim());
    if (!tokenConfigured) {
      return {
        status: "authorization_required",
        provider: "home_assistant",
        baseUrl: this.config.baseUrl,
        tokenEnv: this.config.tokenEnv,
        tokenConfigured: false,
        writeEnabled: this.config.writeEnabled
      };
    }
    try {
      await this.request<Record<string, unknown>>("/api/");
    } catch (error) {
      if (!(error instanceof XiaomiHomeManagerApiError)) throw error;
      return {
        status: error.status === 401 || error.status === 403
          ? "authorization_failed"
          : error.code === "xiaomi_home_provider_timeout"
            ? "timeout"
            : "unreachable",
        provider: "home_assistant",
        baseUrl: this.config.baseUrl,
        tokenEnv: this.config.tokenEnv,
        tokenConfigured: true,
        writeEnabled: this.config.writeEnabled,
        errorCode: error.code
      };
    }
    return {
      status: "ready",
      provider: "home_assistant",
      baseUrl: this.config.baseUrl,
      tokenEnv: this.config.tokenEnv,
      tokenConfigured: true,
      writeEnabled: this.config.writeEnabled
    };
  }

  async listResources(): Promise<XiaomiHomeResource[]> {
    const states = await this.request<HomeAssistantState[]>("/api/states");
    if (!Array.isArray(states)) throw new XiaomiHomeManagerApiError(502, "xiaomi_home_provider_invalid", "Home Assistant returned an invalid state list.");
    return states.map(normalizeHomeAssistantState).sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  }

  async getResource(resourceId: string): Promise<XiaomiHomeResource> {
    const entityId = xiaomiHomeEntityId(resourceId);
    const state = await this.request<HomeAssistantState>(`/api/states/${encodeURIComponent(entityId)}`);
    return normalizeHomeAssistantState(state);
  }

  async executeAction(request: XiaomiHomeActionRequest, idempotencyKey: string): Promise<XiaomiHomeActionReceipt> {
    const key = idempotencyKey.trim();
    if (!key || key.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
      throw new XiaomiHomeManagerApiError(400, "xiaomi_home_idempotency_required", "A valid Idempotency-Key is required.");
    }
    const mapping = mapXiaomiHomeAction(request);
    const resourceId = xiaomiHomeResourceId(xiaomiHomeEntityId(request.resourceId));
    const expectedStateVersion = String(request.expectedStateVersion || "").trim();
    if (!expectedStateVersion) {
      throw new XiaomiHomeManagerApiError(400, "xiaomi_home_action_invalid", "expectedStateVersion is required.");
    }
    const payload = Object.freeze({
      // requestId is transport correlation; every effect-bearing action field is
      // bound below so changing intent cannot reuse a completed receipt.
      schemaVersion: 1,
      provider: "home_assistant",
      resourceId,
      capability: request.capability,
      arguments: request.arguments ?? {},
      service: Object.freeze({
        domain: mapping.domain,
        service: mapping.service,
        data: mapping.data
      }),
      expectedStateVersion,
      dryRun: request.dryRun === true,
      reason: String(request.reason || "")
    });
    const requestedAt = new Date().toISOString();
    const requestId = String(request.requestId || "").trim() || randomUUID();
    const actionReceipt = (
      status: XiaomiHomeActionReceipt["status"],
      beforeStateVersion: string,
      after?: XiaomiHomeResource,
      error?: string
    ): XiaomiHomeActionReceipt => ({
      requestId,
      idempotencyKey: key,
      resourceId,
      capability: request.capability,
      status,
      requestedAt,
      completedAt: new Date().toISOString(),
      beforeStateVersion,
      ...(after ? { afterStateVersion: after.stateVersion } : {}),
      provider: "home_assistant",
      ...(error ? { error } : {})
    });

    let outcome: DurableDeliveryOutcome<XiaomiHomeActionReceipt>;
    try {
      outcome = await executeDurableDelivery<XiaomiHomeActionReceipt>({
        rootDir: this.actionReceiptRoot,
        namespace: actionReceiptNamespace,
        deliveryId: key,
        payload,
        audit: Object.freeze({ provider: "home_assistant", resourceId, capability: request.capability }),
        recoverExistingUncertain: true,
        deliver: async () => {
          const before = await this.getResource(resourceId);
          if (before.stateVersion !== expectedStateVersion) {
            return actionReceipt("failed", before.stateVersion, undefined, stateVersionChangedReceiptError);
          }
          if (request.dryRun === true || !this.config.writeEnabled) {
            return actionReceipt("planned", before.stateVersion);
          }
          await this.request(`/api/services/${mapping.domain}/${mapping.service}`, {
            method: "POST",
            body: JSON.stringify(mapping.data)
          });
          let after = await this.getResource(resourceId);
          for (let attempt = 0; attempt < 3 && !xiaomiHomeActionSatisfied(request, after); attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 250));
            after = await this.getResource(resourceId);
          }
          const verified = xiaomiHomeActionSatisfied(request, after);
          return actionReceipt(
            verified ? "succeeded" : "uncertain",
            before.stateVersion,
            after,
            verified ? undefined : "Home Assistant accepted the service call, but the target state was not confirmed by read-back."
          );
        },
        retryableRejection: result => result.status === "failed"
          && result.error === stateVersionChangedReceiptError,
        recover: async () => {
          try {
            const after = await this.getResource(resourceId);
            if (after.stateVersion !== expectedStateVersion && xiaomiHomeActionSatisfied(request, after)) {
              return { state: "completed", result: actionReceipt("succeeded", expectedStateVersion, after) } as const;
            }
          } catch {
            // Recovery is deliberately read-only and exposes no provider or filesystem detail.
          }
          return {
            state: "uncertain",
            reason: "The earlier Home Assistant action result could not be confirmed; do not resend automatically."
          } as const;
        }
      });
    } catch (error) {
      if (error instanceof XiaomiHomeManagerApiError) throw error;
      if (typeof (error as NodeJS.ErrnoException | undefined)?.code !== "string") throw error;
      throw new XiaomiHomeManagerApiError(503, "xiaomi_home_idempotency_unavailable", "The Xiaomi Home action receipt store is unavailable.");
    }
    if (outcome.state === "completed") {
      if (outcome.result.status === "failed" && outcome.result.error === stateVersionChangedReceiptError) {
        throw new XiaomiHomeManagerApiError(412, "xiaomi_home_state_version_changed", "The resource state changed; read it again before acting.");
      }
      return outcome.result;
    }
    if (outcome.state === "conflict") {
      throw new XiaomiHomeManagerApiError(409, "xiaomi_home_idempotency_conflict", "Idempotency-Key was already used for another action payload.");
    }
    if (outcome.state === "in_progress") {
      throw new XiaomiHomeManagerApiError(409, "xiaomi_home_action_in_progress", "The action is already in progress; query or retry with the same Idempotency-Key.");
    }
    throw new XiaomiHomeManagerApiError(409, "xiaomi_home_action_uncertain", "The earlier action result is uncertain; do not resend it automatically.");
  }
}
