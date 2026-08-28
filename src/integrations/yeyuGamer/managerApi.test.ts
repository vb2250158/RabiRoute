import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  YEYU_GAMER_MANAGER_BASE_URL,
  YeYuGamerManagerApiClient,
  YeYuGamerManagerApiError,
  normalizeYeYuGamerManagerConfig,
  yeyuGamerManagerConfigSchema
} from "./managerApi.js";

const health = {
  status: "ok",
  manager: "ok",
  storage: "ok",
  eventStream: "ok",
  checkedAt: "2026-08-27T00:00:00.000Z",
  checks: {}
};
const meta = {
  name: "YeYu Gamer Manager",
  version: "0.1.0",
  apiVersion: "v1",
  managerId: "manager-test",
  startedAt: "2026-08-27T00:00:00.000Z",
  hostPolicy: "loopback-only",
  webGuiAvailable: true,
  legacyExecutionEnabled: false
};
const snapshot = {
  stateVersion: 7,
  generatedAt: "2026-08-27T00:00:00.000Z",
  eventCursor: "event-7",
  manager: {},
  health: {},
  gameDay: "2026-08-27",
  activeBatch: null,
  recentBatches: [],
  games: [],
  counters: {}
};
const capabilities = {
  items: [{
    capabilityId: "game.run.request",
    version: "1.0",
    description: "Create a controlled request.",
    displayName: "Run request",
    risk: "routine_action",
    enabled: true,
    requiresIdempotencyKey: true,
    inputSchema: {},
    outputSchema: {},
    policy: {},
    preEvidence: [],
    postEvidence: [],
    implementationHash: "test"
  }],
  total: 1
};
const receipt = {
  commandId: "work-1",
  idempotencyKey: "dispatch-1",
  requestId: "request-1",
  statusUrl: "/api/v1/agent/work-items/work-1",
  acceptedStateVersion: 8,
  state: "accepted",
  message: "Agent work item recorded; no external action executed.",
  result: { workItem: { workItemId: "work-1" } },
  submittedAt: "2026-08-27T00:00:00.000Z",
  completedAt: "2026-08-27T00:00:00.000Z",
  replayed: false
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("YeYu Gamer config fixes the loopback API/runtime contract", () => {
  const config = normalizeYeYuGamerManagerConfig(undefined, {
    platform: "win32",
    env: { ProgramData: "C:\\ProgramData" }
  });
  assert.equal(config.baseUrl, YEYU_GAMER_MANAGER_BASE_URL);
  assert.equal(config.runtimeDir, "C:\\ProgramData\\YeYuGamer\\runtime");
  assert.equal(config.requestTimeoutMs, 3000);

  assert.throws(
    () => normalizeYeYuGamerManagerConfig({ baseUrl: "http://localhost:8877/api/v1" }),
    (error: unknown) => error instanceof YeYuGamerManagerApiError
      && error.code === "yeyu_gamer_base_url_rejected"
  );
  assert.throws(
    () => normalizeYeYuGamerManagerConfig({ runtimeDir: "\\\\server\\share\\runtime" }, { platform: "win32" }),
    (error: unknown) => error instanceof YeYuGamerManagerApiError
      && error.code === "yeyu_gamer_runtime_dir_rejected"
  );
});

test("published JSON schema matches the runtime config schema", async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const schemaPath = path.join(projectRoot, "examples", "schemas", "yeyu-gamer-manager-config.schema.json");
  const published = JSON.parse(await fs.readFile(schemaPath, "utf8")) as unknown;
  assert.deepEqual(published, yeyuGamerManagerConfigSchema);

  const pluginManifestPath = path.join(
    projectRoot,
    "plugins",
    "builtin",
    "io.rabiroute.manager.yeyu-gamer",
    "1.0.0",
    "rabi.plugin.json"
  );
  const pluginManifest = JSON.parse(await fs.readFile(pluginManifestPath, "utf8")) as { configSchema?: unknown };
  assert.deepEqual(pluginManifest.configSchema, yeyuGamerManagerConfigSchema);

  const profilePath = path.join(projectRoot, "plugins", "profiles", "desktop.json");
  const profile = JSON.parse(await fs.readFile(profilePath, "utf8")) as {
    instances?: Array<{ package?: string; enabled?: boolean; config?: { baseUrl?: string; requestTimeoutMs?: number } }>;
  };
  const plugin = profile.instances?.find(instance => instance.package === "io.rabiroute.manager.yeyu-gamer");
  assert.ok(plugin);
  assert.equal(plugin.enabled, false);
  const normalized = normalizeYeYuGamerManagerConfig(plugin.config, {
    platform: "win32",
    env: { ProgramData: "C:\\ProgramData" }
  });
  assert.equal(normalized.baseUrl, YEYU_GAMER_MANAGER_BASE_URL);
  assert.equal(normalized.requestTimeoutMs, 3000);
});

