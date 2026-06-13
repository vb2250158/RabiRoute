import assert from "node:assert/strict";
import test from "node:test";
import {
  autoAssignGatewayPorts,
  collectGatewayPortClaims,
  ensureDefaultPersonaRules,
  gatewayAdapterTypes,
  isBuiltinRolePanelNotificationRule,
  messageAdapterPolicyFor,
  normalizeGatewayDefinition,
  normalizeGatewayNapCatConfig,
  normalizeNapCatInstances,
  normalizeRuleDefinitions,
  resolvePrimaryNapCatInstance,
  sanitizeConfigName,
  syncPrimaryNapCatInstanceFields,
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
      heartbeat: { outputEnabled: false }
    }
  }));
  assert.deepEqual(gatewayAdapterTypes(normalized), ["heartbeat"]);
  assert.equal(messageAdapterPolicyFor(normalized, "napcat").outputEnabled, true);
  assert.equal(messageAdapterPolicyFor(normalized, "heartbeat").outputEnabled, false);
  assert.deepEqual(messageAdapterPolicyFor(normalized, "heartbeat").supportedOutputs, ["text", "image", "voice", "file"]);
});

test("legacy Codex agent adapter ids are upgraded to codex", () => {
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["codexDesktop"] as any })).agentAdapters, ["codex"]);
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["codexApp"] as any })).agentAdapters, ["codex"]);
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["codexDesktop", "codexApp"] as any })).agentAdapters, ["codex"]);
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["codexApp", "copilotCli"] as any })).agentAdapters, ["codex", "copilotCli"]);
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["unknown"] as any })).agentAdapters, ["codex"]);
});

test("default gateway agent adapter uses codex", () => {
  assert.deepEqual(normalizeGatewayDefinition(gateway()).agentAdapters, ["codex"]);
});

test("legacy message adapter target restrictions are ignored", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["napcat"],
    messageAdapterPolicies: {
      napcat: { allowedGroups: ["10001"], allowedUsers: ["10002"], allowBroadcast: false, disabledPipelines: ["qq"] } as any
    }
  }));

  assert.deepEqual(Object.keys(messageAdapterPolicyFor(normalized, "napcat")).sort(), [
    "inputEnabled",
    "outputEnabled",
    "supportedOutputs"
  ].sort());
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

test("NapCat primary resolution chooses the first enabled normalized instance", () => {
  const resolved = normalizeGatewayNapCatConfig(gateway({
    gatewayPort: 8791,
    napcatHttpUrl: "http://127.0.0.1:3001",
    napcatInstances: [
      { id: "off", enabled: false, gatewayPort: 8792, httpUrl: "http://127.0.0.1:3002" },
      { id: "on", gatewayPort: 8793, httpUrl: "http://127.0.0.1:3003", accessToken: "bot-token" }
    ]
  }));

  assert.equal(resolved.primaryIndex, 1);
  assert.equal(resolved.primary?.id, "on");
  assert.equal(resolved.instances[0].enabled, false);
  assert.equal(resolved.instances[1].webuiUrl, "http://127.0.0.1:6099/webui");
});

test("NapCat primary sync backfills gateway fields and clears stale tokens", () => {
  const definition = gateway({
    gatewayPort: 8791,
    napcatHttpUrl: "http://127.0.0.1:3001",
    napcatAccessToken: "stale-access",
    napcatWebuiToken: "stale-webui",
    napcatInstances: [
      { id: "old", enabled: false, gatewayPort: 8792, httpUrl: "http://127.0.0.1:3002", accessToken: "old-access", webuiToken: "old-webui" },
      { id: "primary", gatewayPort: 8793, httpUrl: "http://127.0.0.1:3003", webuiUrl: "http://127.0.0.1:6103/webui", accessToken: "", webuiToken: "" }
    ]
  });

  const resolved = syncPrimaryNapCatInstanceFields(definition);

  assert.equal(resolved.primary?.id, "primary");
  assert.equal(definition.gatewayPort, 8793);
  assert.equal(definition.napcatHttpUrl, "http://127.0.0.1:3003");
  assert.equal(definition.napcatWebuiUrl, "http://127.0.0.1:6103/webui");
  assert.equal(definition.napcatAccessToken, "");
  assert.equal(definition.napcatWebuiToken, "");
});

