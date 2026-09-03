import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  XiaomiHomeManagerApiClient,
  XiaomiHomeManagerApiError,
  mapXiaomiHomeAction,
  normalizeHomeAssistantState,
  resolveXiaomiHomeManagerConfig,
  xiaomiHomeActionSatisfied
} from "./managerApi.js";

function temporaryRuntimeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-xiaomi-actions-"));
}

function providerState(entityId: string, state: string, sequence = 0): {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_updated: string;
} {
  return {
    entity_id: entityId,
    state,
    attributes: { friendly_name: entityId },
    last_updated: `2026-08-29T10:00:${String(sequence).padStart(2, "0")}Z`
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

test("normalizes a Home Assistant entity into one Xiaomi Home resource contract", () => {
  const resource = normalizeHomeAssistantState({
    entity_id: "light.living_room",
    state: "on",
    attributes: { friendly_name: "客厅灯", brightness: 128 },
    last_updated: "2026-08-29T10:00:00Z"
  });
  assert.equal(resource.resourceId, "home:ha:light.living_room");
  assert.equal(resource.displayName, "客厅灯");
  assert.equal(resource.available, true);
  assert.ok(resource.capabilities.includes("home.light.set_brightness@1"));
  assert.match(resource.stateVersion, /^ha:[a-f0-9]{24}$/);
});

test("maps only typed capabilities and rejects cross-domain actions", () => {
  assert.deepEqual(mapXiaomiHomeAction({
    resourceId: "home:ha:light.living_room",
    capability: "home.light.set_brightness@1",
    expectedStateVersion: "ha:test",
    arguments: { brightnessPercent: 30 }
  }), {
    domain: "light",
    service: "turn_on",
    data: { entity_id: "light.living_room", brightness_pct: 30 }
  });
  assert.throws(() => mapXiaomiHomeAction({
    resourceId: "home:ha:lock.front_door",
    capability: "home.light.turn_on@1",
    expectedStateVersion: "ha:test"
  }), (error: unknown) => error instanceof XiaomiHomeManagerApiError && error.status === 403);
});

test("baseUrl requires HTTPS away from loopback and rejects DNS lookalikes by default", () => {
  assert.equal(resolveXiaomiHomeManagerConfig({ baseUrl: "http://localhost:8123" }).baseUrl, "http://127.0.0.1:8123");
  assert.equal(resolveXiaomiHomeManagerConfig({ baseUrl: "http://[::1]:8123" }).baseUrl, "http://[::1]:8123");
  assert.equal(resolveXiaomiHomeManagerConfig({ baseUrl: "https://192.168.10.5:8123" }).baseUrl, "https://192.168.10.5:8123");
  assert.equal(resolveXiaomiHomeManagerConfig({ baseUrl: "https://[fd12:3456::1]:8123" }).baseUrl, "https://[fd12:3456::1]:8123");
  assert.equal(resolveXiaomiHomeManagerConfig({
    baseUrl: "http://192.168.10.5:8123",
    allowInsecurePrivateHttp: true
  }).baseUrl, "http://192.168.10.5:8123");
  assert.throws(
    () => resolveXiaomiHomeManagerConfig({ baseUrl: "http://192.168.10.5:8123" }),
    (error: unknown) => error instanceof XiaomiHomeManagerApiError
      && error.code === "xiaomi_home_insecure_http_rejected"
  );

  for (const baseUrl of [
    "http://fd-example.com:8123",
    "http://fc-attacker.com:8123",
    "http://public.example:8123",
    "http://home-assistant.local:8123"
  ]) {
    assert.throws(
      () => resolveXiaomiHomeManagerConfig({ baseUrl }),
      (error: unknown) => error instanceof XiaomiHomeManagerApiError
        && error.code === "xiaomi_home_public_url_rejected"
    );
  }
  assert.equal(resolveXiaomiHomeManagerConfig({
    baseUrl: "https://home.example",
    allowPublicBaseUrl: true
  }).baseUrl, "https://home.example");
  for (const baseUrl of ["http://home.example", "http://8.8.8.8:8123"]) {
    assert.throws(
      () => resolveXiaomiHomeManagerConfig({
        baseUrl,
        allowPublicBaseUrl: true,
        allowInsecurePrivateHttp: true
      }),
      (error: unknown) => error instanceof XiaomiHomeManagerApiError
        && error.code === "xiaomi_home_insecure_http_rejected"
    );
  }
});

test("baseUrl rejects credentials and non-origin URL components", () => {
  for (const baseUrl of [
    "http://user:password@127.0.0.1:8123",
    "http://127.0.0.1:8123/api",
    "http://127.0.0.1:8123/?target=other",
    "http://127.0.0.1:8123/#fragment"
  ]) {
    assert.throws(
      () => resolveXiaomiHomeManagerConfig({ baseUrl }),
      (error: unknown) => error instanceof XiaomiHomeManagerApiError
        && error.code === "xiaomi_home_config_invalid"
        && !error.message.includes("password")
    );
  }
  assert.throws(
    () => new XiaomiHomeManagerApiClient({ runtimeDir: "relative-runtime" }),
    (error: unknown) => error instanceof XiaomiHomeManagerApiError
      && error.code === "xiaomi_home_config_invalid"
  );
});

test("REST requests never follow redirects or forward the Bearer token to a second target", async () => {
  const calls: Array<{ url: string; authorization: string; redirect: RequestRedirect | undefined }> = [];
  const client = new XiaomiHomeManagerApiClient({}, async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: String(headers.get("authorization") || ""),
      redirect: init?.redirect
    });
    return new Response(undefined, {
      status: 302,
      headers: { location: "https://attacker.example/collect" }
    });
  }, "private-value");

  await assert.rejects(
    () => client.listResources(),
    (error: unknown) => error instanceof XiaomiHomeManagerApiError
      && error.code === "xiaomi_home_redirect_rejected"
      && !error.message.includes("private-value")
      && !error.message.includes("attacker.example")
  );
  assert.deepEqual(calls, [{
    url: "http://127.0.0.1:8123/api/states",
    authorization: "Bearer private-value",
    redirect: "manual"
  }]);
});

