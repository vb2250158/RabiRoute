import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  YeYuGamerCapability,
  YeYuGamerCommandReceipt,
  YeYuGamerDispatchOptions,
  YeYuGamerHealth,
  YeYuGamerJsonObject,
  YeYuGamerMeta,
  YeYuGamerPage,
  YeYuGamerSnapshot,
  YeYuGamerWorkItemCreate,
  YeYuGamerWorkItemKind
} from "./contracts.js";

export type {
  YeYuGamerCapability,
  YeYuGamerCommandReceipt,
  YeYuGamerDispatchOptions,
  YeYuGamerHealth,
  YeYuGamerMeta,
  YeYuGamerPage,
  YeYuGamerSnapshot,
  YeYuGamerWorkItemCreate,
  YeYuGamerWorkItemKind
} from "./contracts.js";

export const YEYU_GAMER_MANAGER_BASE_URL = "http://127.0.0.1:8877/api/v1" as const;
export const YEYU_GAMER_RABIROUTE_ACTOR = "rabiroute" as const;

export type YeYuGamerManagerConfigInput = {
  baseUrl?: string;
  runtimeDir?: string;
  requestTimeoutMs?: number;
};

export type YeYuGamerManagerConfig = Readonly<{
  baseUrl: typeof YEYU_GAMER_MANAGER_BASE_URL;
  runtimeDir: string;
  requestTimeoutMs: number;
}>;

export const yeyuGamerManagerConfigSchema = Object.freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/vb2250158/RabiRoute/examples/schemas/yeyu-gamer-manager-config.schema.json",
  title: "RabiRoute YeYu Gamer Manager integration",
  type: "object",
  additionalProperties: false,
  properties: {
    baseUrl: {
      const: YEYU_GAMER_MANAGER_BASE_URL,
      default: YEYU_GAMER_MANAGER_BASE_URL,
      description: "Fixed loopback YeYu Gamer Manager API v1 origin."
    },
    runtimeDir: {
      type: "string",
      minLength: 1,
      description: "Optional absolute local YeYu Gamer runtime directory. Network paths are rejected."
    },
    requestTimeoutMs: {
      type: "integer",
      minimum: 250,
      maximum: 30000,
      default: 3000
    }
  }
} as const);

export class YeYuGamerManagerApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "YeYuGamerManagerApiError";
    this.status = status;
    this.code = code;
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ReadFileLike = (filePath: string, encoding: BufferEncoding) => Promise<string>;

export type YeYuGamerManagerApiDependencies = {
  fetch?: FetchLike;
  readFile?: ReadFileLike;
};

export type YeYuGamerManagerConfigEnvironment = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

const workItemKinds = new Set<YeYuGamerWorkItemKind>([
  "run_game",
  "run_batch",
  "diagnose_game",
  "cancel_run",
  "observation",
  "incident_review",
  "evidence_review",
  "repair_validation"
]);
const receiptStates = new Set(["accepted", "running", "succeeded", "rejected", "failed"]);
const healthStates = new Set(["ok", "degraded", "error"]);
const capabilityRisks = new Set([
  "observe_only",
  "controlled_write",
  "routine_action",
  "approval_required",
  "forbidden"
]);

function localRuntimeDir(environment: YeYuGamerManagerConfigEnvironment): string {
  const platform = environment.platform ?? process.platform;
  const env = environment.env ?? process.env;
  if (platform === "win32") {
    const programData = env.ProgramData?.trim() || env.PROGRAMDATA?.trim() || "C:\\ProgramData";
    return path.win32.resolve(programData, "YeYuGamer", "runtime");
  }
  const stateRoot = env.XDG_STATE_HOME?.trim()
    || path.posix.join(environment.homeDir ?? os.homedir(), ".local", "state");
  return path.posix.resolve(stateRoot, "yeyu-gamer", "runtime");
}

function isNetworkRuntimePath(value: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return /^\\\\|^\/\//.test(value);
  return value.startsWith("//");
}