test("NapCat primary resolution falls back to the first instance when all are disabled", () => {
  const instances = normalizeNapCatInstances(gateway({
    napcatInstances: [
      { id: "a", enabled: false, gatewayPort: 8791, httpUrl: "http://127.0.0.1:3001" },
      { id: "b", enabled: false, gatewayPort: 8792, httpUrl: "http://127.0.0.1:3002" }
    ]
  }));

  const resolved = resolvePrimaryNapCatInstance(gateway(), instances);

  assert.equal(resolved.primaryIndex, 0);
  assert.equal(resolved.primary?.id, "a");
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

test("auto assignment allocates unique NapCat instance ports and syncs primary", () => {
  const items = [
    gateway({
      id: "Rabi__a",
      gatewayPort: 8790,
      napcatInstances: [
        { id: "a1", gatewayPort: 8790, httpUrl: "http://127.0.0.1:3000", webuiUrl: "http://127.0.0.1:6099/webui", accessToken: "a1" },
        { id: "a2", gatewayPort: 8790, httpUrl: "http://127.0.0.1:3000", webuiUrl: "http://127.0.0.1:6100/webui", accessToken: "a2" }
      ]
    }),
    gateway({
      id: "Rabi__b",
      gatewayPort: 8790,
      messageAdapters: ["napcat", "webhook"],
      webhookPort: 8790,
      napcatInstances: [
        { id: "b1", gatewayPort: 8790, httpUrl: "http://127.0.0.1:3000", webuiUrl: "http://127.0.0.1:6101/webui", accessToken: "b1" }
      ]
    })
  ];

  autoAssignGatewayPorts(items, 8790);

  const claims = collectGatewayPortClaims(items, { managerPort: 8790 });
  assert.equal(new Set(claims.map((claim) => claim.port)).size, claims.length);
  assert.equal(items[0].gatewayPort, items[0].napcatInstances?.[0].gatewayPort);
  assert.equal(items[0].napcatHttpUrl, items[0].napcatInstances?.[0].httpUrl);
  assert.equal(items[0].napcatAccessToken, "a1");
  assert.notEqual(items[0].napcatInstances?.[0].gatewayPort, items[0].napcatInstances?.[1].gatewayPort);
  assert.notEqual(items[0].napcatInstances?.[0].httpUrl, items[0].napcatInstances?.[1].httpUrl);
  validateGatewayPortConflicts(items);
});

test("port claims expose NapCat WS and HTTP ownership", () => {
  const claims = collectGatewayPortClaims([
    gateway({
      id: "Rabi__a",
      napcatInstances: [
        { id: "a1", gatewayPort: 8791, httpUrl: "http://127.0.0.1:3001" },
        { id: "a2", enabled: false, gatewayPort: 8792, httpUrl: "http://127.0.0.1:3002" }
      ]
    })
  ], { managerPort: 8790 });

  assert.deepEqual(claims.map((claim) => [claim.kind, claim.gatewayId, claim.instanceId, claim.port]), [
    ["manager", undefined, undefined, 8790],
    ["napcat-ws", "Rabi__a", "a1", 8791],
    ["napcat-http", "Rabi__a", "a1", 3001]
  ]);
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
  const [rule] = normalizeRuleDefinitions([{
    routeKinds: [123],
    template: "a\\nb",
    schedules: [{
      id: "daytime",
      type: "interval",
      intervalSeconds: 900,
      windowStartTime: "09:30",
      windowEndTime: "19:00"
    }]
  }]) ?? [];
  assert.equal(rule.id, "rule-1");
  assert.deepEqual(rule.routeKinds, ["123"]);
  assert.equal(rule.template, "a\nb");
  assert.deepEqual(rule.schedules?.[0], {
    id: "daytime",
    name: undefined,
    enabled: true,
    type: "interval",
    intervalSeconds: 900,
    windowStartTime: "09:30",
    windowEndTime: "19:00",
    timeOfDay: undefined,
    onceAt: undefined
  });
});

test("persona rules always include the builtin role panel message rule", () => {
  const rules = ensureDefaultPersonaRules([
    { id: "direct", routeKinds: ["direct_at"], template: "hello" }
  ]);

  assert.deepEqual(rules.map(rule => rule.id), ["direct", "role-panel-message"]);
  assert.equal(isBuiltinRolePanelNotificationRule(rules[1]), true);
  assert.deepEqual(rules[1].routeKinds, ["role_panel_message"]);
  assert.equal(rules[1].enabled, true);
});

test("legacy role panel persona rules are canonicalized", () => {
  const rules = ensureDefaultPersonaRules([
    {
      id: "old-role-panel",
      name: "  ",
      enabled: false,
      routeKinds: ["role_panel_message", "manual_trigger"],
      targetGroupId: "10001",
      regex: "hello",
      template: "a\\nb",
      schedules: [{ id: "unused", type: "interval", intervalSeconds: 30 }]
    }
  ]);

  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0], {
    id: "role-panel-message",
    name: "角色面板消息",
    enabled: true,
    routeKinds: ["role_panel_message"],
    targetGroupId: "",
    regex: "",
    schedules: undefined,
    template: "a\nb"
  });
});