test("health stays explicit while Home Assistant authorization is missing", async () => {
  const client = new XiaomiHomeManagerApiClient({}, fetch);
  assert.deepEqual(await client.getHealth(), {
    status: "authorization_required",
    provider: "home_assistant",
    baseUrl: "http://127.0.0.1:8123",
    credentialSource: "none",
    tokenConfigured: false,
    writeEnabled: false
  });
  await assert.rejects(() => client.listResources(), (error: unknown) =>
    error instanceof XiaomiHomeManagerApiError && error.code === "xiaomi_home_authorization_required");
});

test("health reports configured-but-unreachable authorization without exposing token contents", async () => {
  const client = new XiaomiHomeManagerApiClient({}, async () => {
    throw new TypeError("offline");
  }, "private-value");
  const health = await client.getHealth();
  assert.equal(health.status, "unreachable");
  assert.equal(health.tokenConfigured, true);
  assert.equal(JSON.stringify(health).includes("private-value"), false);
});

test("write-disabled action returns a stable planned receipt without calling a service", async () => {
  const runtimeDir = temporaryRuntimeDir();
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify({
      entity_id: "switch.desk",
      state: "off",
      attributes: { friendly_name: "桌面插座" },
      last_updated: "2026-08-29T10:00:00Z"
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new XiaomiHomeManagerApiClient({ runtimeDir }, fakeFetch, "secret");
    const before = await client.getResource("home:ha:switch.desk");
    const request = {
      resourceId: before.resourceId,
      capability: "home.switch.turn_on@1",
      expectedStateVersion: before.stateVersion
    };
    const first = await client.executeAction(request, "same-key");
    const second = await client.executeAction(request, "same-key");
    assert.equal(first.status, "planned");
    assert.deepEqual(second, first);
    assert.equal(calls.some(url => url.includes("/api/services/")), false);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("receipt-store failures stop before provider I/O and do not expose the runtime path", async () => {
  const runtimeDir = temporaryRuntimeDir();
  const blockedRoot = path.join(runtimeDir, "not-a-directory");
  fs.writeFileSync(blockedRoot, "blocked", "utf8");
  let providerCalls = 0;
  try {
    const client = new XiaomiHomeManagerApiClient({ runtimeDir: blockedRoot, writeEnabled: true }, async () => {
      providerCalls += 1;
      return jsonResponse(providerState("switch.desk", "off", 0));
    }, "private-token");
    await assert.rejects(
      () => client.executeAction({
        resourceId: "home:ha:switch.desk",
        capability: "home.switch.turn_on@1",
        expectedStateVersion: "ha:expected"
      }, "blocked-store-key"),
      (error: unknown) => error instanceof XiaomiHomeManagerApiError
        && error.status === 503
        && error.code === "xiaomi_home_idempotency_unavailable"
        && !error.message.includes(blockedRoot)
        && !error.message.includes("private-token")
    );
    assert.equal(providerCalls, 0);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("concurrent callers with one action intent publish exactly one Home Assistant service POST", async () => {
  const runtimeDir = temporaryRuntimeDir();
  const expected = normalizeHomeAssistantState(providerState("switch.desk", "off", 0));
  let currentState = "off";
  let currentSequence = 0;
  let serviceCalls = 0;
  let signalPostStarted: () => void = () => undefined;
  const postStarted = new Promise<void>(resolve => { signalPostStarted = resolve; });
  let releasePost: () => void = () => undefined;
  const postBarrier = new Promise<void>(resolve => { releasePost = resolve; });
  const pending: Promise<unknown>[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/services/")) {
      serviceCalls += 1;
      signalPostStarted();
      await postBarrier;
      currentState = "on";
      currentSequence = 1;
      return jsonResponse([]);
    }
    return jsonResponse(providerState("switch.desk", currentState, currentSequence));
  };
  try {
    const client = new XiaomiHomeManagerApiClient({ runtimeDir, writeEnabled: true }, fakeFetch, "secret");
    const request = {
      resourceId: expected.resourceId,
      capability: "home.switch.turn_on@1",
      expectedStateVersion: expected.stateVersion,
      reason: "turn on the desk outlet"
    };
    const first = client.executeAction(request, "concurrent-key");
    pending.push(first);
    await postStarted;
    const second = client.executeAction(request, "concurrent-key");
    pending.push(second);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(serviceCalls, 1);
    releasePost();
    const [firstReceipt, secondReceipt] = await Promise.all([first, second]);
    assert.equal(firstReceipt.status, "succeeded");
    assert.deepEqual(secondReceipt, firstReceipt);
    assert.equal(serviceCalls, 1);
  } finally {
    releasePost();
    await Promise.allSettled(pending);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("same Idempotency-Key conflicts when any canonical action intent field changes", async () => {
  const runtimeDir = temporaryRuntimeDir();
  const expected = normalizeHomeAssistantState(providerState("light.desk", "off", 0));
  let serviceCalls = 0;
  const fakeFetch: typeof fetch = async (input) => {
    if (String(input).includes("/api/services/")) serviceCalls += 1;
    return jsonResponse(providerState("light.desk", "off", 0));
  };
  try {
    const client = new XiaomiHomeManagerApiClient({ runtimeDir }, fakeFetch, "secret");
    const first = {
      requestId: "request-one",
      resourceId: expected.resourceId,
      capability: "home.light.set_brightness@1",
      arguments: { brightnessPercent: 10 },
      expectedStateVersion: expected.stateVersion,
      reason: "first intent"
    };
    const planned = await client.executeAction(first, "payload-key");
    assert.equal(planned.status, "planned");
    assert.deepEqual(await client.executeAction({ ...first, requestId: "request-two" }, "payload-key"), planned);
    for (const conflicting of [
      { ...first, arguments: { brightnessPercent: 20 } },
      { ...first, expectedStateVersion: "ha:different" },
      { ...first, reason: "different reason" },
      { ...first, dryRun: true },
      { ...first, capability: "home.light.turn_off@1" }
    ]) {
      await assert.rejects(
        () => client.executeAction(conflicting, "payload-key"),
        (error: unknown) => error instanceof XiaomiHomeManagerApiError
          && error.status === 409
          && error.code === "xiaomi_home_idempotency_conflict"
      );
    }
    assert.equal(serviceCalls, 0);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("state-version rejection happens inside the durable claim and releases the key without POST", async () => {
  const runtimeDir = temporaryRuntimeDir();
  let state = "off";
  let sequence = 1;
  let serviceCalls = 0;
  const stale = normalizeHomeAssistantState(providerState("switch.desk", "off", 0));
  const fakeFetch: typeof fetch = async (input) => {
    if (String(input).includes("/api/services/")) {
      serviceCalls += 1;
      state = "on";
      sequence += 1;
      return jsonResponse([]);
    }
    return jsonResponse(providerState("switch.desk", state, sequence));
  };
  try {
    const client = new XiaomiHomeManagerApiClient({ runtimeDir, writeEnabled: true }, fakeFetch, "secret");
    const staleRequest = {
      resourceId: stale.resourceId,
      capability: "home.switch.turn_on@1",
      expectedStateVersion: stale.stateVersion
    };
    await assert.rejects(
      () => client.executeAction(staleRequest, "cas-key"),
      (error: unknown) => error instanceof XiaomiHomeManagerApiError
        && error.status === 412
        && error.code === "xiaomi_home_state_version_changed"
    );
    assert.equal(serviceCalls, 0);

    const fresh = normalizeHomeAssistantState(providerState("switch.desk", state, sequence));
    const receipt = await client.executeAction({
      ...staleRequest,
      expectedStateVersion: fresh.stateVersion
    }, "cas-key");
    assert.equal(receipt.status, "succeeded");
    assert.equal(serviceCalls, 1);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("a lost POST response is recovered only by read-back and terminal receipt replays after restart", async () => {
  const runtimeDir = temporaryRuntimeDir();
  const expected = normalizeHomeAssistantState(providerState("switch.desk", "off", 0));
  let currentState = "off";
  let currentSequence = 0;
  let serviceCalls = 0;
  const fakeFetch: typeof fetch = async (input) => {
    if (String(input).includes("/api/services/")) {
      serviceCalls += 1;
      currentState = "on";
      currentSequence = 1;
      throw new TypeError("connection lost after write");
    }
    return jsonResponse(providerState("switch.desk", currentState, currentSequence));
  };
  const request = {
    requestId: "original-request",
    resourceId: expected.resourceId,
    capability: "home.switch.turn_on@1",
    expectedStateVersion: expected.stateVersion,
    reason: "recover by state read"
  };
  try {
    const firstClient = new XiaomiHomeManagerApiClient({ runtimeDir, writeEnabled: true }, fakeFetch, "private-token");
    const first = await firstClient.executeAction(request, "restart-key");
    assert.equal(first.status, "succeeded");
    assert.equal(serviceCalls, 1);

    const restartedClient = new XiaomiHomeManagerApiClient({ runtimeDir, writeEnabled: true }, fakeFetch, "private-token");
    const replay = await restartedClient.executeAction({ ...request, requestId: "retry-request" }, "restart-key");
    assert.deepEqual(replay, first);
    assert.equal(serviceCalls, 1);

    const receiptDir = path.join(runtimeDir, "data", "xiaomi-home-actions");
    const stored = fs.readdirSync(receiptDir).map(name => fs.readFileSync(path.join(receiptDir, name), "utf8")).join("\n");
    assert.equal(stored.includes("private-token"), false);
    assert.equal(stored.includes(runtimeDir), false);
    assert.equal(stored.includes("connection lost after write"), false);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("uncertain receipt remains fail-closed across restart and never replays the device POST", async () => {
  const runtimeDir = temporaryRuntimeDir();
  const expected = normalizeHomeAssistantState(providerState("switch.desk", "off", 0));
  let serviceCalls = 0;
  const fakeFetch: typeof fetch = async (input) => {
    if (String(input).includes("/api/services/")) {
      serviceCalls += 1;
      throw new TypeError("lost response with private diagnostic");
    }
    return jsonResponse(providerState("switch.desk", "off", 0));
  };
  const request = {
    resourceId: expected.resourceId,
    capability: "home.switch.turn_on@1",
    expectedStateVersion: expected.stateVersion
  };
  try {
    const firstClient = new XiaomiHomeManagerApiClient({ runtimeDir, writeEnabled: true }, fakeFetch, "private-token");
    await assert.rejects(
      () => firstClient.executeAction(request, "uncertain-key"),
      (error: unknown) => error instanceof XiaomiHomeManagerApiError
        && error.status === 409
        && error.code === "xiaomi_home_action_uncertain"
        && !error.message.includes("private diagnostic")
    );
    assert.equal(serviceCalls, 1);

    const restartedClient = new XiaomiHomeManagerApiClient({ runtimeDir, writeEnabled: true }, fakeFetch, "private-token");
    await assert.rejects(
      () => restartedClient.executeAction(request, "uncertain-key"),
      (error: unknown) => error instanceof XiaomiHomeManagerApiError
        && error.status === 409
        && error.code === "xiaomi_home_action_uncertain"
    );
    assert.equal(serviceCalls, 1);

    const receiptDir = path.join(runtimeDir, "data", "xiaomi-home-actions");
    const stored = fs.readdirSync(receiptDir).map(name => fs.readFileSync(path.join(receiptDir, name), "utf8")).join("\n");
    assert.equal(stored.includes("private-token"), false);
    assert.equal(stored.includes(runtimeDir), false);
    assert.equal(stored.includes("private diagnostic"), false);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("action read-back only succeeds when the requested target state is observed", () => {
  const light = normalizeHomeAssistantState({
    entity_id: "light.desk",
    state: "on",
    attributes: { brightness: 128 },
    last_updated: "2026-08-29T09:00:00.000Z"
  });
  assert.equal(xiaomiHomeActionSatisfied({
    resourceId: light.resourceId,
    capability: "home.light.turn_on@1",
    expectedStateVersion: light.stateVersion
  }, light), true);
  assert.equal(xiaomiHomeActionSatisfied({
    resourceId: light.resourceId,
    capability: "home.light.turn_off@1",
    expectedStateVersion: light.stateVersion
  }, light), false);
  assert.equal(xiaomiHomeActionSatisfied({
    resourceId: light.resourceId,
    capability: "home.light.set_brightness@1",
    arguments: { brightnessPercent: 50 },
    expectedStateVersion: light.stateVersion
  }, light), true);
});
