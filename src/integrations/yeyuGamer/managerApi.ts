import { getTimeoutMs } from "../../shared/timeoutSettings.js";
import fs from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { YEYU_MANAGER_RESPONSE_SCHEMAS, YEYU_WORK_ITEM_KINDS, YEYU_WORK_ITEM_LIMITS } from "./managerSchemas.js";
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

const workItemKinds = new Set<YeYuGamerWorkItemKind>(YEYU_WORK_ITEM_KINDS);

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
  const requestTimeoutMs = input?.requestTimeoutMs ?? getTimeoutMs("backend.integrations.yeyuGamer.managerApi.normalizeYeYuGamerManagerConfig.requestTimeoutMs", 3000);
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

const responseAjv = new Ajv2020({ allErrors: false, strict: true });
const responseValidators = Object.fromEntries(Object.entries(YEYU_MANAGER_RESPONSE_SCHEMAS).map(([name, schema]) => [name, responseAjv.compile(schema)]));
function parseResponse<T>(name: keyof typeof YEYU_MANAGER_RESPONSE_SCHEMAS, value: unknown): T {
  if (!responseValidators[name]!(value)) throw new YeYuGamerManagerApiError(502, "yeyu_gamer_contract_mismatch", name + " does not match the native Manager contract.");
  return value as T;
}
const parseMeta = (value: unknown) => parseResponse<YeYuGamerMeta>("meta", value);
const parseHealth = (value: unknown) => parseResponse<YeYuGamerHealth>("health", value);
const parseSnapshot = (value: unknown) => parseResponse<YeYuGamerSnapshot>("snapshot", value);
const parseReceipt = (value: unknown) => parseResponse<YeYuGamerCommandReceipt>("receipt", value);
function parseCapabilities(value: unknown): YeYuGamerPage<YeYuGamerCapability> {
  const parsed = parseResponse<YeYuGamerPage<YeYuGamerCapability>>("capabilities", value);
  return { items: parsed.items, total: parsed.total };
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
  return typeof value === "string" && value.length > 0
    && value.length <= maxLength
    && [...value].every(character => character.charCodeAt(0) >= 33 && character.charCodeAt(0) <= 126);
}

