import assert from "node:assert/strict";
import test from "node:test";
import { messageEndpointConnection } from "../../src/plugins/io.rabiroute.manager.message-adapter-control/web/messageEndpointConnection";
import type { GatewayDefinition, RuntimeStatus } from "../src/types";

const route = {
  id: "current-route",
  enabled: true,
  napcatInstances: [{ id: "qq", enabled: true, botUserId: "fixture" }],
  qqbotAccountId: "bot",
  wecomBotId: "wecom-bot"
} as GatewayDefinition;

function runtime(gatewayStatus: RuntimeStatus["gatewayStatus"]): RuntimeStatus {
  return { ...route, running: true, gatewayStatus };
}

test("NapCat uses only the selected Route and turns an observed disconnect into a connection issue", () => {
  const instance = { id: "qq", routeId: route.id, botUserId: "fixture", connected: true, online: true };
  const status = (row: typeof instance) => runtime({ napcatInstances: [row] });
  assert.equal(messageEndpointConnection(route, status(instance), "napcat"), "connected");
  assert.equal(messageEndpointConnection(route, status({ ...instance, routeId: "other-route" }), "napcat"), "disconnected");
  assert.equal(messageEndpointConnection(route, status({ ...instance, online: false }), "napcat"), "issue");
  assert.equal(messageEndpointConnection(route, status({ ...instance, botUserId: "other" }), "napcat"), "issue");
  assert.equal(messageEndpointConnection({ ...route, messageAdaptersDisabled: ["napcat"] }, status(instance), "napcat"), "disconnected");
});

test("bot connection requires the platform's own status, with expired authorization shown as an issue", () => {
  const state = runtime({
    messageAdapters: {
      qqbot: { accountId: "bot", connected: true },
      weixin: { sessionPhase: "invalid", loggedIn: false, credentialsRetained: false },
      wecom: { connected: false, authenticated: false }
    }
  });
  assert.equal(messageEndpointConnection(route, state, "qqbot"), "connected");
  assert.equal(messageEndpointConnection({ ...route, qqbotAccountId: "another-bot" }, state, "qqbot"), "disconnected");
  assert.equal(messageEndpointConnection(route, state, "weixin"), "issue");
  assert.equal(messageEndpointConnection(route, state, "wecom"), "issue");
  assert.equal(messageEndpointConnection(route, state, "webhook"), "setup");
});