export function normalizeYeYuGamerManagerConfig(
  input: YeYuGamerManagerConfigInput | undefined,
  environment: YeYuGamerManagerConfigEnvironment = {}
): YeYuGamerManagerConfig {
  const platform = environment.platform ?? process.platform;
  const baseUrl = String(input?.baseUrl || YEYU_GAMER_MANAGER_BASE_URL).trim().replace(/\/+$/, "");
  if (baseUrl !== YEYU_GAMER_MANAGER_BASE_URL) {
    throw new YeYuGamerManagerApiError(
      400,
      "yeyu_gamer_base_url_rejected",
      `YeYu Gamer Manager must use ${YEYU_GAMER_MANAGER_BASE_URL}.`
    );
  }
  const rawRuntimeDir = String(input?.runtimeDir || localRuntimeDir(environment)).trim();
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!rawRuntimeDir || !pathApi.isAbsolute(rawRuntimeDir) || isNetworkRuntimePath(rawRuntimeDir, platform)) {
    throw new YeYuGamerManagerApiError(
      400,
      "yeyu_gamer_runtime_dir_rejected",
      "YeYu Gamer runtimeDir must be an absolute local path."
    );
  }
  const requestTimeoutMs = input?.requestTimeoutMs ?? 3000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 250 || requestTimeoutMs > 30000) {
    throw new YeYuGamerManagerApiError(
      400,
      "yeyu_gamer_timeout_rejected",
      "YeYu Gamer requestTimeoutMs must be an integer from 250 through 30000."
    );
  }
  return Object.freeze({
    baseUrl: YEYU_GAMER_MANAGER_BASE_URL,
    runtimeDir: pathApi.resolve(rawRuntimeDir),
    requestTimeoutMs
  });
}

function objectValue(value: unknown, label: string): YeYuGamerJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", `${label} is not an object.`);
  }
  return value as YeYuGamerJsonObject;
}

function stringValue(object: YeYuGamerJsonObject, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", `${label}.${key} is not a string.`);
  }
  return value;
}

function booleanValue(object: YeYuGamerJsonObject, key: string, label: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") {
    throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", `${label}.${key} is not a boolean.`);
  }
  return value;
}

function numberValue(object: YeYuGamerJsonObject, key: string, label: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", `${label}.${key} is not a number.`);
  }
  return value;
}

function arrayValue(object: YeYuGamerJsonObject, key: string, label: string): unknown[] {
  const value = object[key];
  if (!Array.isArray(value)) {
    throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", `${label}.${key} is not an array.`);
  }
  return value;
}

function parseMeta(value: unknown): YeYuGamerMeta {
  const object = objectValue(value, "meta");
  stringValue(object, "name", "meta");
  stringValue(object, "version", "meta");
  stringValue(object, "apiVersion", "meta");
  stringValue(object, "managerId", "meta");
  stringValue(object, "startedAt", "meta");
  stringValue(object, "hostPolicy", "meta");
  booleanValue(object, "webGuiAvailable", "meta");
  booleanValue(object, "legacyExecutionEnabled", "meta");
  return object as YeYuGamerMeta;
}

function parseHealth(value: unknown): YeYuGamerHealth {
  const object = objectValue(value, "health");
  const status = stringValue(object, "status", "health");
  if (!healthStates.has(status)) {
    throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", "health.status is invalid.");
  }
  stringValue(object, "manager", "health");
  stringValue(object, "storage", "health");
  stringValue(object, "eventStream", "health");
  stringValue(object, "checkedAt", "health");
  const checks = objectValue(object.checks, "health.checks");
  for (const [name, checkValue] of Object.entries(checks)) {
    const check = objectValue(checkValue, `health.checks.${name}`);
    if (!healthStates.has(stringValue(check, "status", `health.checks.${name}`))) {
      throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", `health.checks.${name}.status is invalid.`);
    }
    stringValue(check, "detail", `health.checks.${name}`);
  }
  return object as YeYuGamerHealth;
}

function parseSnapshot(value: unknown): YeYuGamerSnapshot {
  const object = objectValue(value, "snapshot");
  const stateVersion = numberValue(object, "stateVersion", "snapshot");
  if (!Number.isInteger(stateVersion) || stateVersion < 0) {
    throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", "snapshot.stateVersion is invalid.");
  }
  stringValue(object, "generatedAt", "snapshot");
  stringValue(object, "eventCursor", "snapshot");
  objectValue(object.manager, "snapshot.manager");
  objectValue(object.health, "snapshot.health");
  stringValue(object, "gameDay", "snapshot");
  arrayValue(object, "recentBatches", "snapshot").forEach((item, index) => objectValue(item, `snapshot.recentBatches[${index}]`));
  arrayValue(object, "games", "snapshot").forEach((item, index) => objectValue(item, `snapshot.games[${index}]`));
  objectValue(object.counters, "snapshot.counters");
  if (object.activeBatch !== null && object.activeBatch !== undefined) objectValue(object.activeBatch, "snapshot.activeBatch");
  return object as YeYuGamerSnapshot;
}

function parseCapability(value: unknown, index: number): YeYuGamerCapability {
  const label = `capabilities.items[${index}]`;
  const object = objectValue(value, label);
  stringValue(object, "capabilityId", label);
  stringValue(object, "version", label);
  stringValue(object, "description", label);
  stringValue(object, "displayName", label);
  if (!capabilityRisks.has(stringValue(object, "risk", label))) {
    throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", `${label}.risk is invalid.`);
  }
  booleanValue(object, "enabled", label);
  booleanValue(object, "requiresIdempotencyKey", label);
  objectValue(object.inputSchema, `${label}.inputSchema`);
  objectValue(object.outputSchema, `${label}.outputSchema`);
  objectValue(object.policy, `${label}.policy`);
  arrayValue(object, "preEvidence", label);
  arrayValue(object, "postEvidence", label);
  stringValue(object, "implementationHash", label);
  return object as YeYuGamerCapability;
}