function opaqueId(value: string, maxLength: number): boolean {
  return typeof value === "string" && value.length > 0
    && value.length <= maxLength
    && !value.includes("/")
    && !value.includes("\\")
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function normalizeWorkItem(input: YeYuGamerWorkItemCreate): YeYuGamerJsonObject {
  if (!input || typeof input !== "object" || Array.isArray(input) || !workItemKinds.has(input.kind)) {
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
  if (input.runId !== undefined && !opaqueId(input.runId, YEYU_WORK_ITEM_LIMITS.runId)) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "runId must be an opaque Manager id.");
  }
  if (input.kind === "cancel_run" && !input.runId) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "cancel_run requires runId.");
  }
  const note = input.note ?? "";
  if (typeof note !== "string" || note.length > YEYU_WORK_ITEM_LIMITS.note) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", `note must not exceed ${YEYU_WORK_ITEM_LIMITS.note} characters.`);
  }
  const artifactRefs = input.artifactRefs ?? [];
  const allowedCapabilityRefs = input.allowedCapabilityRefs ?? [];
  if (!Array.isArray(artifactRefs) || artifactRefs.length > YEYU_WORK_ITEM_LIMITS.refs || artifactRefs.some(value => !opaqueId(value, YEYU_WORK_ITEM_LIMITS.artifactRef))) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", `artifactRefs must contain at most ${YEYU_WORK_ITEM_LIMITS.refs} opaque ids.`);
  }
  if (!Array.isArray(allowedCapabilityRefs) || allowedCapabilityRefs.length > YEYU_WORK_ITEM_LIMITS.refs || allowedCapabilityRefs.some(value => !opaqueId(value, YEYU_WORK_ITEM_LIMITS.capabilityRef))) {
    throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", `allowedCapabilityRefs must contain at most ${YEYU_WORK_ITEM_LIMITS.refs} capability ids.`);
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

export type YeYuGamerRequestAccess = Readonly<{
  authorize(): void;
  beforeDispatch?(): void;
  signal?: AbortSignal;
}>;

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

  async getHealth(access?: YeYuGamerRequestAccess): Promise<YeYuGamerHealth> {
    return this.#get("/health", parseHealth, access);
  }

  async getMeta(access?: YeYuGamerRequestAccess): Promise<YeYuGamerMeta> {
    return this.#get("/meta", parseMeta, access);
  }

  async getSnapshot(access?: YeYuGamerRequestAccess): Promise<YeYuGamerSnapshot> {
    return this.#get("/snapshot", parseSnapshot, access);
  }

  async getCapabilities(access?: YeYuGamerRequestAccess): Promise<YeYuGamerPage<YeYuGamerCapability>> {
    return this.#get("/capabilities", parseCapabilities, access);
  }

  async createWorkItem(
    input: YeYuGamerWorkItemCreate,
    options: YeYuGamerDispatchOptions,
    access?: YeYuGamerRequestAccess
  ): Promise<YeYuGamerCommandReceipt> {
    if (!visibleAscii(options.idempotencyKey, YEYU_WORK_ITEM_LIMITS.key)) {
      throw new YeYuGamerManagerApiError(400, "yeyu_gamer_idempotency_key_rejected", "idempotencyKey must contain visible ASCII and be at most 128 characters.");
    }
    if (!Number.isInteger(options.expectedStateVersion) || options.expectedStateVersion < 0) {
      throw new YeYuGamerManagerApiError(400, "yeyu_gamer_state_version_rejected", "expectedStateVersion must be a non-negative integer from a fresh snapshot.");
    }
    if (options.requestId !== undefined && !visibleAscii(options.requestId, YEYU_WORK_ITEM_LIMITS.key)) {
      throw new YeYuGamerManagerApiError(400, "yeyu_gamer_request_id_rejected", "requestId must contain visible ASCII and be at most 128 characters.");
    }
    access?.authorize();
    const token = await this.#readCredential(access);
    access?.authorize();
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
    }, parseReceipt, access);
  }

  async #get<T>(resource: "/health" | "/meta" | "/snapshot" | "/capabilities", parse: (value: unknown) => T, access?: YeYuGamerRequestAccess): Promise<T> {
    access?.authorize();
    const protectedView = resource === "/snapshot" || resource === "/capabilities";
    const headers: Record<string, string> = {};
    if (protectedView) {
      const token = await this.#readCredential(access);
      access?.authorize();
      headers.Authorization = `Bearer ${token}`;
      headers["X-YeYu-Gamer-Actor"] = YEYU_GAMER_RABIROUTE_ACTOR;
    }
    return this.#request(resource, { method: "GET", headers }, parse, access);
  }

  async #readCredential(access?: YeYuGamerRequestAccess): Promise<string> {
    access?.authorize();
    access?.signal?.throwIfAborted();
    const credentialPath = path.join(this.config.runtimeDir, "secrets", "actors", "rabiroute.token");
    let token = "";
    try {
      token = (await this.#readFile(credentialPath, "ascii")).trim();
    } catch {
      access?.authorize();
      throw new YeYuGamerManagerApiError(503, "yeyu_gamer_credential_unavailable", "The YeYu Gamer rabiroute credential is unavailable.");
    }
    access?.authorize();
    access?.signal?.throwIfAborted();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
      throw new YeYuGamerManagerApiError(503, "yeyu_gamer_credential_invalid", "The YeYu Gamer rabiroute credential is invalid.");
    }
    return token;
  }

  async #request<T>(resource: string, init: RequestInit, parse: (value: unknown) => T, access?: YeYuGamerRequestAccess): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const signal = access?.signal ? AbortSignal.any([controller.signal, access.signal]) : controller.signal;
    try {
      access?.authorize();
      signal.throwIfAborted();
      access?.beforeDispatch?.();
      const response = await this.#fetch(`${this.config.baseUrl}${resource}`, {
        ...init,
        redirect: "error",
        signal,
        headers: {
          Accept: "application/json",
          ...(init.headers ?? {})
        }
      });
      access?.authorize();
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        access?.authorize();
        if (signal.aborted) {
          throw new YeYuGamerManagerApiError(503, "yeyu_gamer_unreachable", "YeYu Gamer Manager is unavailable on the fixed loopback endpoint.");
        }
        throw new YeYuGamerManagerApiError(502, "yeyu_gamer_invalid_json", "YeYu Gamer Manager returned invalid JSON.");
      }
      access?.authorize();
      if (!response.ok) {
        const problem = safeProblem(body);
        throw new YeYuGamerManagerApiError(response.status, problem.code, problem.message);
      }
      return parse(body);
    } catch (error) {
      access?.authorize();
      if (error instanceof YeYuGamerManagerApiError) throw error;
      throw new YeYuGamerManagerApiError(503, "yeyu_gamer_unreachable", "YeYu Gamer Manager is unavailable on the fixed loopback endpoint.");
    } finally {
      clearTimeout(timer);
    }
  }
}
