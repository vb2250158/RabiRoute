import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { XiaomiHomeArtifactStore } from "./artifactStore.js";
import { XiaomiHomeManagerApiError, normalizeHomeAssistantState } from "./managerApi.js";
import { XiaomiHomeCredentialStore } from "./credentials.js";
import { XiaomiHomeRuntimeController, XiaomiHomeSettingsStore } from "./settingsRuntime.js";
import { ManagedHaLoopbackProxy } from "./managedHaLoopbackProxy.js";

test("missing persona binding remains unconfigured instead of selecting a private role", () => {
  const root = temporaryDirectory();
  try {
    assert.equal(new XiaomiHomeSettingsStore(root, {}).read().settings.agentRoleId, "");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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
    assert.equal(profile.settings.writeEnabled, true);
    assert.equal(profile.settings.allowPublicBaseUrl, true);
    assert.equal(profile.settings.allowInsecurePrivateHttp, true);
    assert.equal(fs.existsSync(store.settingsPath), false);

    const saved = store.write({ ...profile.settings, eventMonitorEnabled: false, allowPublicBaseUrl: false, allowInsecurePrivateHttp: false }, profile.revision);
    assert.equal(saved.settings.allowPublicBaseUrl, false);
    assert.equal(saved.settings.allowInsecurePrivateHttp, false);
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
      monitoredEntityCount: 0,
      agentRoleConfigured: false
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
    credentials.write("secret", "http://127.0.0.1:8123", { credentialOrigin: "external" });
    const controller = new XiaomiHomeRuntimeController(store, artifacts, {
      fetchImpl,
      deliverEvent: async () => undefined
    }, credentials);
    const request = {
      resourceId: expected.resourceId,
      capability: "home.switch.turn_on@1",
      expectedStateVersion: expected.stateVersion,
      dryRun: true
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

test("runtime replacement joins the original capture even after another owner rejects cleanup", async () => {
  const root=temporaryDirectory(); let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const owner=new XiaomiHomeRuntimeController(new XiaomiHomeSettingsStore(root,{eventMonitorEnabled:false}),new XiaomiHomeArtifactStore(root),{env:{},deliverEvent:async()=>undefined},new XiaomiHomeCredentialStore(root,testProtector));
  const previous=Reflect.get(owner,"monitorValue"), capture=Reflect.get(owner,"captureValue");
  previous.stop=async()=>{throw undefined;}; capture.close=async()=>{await gate;};
  const next=Reflect.get(owner,"createRuntime").call(owner,owner.settings().settings);
  const replacing=Reflect.get(owner,"replaceRuntime").call(owner,next) as Promise<void>;
  let settled=false; const replaced=replacing.then(()=>assert.fail("must report failure"),error=>{settled=true;assert.equal(error,undefined);});
  const stopping=owner.stop(); const stopped=stopping.then(()=>assert.fail("must report failure"),error=>{assert.ok(error instanceof AggregateError);assert.deepEqual(error.errors,[undefined]);});
  try {
    await new Promise<void>(resolve=>setImmediate(resolve)); assert.equal(settled,false);
    release(); await replaced; await stopped;
  } finally {release(); await Promise.allSettled([replacing,stopping]); fs.rmSync(root,{recursive:true,force:true});}
});

test("managed HA sends credentials only through its verified VM transport", async () => {
  const root = temporaryDirectory();
  const calls: Array<{ url: string; authorization: string }> = [];
  const vmId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const configFile = path.join(root, "home-assistant-deployment.json");
  fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, config: { mode: "haos", autoStart: false, containerName: "homeassistant" } }));
  const credentials = new XiaomiHomeCredentialStore(root, testProtector);
  credentials.write("secret", "http://127.0.0.1:8123", { managedVmId: vmId });
  const controller = new XiaomiHomeRuntimeController(new XiaomiHomeSettingsStore(root, { eventMonitorEnabled: false }),
    new XiaomiHomeArtifactStore(root), { env: {}, deliverEvent: async () => undefined, fetchImpl: async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") || "" });
      return new Response(JSON.stringify({ message: "API running." }), { status: 200 });
    } }, credentials);
  let identity: { address: string; port: 80; vmId: string; legacyBindingVerified: boolean } | undefined;
  controller.deployment.managedIdentity = () => identity;
  controller.deployment.managedBaseUrl = () => "http://127.0.0.1:51234";
  const refresh = () => Reflect.get(controller, "replaceRuntime").call(controller,
    Reflect.get(controller, "createRuntime").call(controller, controller.settings().settings)) as Promise<void>;
  try {
    await refresh();
    await controller.health();
    assert.deepEqual(calls, []);
    identity = { address: "192.168.1.42", port: 80, vmId, legacyBindingVerified: true };
    await refresh();
    await controller.health();
    assert.deepEqual(calls, [{ url: "http://127.0.0.1:51234/api/", authorization: "Bearer secret" }]);
    identity = { ...identity, vmId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
    await refresh();
    await controller.health();
    assert.equal(calls.length, 1, "a different VM must not receive the managed credential");
    identity = undefined;
    await refresh();
    await controller.health();
    assert.equal(calls.length, 1);
    fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, config: { mode: "external", autoStart: false, containerName: "homeassistant" } }));
    await refresh();
    await controller.health();
    assert.equal(calls.length, 1, "managed token must not be sent to the old fixed-port service");
  } finally { await controller.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("managed authorization rejects a deployment change while verifying the token", async () => {
  const root = temporaryDirectory();
  const configFile = path.join(root, "home-assistant-deployment.json");
  const config = { mode: "haos", autoStart: false, containerName: "homeassistant" };
  fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, config }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const credentials = new XiaomiHomeCredentialStore(root, testProtector);
  const controller = new XiaomiHomeRuntimeController(new XiaomiHomeSettingsStore(root, { eventMonitorEnabled: false }),
    new XiaomiHomeArtifactStore(root), { env: {}, deliverEvent: async () => undefined, fetchImpl: async () => {
      entered(); await gate;
      return new Response(JSON.stringify({ location_name: "Home" }), { status: 200 });
    } }, credentials);
  const identity = { address: "192.168.1.42", port: 80 as const, vmId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", legacyBindingVerified: false };
  controller.deployment.managedIdentity = () => identity;
  controller.deployment.managedBaseUrl = () => "http://127.0.0.1:51234";
  try {
    const pending = controller.authorize("candidate", "http://127.0.0.1:8123", controller.settings().revision);
    await started;
    fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, config: { ...config, autoStart: true } }));
    release();
    await assert.rejects(pending, (error: unknown) => error instanceof XiaomiHomeManagerApiError && error.code === "xiaomi_home_managed_changed");
    assert.equal(fs.existsSync(credentials.credentialPath), false);
  } finally { release(); await controller.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy managed credential is migrated only with verified forwarding ownership", async () => {
  const root = temporaryDirectory();
  fs.writeFileSync(path.join(root, "home-assistant-deployment.json"), JSON.stringify({ schemaVersion: 1,
    config: { mode: "haos", autoStart: false, containerName: "homeassistant" } }));
  const credentials = new XiaomiHomeCredentialStore(root, testProtector);
  credentials.write("legacy-secret", "http://127.0.0.1:8123", {});
  const controller = new XiaomiHomeRuntimeController(new XiaomiHomeSettingsStore(root, { eventMonitorEnabled: false }),
    new XiaomiHomeArtifactStore(root), { env: {}, deliverEvent: async () => undefined }, credentials);
  controller.deployment.start = () => undefined;
  controller.deployment.managedBaseUrl = () => "http://127.0.0.1:51234";
  let identity = { address: "192.168.1.42", port: 80 as const, vmId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", legacyBindingVerified: false };
  controller.deployment.managedIdentity = () => identity;
  try {
    controller.start();
    Reflect.get(controller.deployment, "changes").emit("target", identity);
    assert.equal(credentials.resolve().metadata?.managedVmId, undefined);
    identity = { ...identity, legacyBindingVerified: true };
    Reflect.get(controller.deployment, "changes").emit("target", identity);
    assert.equal(credentials.resolve().metadata?.managedVmId, identity.vmId);
  } finally { await controller.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("DHCP legacy binding sends the original credential only through the current verified proxy and preserves logical address/origin fences", async () => {
  for (const scenario of ["verified", "changed-logical-url", "external-origin"] as const) {
    const root = temporaryDirectory();
    const calls: Array<{ url: string; expectedAuthorization: boolean }> = [];
    const vmId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    fs.writeFileSync(path.join(root, "home-assistant-deployment.json"), JSON.stringify({ schemaVersion: 1,
      config: { mode: "haos", autoStart: false, containerName: "homeassistant" } }));
    const credentials = new XiaomiHomeCredentialStore(root, testProtector);
    credentials.write("fixture-token", "http://127.0.0.1:8123", scenario === "external-origin" ? { credentialOrigin: "external" } : {});
    const before = JSON.parse(fs.readFileSync(credentials.credentialPath, "utf8"));
    const settings = new XiaomiHomeSettingsStore(root, { eventMonitorEnabled: false,
      baseUrl: scenario === "changed-logical-url" ? "http://127.0.0.1:7700" : "http://127.0.0.1:8123" });
    const controller = new XiaomiHomeRuntimeController(settings, new XiaomiHomeArtifactStore(root), {
      env: {}, deliverEvent: async () => undefined, fetchImpl: async (input, init) => {
        calls.push({ url: String(input), expectedAuthorization: new Headers(init?.headers).get("authorization") === "Bearer fixture-token" });
        return new Response(JSON.stringify({ message: "API running." }), { status: 200 });
      }
    }, credentials);
    controller.deployment.start = () => undefined;
    controller.deployment.managedBaseUrl = () => "http://127.0.0.1:51234";
    const identity = { address: "192.0.2.42", port: 80 as const, vmId, legacyBindingVerified: true };
    controller.deployment.managedIdentity = () => identity;
    try {
      controller.start();
      Reflect.get(controller.deployment, "changes").emit("target", identity);
      await Reflect.get(controller, "replaceRuntime").call(controller,
        Reflect.get(controller, "createRuntime").call(controller, controller.settings().settings));
      const health = await controller.health();
      const after = JSON.parse(fs.readFileSync(credentials.credentialPath, "utf8"));
      assert.equal(after.protectedCredential, before.protectedCredential);
      assert.equal(after.boundBaseUrl, before.boundBaseUrl);
      if (scenario === "verified") {
        assert.equal(after.managedVmId, vmId);
        assert.equal(health.tokenConfigured, true);
        assert.deepEqual(calls, [{ url: "http://127.0.0.1:51234/api/", expectedAuthorization: true }]);
      } else {
        assert.equal(after.managedVmId, undefined);
        assert.equal(health.tokenConfigured, false);
        assert.deepEqual(calls, [], "mismatched logical URL or external origin must not send the stored credential");
      }
    } finally { await controller.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("exhausted managed recovery reconnects the event monitor when the owned Core returns", { timeout: 15000 }, async () => {
  const root = temporaryDirectory();
  const vmId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "API running." }));
  });
  const sockets = new WebSocketServer({ server });
  let authenticated = "";
  let subscribe!: () => void;
  const subscribed = new Promise<void>(resolve => { subscribe = resolve; });
  sockets.on("connection", socket => {
    socket.send(JSON.stringify({ type: "auth_required" }));
    socket.on("message", data => {
      const message = JSON.parse(String(data)) as { type?: string; access_token?: string; id?: number };
      if (message.type === "auth") {
        authenticated = String(message.access_token || "");
        socket.send(JSON.stringify({ type: "auth_ok" }));
      } else if (message.type === "subscribe_events") {
        socket.send(JSON.stringify({ id: message.id, type: "result", success: true }));
        subscribe();
        socket.send(JSON.stringify({ id: message.id, type: "event", event: {
          event_type: "state_changed", time_fired: "2026-01-01T00:00:00Z", data: {
            old_state: { entity_id: "binary_sensor.camera_motion", state: "off", attributes: { device_class: "motion" } },
            new_state: { entity_id: "binary_sensor.camera_motion", state: "on", attributes: { device_class: "motion" } }
          }
        } }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as net.AddressInfo).port;
  fs.writeFileSync(path.join(root, "home-assistant-deployment.json"), JSON.stringify({ schemaVersion: 1,
    config: { mode: "haos", autoStart: true, containerName: "homeassistant", recoveryMaxAttempts: 1 } }));
  const settings = new XiaomiHomeSettingsStore(root, { baseUrl: "http://127.0.0.1:8123", eventMonitorEnabled: true,
    agentRoleId: "CameraOwner", cameraMotionEntityIds: ["binary_sensor.camera_motion"] });
  const credentials = new XiaomiHomeCredentialStore(root, testProtector);
  credentials.write("fixture-secret", "http://127.0.0.1:8123", {});
  const events: Array<{ kind: string; role: string }> = [];
  const controller = new XiaomiHomeRuntimeController(settings, new XiaomiHomeArtifactStore(root), {
    env: {}, deliverEvent: async (event, options) => { events.push({ kind: event.kind, role: options.agentRoleId }); }
  }, credentials);
  let recoveries = 0;
  let coreReady = false;
  Reflect.set(controller.deployment, "os", {
    inspect: async () => ({ state: "error", installed: true, message: "Core unavailable" }),
    run: async () => { recoveries++; throw new Error("Core unavailable"); },
    observe: async () => coreReady ? { address: "192.0.2.1", port: 80, vmId, legacyBindingVerified: true } : undefined
  });
  Reflect.set(controller.deployment, "proxy", await ManagedHaLoopbackProxy.listen({ connect: () => net.createConnection({ host: "127.0.0.1", port }) }));
  Reflect.set(controller.deployment, "io", { ...Reflect.get(controller.deployment, "io"),
    ready: async () => (await fetch(`http://127.0.0.1:${port}/`)).ok });
  try {
    await controller.activate();
    await Reflect.get(controller.deployment, "flight");
    assert.equal(recoveries, 1);
    assert.equal((await controller.deployment.inspect()).recoveryExhausted, true);
    coreReady = true;
    await controller.deployment.recover();
    await subscribed;
    const deadline = Date.now() + 3000;
    while (!events.some(event => event.kind === "camera_motion_detected") && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(recoveries, 1, "reconnection must not restart the VM after recovery budget exhaustion");
    assert.equal(credentials.resolve().metadata?.managedVmId, vmId);
    assert.equal(authenticated, "fixture-secret");
    assert.ok(events.some(event => event.kind === "camera_motion_detected" && event.role === "CameraOwner"));
  } finally {
    await controller.stop();
    sockets.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous legacy loopback credentials require external reauthorization across restart", async () => {
  const root = temporaryDirectory();
  const configFile = path.join(root, "home-assistant-deployment.json");
  const saveMode = (mode: string) => fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 1,
    config: { mode, autoStart: false, containerName: "homeassistant" } }));
  const credentials = new XiaomiHomeCredentialStore(root, testProtector);
  credentials.write("legacy-secret", "http://127.0.0.1:8123", {});
  const calls: string[] = [];
  const dependencies = { env: {}, deliverEvent: async () => undefined, fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get("authorization") || "");
    return new Response(JSON.stringify({ location_name: "Home", message: "API running." }), { status: 200 });
  } };
  saveMode("haos");
  const first = new XiaomiHomeRuntimeController(new XiaomiHomeSettingsStore(root, { eventMonitorEnabled: false }),
    new XiaomiHomeArtifactStore(root), dependencies, credentials);
  saveMode("external");
  const refresh = Reflect.get(first, "replaceRuntime").call(first,
    Reflect.get(first, "createRuntime").call(first, first.settings().settings)) as Promise<void>;
  await refresh;
  await first.health();
  assert.deepEqual(calls, []);
  await first.stop();
  const restarted = new XiaomiHomeRuntimeController(new XiaomiHomeSettingsStore(root, { eventMonitorEnabled: false }),
    new XiaomiHomeArtifactStore(root), dependencies, credentials);
  try {
    await restarted.health();
    assert.deepEqual(calls, []);
    await restarted.authorize("external-new-secret", "http://127.0.0.1:8123", restarted.settings().revision);
    assert.equal(credentials.resolve().metadata?.credentialOrigin, "external");
    await restarted.health();
    assert.deepEqual(calls, ["Bearer external-new-secret", "Bearer external-new-secret"]);
  } finally { await restarted.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