function parseCapabilities(value: unknown): YeYuGamerPage<YeYuGamerCapability> {
  const object = objectValue(value, "capabilities");
  const total = numberValue(object, "total", "capabilities");
  if (!Number.isInteger(total) || total < 0) {
    throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", "capabilities.total is invalid.");
  }
  const items = arrayValue(object, "items", "capabilities").map(parseCapability);
  return { items, total };
}

function parseReceipt(value: unknown): YeYuGamerCommandReceipt {
  const object = objectValue(value, "receipt");
  stringValue(object, "commandId", "receipt");
  stringValue(object, "idempotencyKey", "receipt");
  const acceptedStateVersion = numberValue(object, "acceptedStateVersion", "receipt");
  if (!Number.isInteger(acceptedStateVersion) || acceptedStateVersion < 0) {
    throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", "receipt.acceptedStateVersion is invalid.");
  }
  if (!receiptStates.has(stringValue(object, "state", "receipt"))) {
    throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", "receipt.state is invalid.");
  }
  stringValue(object, "message", "receipt");
  objectValue(object.result, "receipt.result");
  stringValue(object, "submittedAt", "receipt");
  booleanValue(object, "replayed", "receipt");
  for (const key of ["requestId", "statusUrl", "completedAt"] as const) {
    if (object[key] !== null && object[key] !== undefined && typeof object[key] !== "string") {
      throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", `receipt.${key} is invalid.`);
    }
  }
  return object as YeYuGamerCommandReceipt;
}

function safeProblem(value: unknown): { code: string; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { code: "yeyu_gamer_http_error", message: "YeYu Gamer Manager rejected the request." };
  }
  const object = value as YeYuGamerJsonObject;
  const nested = object.error && typeof object.error === "object" && !Array.isArray(object.error)
    ? object.error as YeYuGamerJsonObject
    : object;
  const code = typeof nested.code === "string" && /^[a-z0-9_-]{1,80}$/i.test(nested.code)
    ? nested.code
    : "yeyu_gamer_http_error";
  // Never relay a remote free-form error body. It may contain a credential,
  // filesystem path, or legacy implementation detail that is outside this
  // bounded integration's public contract.
  return { code, message: "YeYu Gamer Manager rejected the request." };
}

function visibleAscii(value: string, maxLength: number): boolean {
  return value.length > 0
    && value.length <= maxLength
    && [...value].every(character => character.charCodeAt(0) >= 33 && character.charCodeAt(0) <= 126);
}

function opaqueId(value: string, maxLength: number): boolean {
  return value.length > 0
    && value.length <= maxLength
    && !value.includes("/")
    && !value.includes("\\")
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function normalizeWorkItem(input: YeYuGamerWorkItemCreate): YeYuGamerJsonObject {
  if (!workItemKinds.has(input.kind)) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "Unsupported YeYu Gamer work item kind.");
  }
  if (input.gameId !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(input.gameId)) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "gameId must be an opaque Manager GameId.");
  }
  if ((input.kind === "run_game" || input.kind === "diagnose_game") && !input.gameId) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", `${input.kind} requires gameId.`);
  }
  if (input.cadence !== undefined && input.cadence !== "daily" && input.cadence !== "weekly") {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "cadence must be daily or weekly.");
  }
  if (input.runId !== undefined && !opaqueId(input.runId, 80)) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "runId must be an opaque Manager id.");
  }
  if (input.kind === "cancel_run" && !input.runId) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "cancel_run requires runId.");
  }
  const note = input.note ?? "";
  if (typeof note !== "string" || note.length > 500) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "note must not exceed 500 characters.");
  }
  const artifactRefs = input.artifactRefs ?? [];
  const allowedCapabilityRefs = input.allowedCapabilityRefs ?? [];
  if (artifactRefs.length > 50 || artifactRefs.some(value => !opaqueId(value, 160))) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "artifactRefs must contain at most 50 opaque ids.");
  }
  if (allowedCapabilityRefs.length > 50 || allowedCapabilityRefs.some(value => !opaqueId(value, 100))) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "allowedCapabilityRefs must contain at most 50 capability ids.");
  }
  return {
    kind: input.kind,
    ...(input.gameId ? { gameId: input.gameId } : {}),
    ...(input.cadence ? { cadence: input.cadence } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    mode: "plan",
    requestedBy: YEYU_GAMER_RABIROUTE_ACTOR,
    note,
    artifactRefs,
    allowedCapabilityRefs
  };
}

