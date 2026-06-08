import assert from "node:assert/strict";
import test from "node:test";
import {
  autoAssignGatewayPorts,
  gatewayAdapterTypes,
  messageAdapterPolicyFor,
  normalizeGatewayDefinition,
  normalizeNapCatInstances,
  normalizeRuleDefinitions,
  sanitizeConfigName,
  validateGatewayPortConflicts,
  type GatewayDefinition
} from "./gatewayConfigModel.js";

function gateway(patch: Partial<GatewayDefinition> = {}): GatewayDefinition {
  return {
    id: "Rabi__main",
    enabled: true,
    messageAdapters: ["napcat"],
    gatewayPort: 8789,
    napcatHttpUrl: "http://127.0.0.1:3000",
    agentRoleId: "Rabi",
    notificationRules: [{
      id: "direct",
      routeKinds: ["direct_at"],
      template: "hello"
    }],
    ...patch
  };
}

test("route id and config names are normalized", () => {
  assert.equal(sanitizeConfigName(" main route!! "), "main-route");
  const normalized = normalizeGatewayDefinition(gateway({ id: "Rabi__main-route" }));
  assert.equal(normalized.id, "main-route");
  assert.equal(normalized.agentRoleId, "Rabi");
  assert.equal(normalized.configName, "main-route");
});

test("message adapters honor disabled input and disabled adapter lists", () => {
  assert.deepEqual(gatewayAdapterTypes(gateway({ messageAdapters: ["napcat", "heartbeat"], messageAdaptersDisabled: ["napcat"] })), ["heartbeat"]);
  assert.deepEqual(gatewayAdapterTypes(gateway({ messageInputsDisabled: true, messageAdapters: ["napcat"] })), []);
});

test("message adapter policies control input while keeping output defaults enabled", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["napcat", "heartbeat"],
    messageAdapterPolicies: {
      napcat: { inputEnabled: false },
      heartbeat: { outputMode: "direct", allowedGroups: ["10001"] }
    }
  }));
  assert.deepEqual(gatewayAdapterTypes(normalized), ["heartbeat"]);
  assert.equal(messageAdapterPolicyFor(normalized, "napcat").outputEnabled, true);
  assert.equal(messageAdapterPolicyFor(normalized, "heartbeat").outputMode, "direct");
  assert.deepEqual(messageAdapterPolicyFor(normalized, "heartbeat").supportedOutputs, ["text", "image", "voice", "file"]);
});

test("legacy disabled adapter list backfills policy input state", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["napcat", "heartbeat"],
    messageAdaptersDisabled: ["napcat"]
  }));
  assert.equal(messageAdapterPolicyFor(normalized, "napcat").inputEnabled, false);
  assert.equal(messageAdapterPolicyFor(normalized, "heartbeat").inputEnabled, true);
});

test("NapCat instances receive defaults and unique ids", () => {
  const instances = normalizeNapCatInstances(gateway({
    napcatInstances: [
      { id: "bot", gatewayPort: 8791, httpUrl: "http://127.0.0.1:3001" },
      { id: "bot", gatewayPort: 8792, httpUrl: "http://127.0.0.1:3002" }
    ]
  }));
  assert.equal(instances[0].id, "bot");
  assert.equal(instances[1].id, "bot-2");
  assert.equal(instances[0].webuiUrl, "http://127.0.0.1:6099/webui");
});

test("NapCat invalid ports are rejected", () => {
  assert.throws(
    () => normalizeNapCatInstances(gateway({ napcatInstances: [{ id: "bad", gatewayPort: 70000, httpUrl: "http://127.0.0.1:3000" }] })),
    /Port must be an integer/
  );
});

test("auto assignment skips the manager port", () => {
  const items = [gateway({ gatewayPort: 8790 })];
  autoAssignGatewayPorts(items, 8790);
  assert.notEqual(items[0].gatewayPort, 8790);
  assert.equal(items[0].gatewayPort, 8791);
});

test("port conflicts are detected across gateway, webhook and NapCat HTTP ports", () => {
  assert.throws(
    () => validateGatewayPortConflicts([
      gateway({ id: "Rabi__main", gatewayPort: 8789, messageAdapters: ["napcat"], napcatInstances: [] }),
      gateway({ id: "Rabi__web", gatewayPort: 8799, messageAdapters: ["webhook"], webhookPort: 8789 })
    ]),
    /Port conflict/
  );

  assert.throws(
    () => validateGatewayPortConflicts([
      gateway({ id: "Rabi__a", gatewayPort: 8791, napcatInstances: [{ id: "a", gatewayPort: 8791, httpUrl: "http://127.0.0.1:3000" }] }),
      gateway({ id: "Rabi__b", gatewayPort: 8792, napcatInstances: [{ id: "b", gatewayPort: 8792, httpUrl: "http://127.0.0.1:3000" }] })
    ]),
    /NapCat HTTP/
  );
});

test("notification rules and escaped newlines are normalized", () => {
  const [rule] = normalizeRuleDefinitions([{ routeKinds: [123], template: "a\\nb" }]) ?? [];
  assert.equal(rule.id, "rule-1");
  assert.deepEqual(rule.routeKinds, ["123"]);
  assert.equal(rule.template, "a\nb");
});
