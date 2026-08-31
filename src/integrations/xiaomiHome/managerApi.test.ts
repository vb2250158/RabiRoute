import assert from "node:assert/strict";
import test from "node:test";
import {
  XiaomiHomeManagerApiClient,
  XiaomiHomeManagerApiError,
  mapXiaomiHomeAction,
  normalizeHomeAssistantState,
  xiaomiHomeActionSatisfied
} from "./managerApi.js";

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

test("health stays explicit while Home Assistant authorization is missing", async () => {
  const client = new XiaomiHomeManagerApiClient({}, fetch, {});
  assert.deepEqual(await client.getHealth(), {
    status: "authorization_required",
    provider: "home_assistant",
    baseUrl: "http://127.0.0.1:8123",
    tokenEnv: "RABIROUTE_XIAOMI_HOME_HA_TOKEN",
    tokenConfigured: false,
    writeEnabled: false
  });
  await assert.rejects(() => client.listResources(), (error: unknown) =>
    error instanceof XiaomiHomeManagerApiError && error.code === "xiaomi_home_authorization_required");
});

test("health reports configured-but-unreachable authorization without exposing token contents", async () => {
  const client = new XiaomiHomeManagerApiClient({}, async () => {
    throw new TypeError("offline");
  }, { RABIROUTE_XIAOMI_HOME_HA_TOKEN: "private-value" });
  const health = await client.getHealth();
  assert.equal(health.status, "unreachable");
  assert.equal(health.tokenConfigured, true);
  assert.equal(JSON.stringify(health).includes("private-value"), false);
});

test("write-disabled action returns a stable planned receipt without calling a service", async () => {
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
  const client = new XiaomiHomeManagerApiClient({}, fakeFetch, { RABIROUTE_XIAOMI_HOME_HA_TOKEN: "secret" });
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