test("typed GET client authenticates protected Manager views with the rabiroute credential", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const byUrl: Record<string, unknown> = { health, meta, snapshot, capabilities };
  const client = new YeYuGamerManagerApiClient({}, {
    readFile: async () => "T".repeat(48),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      const resource = url.split("/").at(-1) ?? "";
      return jsonResponse(byUrl[resource]);
    }
  });

  assert.equal((await client.getHealth()).status, "ok");
  assert.equal((await client.getMeta()).apiVersion, "v1");
  assert.equal((await client.getSnapshot()).stateVersion, 7);
  assert.equal((await client.getCapabilities()).total, 1);
  assert.deepEqual(requests.map(request => request.url), [
    `${YEYU_GAMER_MANAGER_BASE_URL}/health`,
    `${YEYU_GAMER_MANAGER_BASE_URL}/meta`,
    `${YEYU_GAMER_MANAGER_BASE_URL}/snapshot`,
    `${YEYU_GAMER_MANAGER_BASE_URL}/capabilities`
  ]);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.init?.method, "GET");
    const headers = new Headers(request.init?.headers);
    const protectedView = index >= 2;
    assert.equal(headers.has("Authorization"), protectedView);
    assert.equal(headers.get("X-YeYu-Gamer-Actor"), protectedView ? "rabiroute" : null);
  }
});

test("work item dispatch reads rabiroute.token and can create only a plan record", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-yeyu-gamer-"));
  const credentialDir = path.join(runtimeDir, "secrets", "actors");
  await fs.mkdir(credentialDir, { recursive: true });
  await fs.writeFile(path.join(credentialDir, "rabiroute.token"), `${"T".repeat(48)}\n`, "ascii");
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const client = new YeYuGamerManagerApiClient({ runtimeDir }, {
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse(receipt, 202);
    }
  });

  const result = await client.createWorkItem({
    kind: "run_game",
    gameId: "ZZZ",
    cadence: "daily",
    note: "Create a reviewable daily work item."
  }, {
    idempotencyKey: "dispatch-1",
    expectedStateVersion: 7,
    requestId: "request-1"
  });
  assert.equal(result.commandId, "work-1");
  assert.equal(capturedUrl, `${YEYU_GAMER_MANAGER_BASE_URL}/agent/work-items`);
  assert.equal(capturedInit?.method, "POST");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("X-YeYu-Gamer-Actor"), "rabiroute");
  assert.equal(headers.get("Idempotency-Key"), "dispatch-1");
  assert.equal(headers.get("X-Expected-State-Version"), "7");
  assert.equal(headers.get("Authorization")?.startsWith("Bearer "), true);
  assert.equal(headers.get("Authorization")?.length, "Bearer ".length + 48);
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    kind: "run_game",
    gameId: "ZZZ",
    cadence: "daily",
    mode: "plan",
    requestedBy: "rabiroute",
    note: "Create a reviewable daily work item.",
    artifactRefs: [],
    allowedCapabilityRefs: []
  });
});

test("client exposes no claim, decision, capability invocation, path or shell facade", () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(YeYuGamerManagerApiClient.prototype).sort(),
    ["constructor", "createWorkItem", "getCapabilities", "getHealth", "getMeta", "getSnapshot"].sort()
  );
});

test("failed credential state fails closed without making a Manager request", async () => {
  let requests = 0;
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-yeyu-gamer-missing-"));
  const client = new YeYuGamerManagerApiClient({ runtimeDir }, {
    fetch: async () => {
      requests += 1;
      return jsonResponse(receipt, 202);
    }
  });
  await assert.rejects(
    client.createWorkItem({ kind: "observation" }, { idempotencyKey: "missing-token", expectedStateVersion: 0 }),
    (error: unknown) => error instanceof YeYuGamerManagerApiError
      && error.code === "yeyu_gamer_credential_unavailable"
      && !error.message.includes(runtimeDir)
  );
  assert.equal(requests, 0);
});

test("remote error bodies cannot leak credential or filesystem details", async () => {
  const secret = "S".repeat(48);
  const client = new YeYuGamerManagerApiClient({ runtimeDir: "C:\\ProgramData\\YeYuGamer\\runtime" }, {
    readFile: async () => secret,
    fetch: async () => jsonResponse({
      error: {
        code: "actor_scope_denied",
        detail: `Bearer ${secret} from C:\\ProgramData\\YeYuGamer\\runtime`
      }
    }, 403)
  }, { platform: "win32" });

  await assert.rejects(
    client.createWorkItem({ kind: "observation" }, { idempotencyKey: "redacted-error", expectedStateVersion: 0 }),
    (error: unknown) => error instanceof YeYuGamerManagerApiError
      && error.status === 403
      && error.code === "actor_scope_denied"
      && error.message === "YeYu Gamer Manager rejected the request."
      && !error.message.includes(secret)
      && !error.message.includes("ProgramData")
  );
});

test("work item input refuses execution-shaped or path-shaped identifiers", async () => {
  const client = new YeYuGamerManagerApiClient({ runtimeDir: "C:\\ProgramData\\YeYuGamer\\runtime" }, {
    readFile: async () => "T".repeat(48),
    fetch: async () => jsonResponse(receipt, 202)
  }, { platform: "win32" });
  await assert.rejects(
    client.createWorkItem({ kind: "run_game", gameId: "..\\unsafe" }, { idempotencyKey: "bad-game", expectedStateVersion: 0 }),
    (error: unknown) => error instanceof YeYuGamerManagerApiError
      && error.code === "yeyu_gamer_work_item_rejected"
  );
  await assert.rejects(
    client.createWorkItem({ kind: "cancel_run", runId: "C:\\run.json" }, { idempotencyKey: "bad-run", expectedStateVersion: 0 }),
    (error: unknown) => error instanceof YeYuGamerManagerApiError
      && error.code === "yeyu_gamer_work_item_rejected"
  );
});
