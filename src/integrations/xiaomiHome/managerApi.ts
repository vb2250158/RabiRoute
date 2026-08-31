import { createHash, randomUUID } from "node:crypto";

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

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isPrivateHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost"
    || value === "::1"
    || value.endsWith(".local")
    || value.startsWith("fc")
    || value.startsWith("fd")
    || value.startsWith("fe80:")
    || isPrivateIpv4(value);
}

export function resolveXiaomiHomeManagerConfig(input: XiaomiHomeManagerConfigInput = {}): ResolvedXiaomiHomeManagerConfig {
  const baseUrl = String(input.baseUrl || defaultBaseUrl).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new XiaomiHomeManagerApiError(500, "xiaomi_home_config_invalid", "Home Assistant baseUrl is invalid.");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new XiaomiHomeManagerApiError(500, "xiaomi_home_config_invalid", "Home Assistant baseUrl must use HTTP or HTTPS.");
  }
  if (input.allowPublicBaseUrl !== true && !isPrivateHost(parsed.hostname)) {
    throw new XiaomiHomeManagerApiError(500, "xiaomi_home_public_url_rejected", "Home Assistant baseUrl must be loopback, private LAN, or .local unless explicitly allowed.");
  }
  const tokenEnv = String(input.tokenEnv || defaultTokenEnv).trim();
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(tokenEnv)) {
    throw new XiaomiHomeManagerApiError(500, "xiaomi_home_config_invalid", "tokenEnv must be an uppercase environment variable name.");
  }
  const requestTimeoutMs = Number(input.requestTimeoutMs ?? 5000);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 250 || requestTimeoutMs > 30000) {
    throw new XiaomiHomeManagerApiError(500, "xiaomi_home_config_invalid", "requestTimeoutMs must be between 250 and 30000.");
  }
  return { baseUrl, tokenEnv, requestTimeoutMs, writeEnabled: input.writeEnabled === true };
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
  private readonly receipts = new Map<string, XiaomiHomeActionReceipt>();

  constructor(
    input: XiaomiHomeManagerConfigInput = {},
    private readonly fetchImpl: FetchLike = fetch,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.config = resolveXiaomiHomeManagerConfig(input);
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
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.token()}`,
          "content-type": "application/json",
          ...(init.headers ?? {})
        }
      });
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
    if (!key || key.length > 160) throw new XiaomiHomeManagerApiError(400, "xiaomi_home_idempotency_required", "A valid Idempotency-Key is required.");
    const existing = this.receipts.get(key);
    if (existing) {
      if (existing.resourceId !== request.resourceId || existing.capability !== request.capability) {
        throw new XiaomiHomeManagerApiError(409, "xiaomi_home_idempotency_conflict", "Idempotency-Key was already used for another action.");
      }
      return existing;
    }
    const before = await this.getResource(request.resourceId);
    if (before.stateVersion !== request.expectedStateVersion) {
      throw new XiaomiHomeManagerApiError(412, "xiaomi_home_state_version_changed", "The resource state changed; read it again before acting.");
    }
    const mapping = mapXiaomiHomeAction(request);
    const requestedAt = new Date().toISOString();
    if (request.dryRun === true || !this.config.writeEnabled) {
      const receipt: XiaomiHomeActionReceipt = {
        requestId: request.requestId || randomUUID(), idempotencyKey: key,
        resourceId: request.resourceId, capability: request.capability,
        status: "planned", requestedAt, completedAt: new Date().toISOString(),
        beforeStateVersion: before.stateVersion, provider: "home_assistant"
      };
      this.receipts.set(key, receipt);
      return receipt;
    }
    await this.request(`/api/services/${mapping.domain}/${mapping.service}`, {
      method: "POST",
      body: JSON.stringify(mapping.data)
    });
    let after = await this.getResource(request.resourceId);
    for (let attempt = 0; attempt < 3 && !xiaomiHomeActionSatisfied(request, after); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 250));
      after = await this.getResource(request.resourceId);
    }
    const verified = xiaomiHomeActionSatisfied(request, after);
    const receipt: XiaomiHomeActionReceipt = {
      requestId: request.requestId || randomUUID(), idempotencyKey: key,
      resourceId: request.resourceId, capability: request.capability,
      status: verified ? "succeeded" : "uncertain", requestedAt, completedAt: new Date().toISOString(),
      beforeStateVersion: before.stateVersion, afterStateVersion: after.stateVersion,
      provider: "home_assistant",
      error: verified ? undefined : "Home Assistant accepted the service call, but the target state was not confirmed by read-back."
    };
    this.receipts.set(key, receipt);
    return receipt;
  }
}
