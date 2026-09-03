import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { XiaomiHomeArtifactStore } from "./artifactStore.js";
import { XiaomiHomeManagerApiError, normalizeHomeAssistantState } from "./managerApi.js";
import { XiaomiHomeCredentialStore } from "./credentials.js";
import { XiaomiHomeRuntimeController, XiaomiHomeSettingsStore } from "./settingsRuntime.js";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-xiaomi-settings-"));
}

const testProtector = {
  scheme: "test-protector-v1",
  protect: (plaintext: string) => Buffer.from(plaintext, "utf8").toString("base64"),
  unprotect: (value: string) => Buffer.from(value, "base64").toString("utf8")
};

test("Xiaomi Home settings switch atomically from Profile defaults to one runtime source", () => {
  const runtimeDir = temporaryDirectory();
  try {
    const store = new XiaomiHomeSettingsStore(runtimeDir, {
      baseUrl: "http://127.0.0.1:8123",
      runtimeDir,
      writeEnabled: false,
      eventMonitorEnabled: true
    });
    const profile = store.read();
    assert.equal(profile.source, "profile");
    assert.equal(profile.settings.writeEnabled, false);
    assert.equal(fs.existsSync(store.settingsPath), false);

    const saved = store.write({ ...profile.settings, eventMonitorEnabled: false }, profile.revision);
    assert.equal(saved.source, "runtime");
    assert.equal(saved.settings.eventMonitorEnabled, false);
    assert.deepEqual(store.read(), saved);
    const file = fs.readFileSync(store.settingsPath, "utf8");
    assert.doesNotMatch(file, /access_token|Bearer /i);

    assert.throws(
      () => store.write(saved.settings, profile.revision),
      (error: unknown) => error instanceof XiaomiHomeManagerApiError
        && error.status === 409
        && error.code === "xiaomi_home_settings_revision_changed"
    );
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("Xiaomi Home runtime hot-loads saved settings without requiring credentials", async () => {
  const runtimeDir = temporaryDirectory();
  try {
    const artifacts = new XiaomiHomeArtifactStore(runtimeDir);
    const store = new XiaomiHomeSettingsStore(runtimeDir, { eventMonitorEnabled: true });
    const controller = new XiaomiHomeRuntimeController(store, artifacts, {
      env: {},
      deliverEvent: async () => undefined
    });
    controller.start();
    const before = controller.settings();
    const saved = controller.update({
      ...before.settings,
      baseUrl: "https://192.168.10.5:8123",
      eventMonitorEnabled: false,
      writeEnabled: true
    }, before.revision);
    const health = await controller.health();
    assert.equal(saved.source, "runtime");
    assert.equal(health.status, "authorization_required");
    assert.equal(health.baseUrl, "https://192.168.10.5:8123");
    assert.equal(health.writeEnabled, true);
    assert.deepEqual(health.eventMonitor, {
      enabled: false,
      authorizationConfigured: false,
      running: false,
      connectionState: "disabled",
      deliveryMode: "significant",
      cameraMotionEntityCount: 0,
      agentRoleConfigured: true
    });
    controller.stop();
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("Xiaomi Home hot reload keeps the same durable action receipt runtime", async () => {
  const runtimeDir = temporaryDirectory();
  const providerState = {
    entity_id: "switch.desk",
    state: "off",
    attributes: { friendly_name: "desk" },
    last_updated: "2026-08-29T10:00:00Z"
  };
  const expected = normalizeHomeAssistantState(providerState);
  let reads = 0;
  let serviceCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).includes("/api/services/")) {
      serviceCalls += 1;
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    reads += 1;
    return new Response(JSON.stringify(providerState), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const artifacts = new XiaomiHomeArtifactStore(runtimeDir);
    const store = new XiaomiHomeSettingsStore(runtimeDir, {
      eventMonitorEnabled: false,
      writeEnabled: false
    });
    const credentials = new XiaomiHomeCredentialStore(runtimeDir, testProtector);
    credentials.write("secret", "http://127.0.0.1:8123", {});
    const controller = new XiaomiHomeRuntimeController(store, artifacts, {
      fetchImpl,
      deliverEvent: async () => undefined
    }, credentials);
    const request = {
      resourceId: expected.resourceId,
      capability: "home.switch.turn_on@1",
      expectedStateVersion: expected.stateVersion
    };
    const planned = await controller.client.executeAction(request, "hot-reload-key");
    assert.equal(planned.status, "planned");

    const current = controller.settings();
    controller.update({ ...current.settings, writeEnabled: true }, current.revision);
    const replay = await controller.client.executeAction(request, "hot-reload-key");
    assert.deepEqual(replay, planned);
    assert.equal(reads, 1);
    assert.equal(serviceCalls, 0);
    assert.equal(fs.existsSync(path.join(runtimeDir, "data", "xiaomi-home-actions")), true);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("Xiaomi Home authorization verifies before replacing the protected credential", async () => {
  const runtimeDir = temporaryDirectory();
  const presented: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization") || "";
    presented.push(authorization);
    if (authorization !== "Bearer valid-candidate") {
      return new Response(JSON.stringify({ message: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ location_name: "秋雨的家", version: "2026.8" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const artifacts = new XiaomiHomeArtifactStore(runtimeDir);
    const settings = new XiaomiHomeSettingsStore(runtimeDir, { eventMonitorEnabled: false });
    const credentials = new XiaomiHomeCredentialStore(runtimeDir, testProtector);
    const controller = new XiaomiHomeRuntimeController(settings, artifacts, {
      env: {},
      fetchImpl,
      deliverEvent: async () => undefined
    }, credentials);

    await assert.rejects(
      () => controller.authorize("invalid-candidate", "http://127.0.0.1:8123", controller.settings().revision),
      (error: unknown) => error instanceof XiaomiHomeManagerApiError && error.status === 401
    );
    assert.equal(fs.existsSync(credentials.credentialPath), false);

    const authorization = await controller.authorize("valid-candidate", "http://127.0.0.1:8123", controller.settings().revision);
    assert.equal(authorization.state, "ready");
    assert.equal(authorization.credentialSource, "protected");
    assert.equal(authorization.providerName, "秋雨的家");
    assert.equal(authorization.providerVersion, "2026.8");
    assert.ok(authorization.endpointAccountId);
    assert.doesNotMatch(JSON.stringify(authorization), /valid-candidate|accessToken/);
    assert.deepEqual(presented, ["Bearer invalid-candidate", "Bearer valid-candidate"]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("Xiaomi Home address replacement never presents the old credential to the candidate origin", async () => {
  const runtimeDir = temporaryDirectory();
  const calls: Array<{ url: string; authorization: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get("authorization") || "";
    calls.push({ url: String(input), authorization });
    if (String(input).startsWith("https://192.168.10.6:8123") && authorization === "Bearer new-candidate") {
      return new Response(JSON.stringify({ location_name: "New home", version: "2026.9" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ message: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const artifacts = new XiaomiHomeArtifactStore(runtimeDir);
    const settings = new XiaomiHomeSettingsStore(runtimeDir, { eventMonitorEnabled: false });
    const credentials = new XiaomiHomeCredentialStore(runtimeDir, testProtector);
    credentials.write("old-secret", "http://127.0.0.1:8123", {});
    const controller = new XiaomiHomeRuntimeController(settings, artifacts, {
      env: {}, fetchImpl, deliverEvent: async () => undefined
    }, credentials);

    await controller.authorize("new-candidate", "https://192.168.10.6:8123", controller.settings().revision);
    assert.equal(controller.settings().settings.baseUrl, "https://192.168.10.6:8123");
    assert.deepEqual(calls, [{
      url: "https://192.168.10.6:8123/api/config",
      authorization: "Bearer new-candidate"
    }]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