export class YeYuGamerManagerApiClient {
  readonly config: YeYuGamerManagerConfig;
  readonly #fetch: FetchLike;
  readonly #readFile: ReadFileLike;

  constructor(
    input: YeYuGamerManagerConfigInput | undefined,
    dependencies: YeYuGamerManagerApiDependencies = {},
    environment: YeYuGamerManagerConfigEnvironment = {}
  ) {
    this.config = normalizeYeYuGamerManagerConfig(input, environment);
    this.#fetch = dependencies.fetch ?? fetch;
    this.#readFile = dependencies.readFile ?? ((filePath, encoding) => fs.readFile(filePath, encoding));
  }

  async getHealth(): Promise<YeYuGamerHealth> {
    return this.#get("/health", parseHealth);
  }

  async getMeta(): Promise<YeYuGamerMeta> {
    return this.#get("/meta", parseMeta);
  }

  async getSnapshot(): Promise<YeYuGamerSnapshot> {
    return this.#get("/snapshot", parseSnapshot);
  }

  async getCapabilities(): Promise<YeYuGamerPage<YeYuGamerCapability>> {
    return this.#get("/capabilities", parseCapabilities);
  }

  async createWorkItem(
    input: YeYuGamerWorkItemCreate,
    options: YeYuGamerDispatchOptions
  ): Promise<YeYuGamerCommandReceipt> {
    if (!visibleAscii(options.idempotencyKey, 128)) {
      throw new YeYuGamerManagerApiError(400, "yeyu_gamer_idempotency_key_rejected", "idempotencyKey must contain visible ASCII and be at most 128 characters.");
    }
    if (!Number.isInteger(options.expectedStateVersion) || options.expectedStateVersion < 0) {
      throw new YeYuGamerManagerApiError(400, "yeyu_gamer_state_version_rejected", "expectedStateVersion must be a non-negative integer from a fresh snapshot.");
    }
    if (options.requestId !== undefined && !visibleAscii(options.requestId, 128)) {
      throw new YeYuGamerManagerApiError(400, "yeyu_gamer_request_id_rejected", "requestId must contain visible ASCII and be at most 128 characters.");
    }
    const token = await this.#readCredential();
    return this.#request("/agent/work-items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-YeYu-Gamer-Actor": YEYU_GAMER_RABIROUTE_ACTOR,
        "Idempotency-Key": options.idempotencyKey,
        "X-Expected-State-Version": String(options.expectedStateVersion),
        ...(options.requestId ? { "X-Request-Id": options.requestId } : {})
      },
      body: JSON.stringify(normalizeWorkItem(input))
    }, parseReceipt);
  }

  async #get<T>(resource: "/health" | "/meta" | "/snapshot" | "/capabilities", parse: (value: unknown) => T): Promise<T> {
    const protectedView = resource === "/snapshot" || resource === "/capabilities";
    const headers: Record<string, string> = {};
    if (protectedView) {
      const token = await this.#readCredential();
      headers.Authorization = `Bearer ${token}`;
      headers["X-YeYu-Gamer-Actor"] = YEYU_GAMER_RABIROUTE_ACTOR;
    }
    return this.#request(resource, { method: "GET", headers }, parse);
  }

  async #readCredential(): Promise<string> {
    const credentialPath = path.join(this.config.runtimeDir, "secrets", "actors", "rabiroute.token");
    let token = "";
    try {
      token = (await this.#readFile(credentialPath, "ascii")).trim();
    } catch {
      throw new YeYuGamerManagerApiError(503, "yeyu_gamer_credential_unavailable", "The YeYu Gamer rabiroute credential is unavailable.");
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
      throw new YeYuGamerManagerApiError(503, "yeyu_gamer_credential_invalid", "The YeYu Gamer rabiroute credential is invalid.");
    }
    return token;
  }

  async #request<T>(resource: string, init: RequestInit, parse: (value: unknown) => T): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.#fetch(`${this.config.baseUrl}${resource}`, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(init.headers ?? {})
        }
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (controller.signal.aborted) {
          throw new YeYuGamerManagerApiError(503, "yeyu_gamer_unreachable", "YeYu Gamer Manager is unavailable on the fixed loopback endpoint.");
        }
        throw new YeYuGamerManagerApiError(502, "yeyu_gamer_invalid_json", "YeYu Gamer Manager returned invalid JSON.");
      }
      if (!response.ok) {
        const problem = safeProblem(body);
        throw new YeYuGamerManagerApiError(response.status, problem.code, problem.message);
      }
      return parse(body);
    } catch (error) {
      if (error instanceof YeYuGamerManagerApiError) throw error;
      throw new YeYuGamerManagerApiError(503, "yeyu_gamer_unreachable", "YeYu Gamer Manager is unavailable on the fixed loopback endpoint.");
    } finally {
      clearTimeout(timer);
    }
  }
}
