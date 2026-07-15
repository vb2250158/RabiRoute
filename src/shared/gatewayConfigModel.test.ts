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

function localUrl(port: number, pathname = ""): string {
  return `http://127.0.0.1:${port}${pathname}`;
}

function gateway(patch: Partial<GatewayDefinition> = {}): GatewayDefinition {
  return {
    id: "Rabi__main",
    enabled: true,
    messageAdapters: ["napcat"],
    gatewayPort: 8789,
    napcatHttpUrl: localUrl(3000),
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
  assert.deepEqual(messageAdapterPolicyFor(normalized, "heartbeat").allowedFileRoots, []);
});

test("message adapter policies normalize allowed outbound file roots", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapterPolicies: {
      napcat: {
        supportedOutputs: ["text", "file"],
        allowedFileRoots: [" C:/Builds ", "C:/Builds", "D:/Artifacts"]
      }
    }
  }));
  assert.deepEqual(messageAdapterPolicyFor(normalized, "napcat").allowedFileRoots, ["C:/Builds", "D:/Artifacts"]);
});

test("WeCom is a message/output adapter and does not claim a local ingress port", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["wecom"],
    pipeline: {
      inputAdapter: "wecom",
      outputAdapter: "wecom",
      outputPipeline: "wecom"
    },
    wecomBotId: "bot-id-placeholder",
    wecomBotSecret: "secret-placeholder",
    wecomWsUrl: "wss://example.invalid/wecom"
  }));

  assert.deepEqual(gatewayAdapterTypes(normalized), ["wecom"]);
  assert.equal(normalized.pipeline?.inputAdapter, "wecom");
  assert.equal(normalized.pipeline?.outputAdapter, "wecom");
  assert.equal(messageAdapterPolicyFor(normalized, "wecom").outputEnabled, true);

  const claims = collectGatewayPortClaims([normalized], { managerPort: 8790 });
  assert.deepEqual(claims.map((claim) => claim.kind), ["manager"]);
});

test("legacy Codex pipeline output normalizes to canonical Agent output", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    pipeline: {
      outputAdapter: "codex",
      outputPipeline: "codex"
    }
  }));

  assert.equal(normalized.pipeline?.outputAdapter, "agent");
  assert.equal(normalized.pipeline?.outputPipeline, "agent");
  assert.equal(normalized.routeProfiles?.[0]?.pipeline?.outputAdapter, "agent");
  assert.equal(normalized.routeProfiles?.[0]?.pipeline?.outputPipeline, "agent");
});

test("shared config normalization accepts canonical Agent adapter ids only", () => {
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["codexDesktop"] as any })).agentAdapters, []);
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["codexApp"] as any })).agentAdapters, []);
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["codexApp", "copilotCli"] as any })).agentAdapters, ["copilotCli"]);
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: ["unknown"] as any })).agentAdapters, []);
  assert.deepEqual(normalizeGatewayDefinition(gateway({ agentAdapters: [] })).agentAdapters, []);
});

test("default gateway agent adapter uses codex", () => {
  assert.deepEqual(normalizeGatewayDefinition(gateway()).agentAdapters, ["codex"]);
});

test("heartbeat busy guard defaults off and preserves an explicit opt-in", () => {
  assert.equal(normalizeGatewayDefinition(gateway()).heartbeatSkipWhenAgentBusy, false);
  assert.equal(normalizeGatewayDefinition(gateway({ heartbeatSkipWhenAgentBusy: true })).heartbeatSkipWhenAgentBusy, true);
});

test("recent message limit defaults to 10 and can be set per persona", () => {
  const defaulted = normalizeGatewayDefinition(gateway());
  assert.equal(defaulted.recentMessageLimit, 10);
  assert.equal(defaulted.routeProfiles?.[0]?.recentMessageLimit, 10);

  const customized = normalizeGatewayDefinition(gateway({ recentMessageLimit: 4 }));
  assert.equal(customized.recentMessageLimit, 4);
  assert.equal(customized.routeProfiles?.[0]?.recentMessageLimit, 4);
});

test("persona-free gateways get default message adapter rules", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    id: "Rabi__plain",
    agentRoleId: "",
    messageAdapters: ["napcat", "fennenote"],
    notificationRules: []
  }));

  assert.equal(normalized.id, "plain");
  assert.equal(normalized.agentRoleId, "");
  assert.deepEqual(normalized.notificationRules?.map(rule => rule.id), ["default-napcat", "default-fennenote"]);
  assert.deepEqual(normalized.notificationRules?.[0]?.routeKinds, ["private", "direct_at", "direct_reply", "indirect_reply"]);
  assert.deepEqual(normalized.notificationRules?.[1]?.routeKinds, ["voice_transcript"]);
  assert.deepEqual(normalized.roleNotificationRules, {});
  assert.equal(normalized.routeProfiles?.[0]?.agentRoleId, "");
});
test("RabiLink is a named webhook-like message adapter", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    id: "Rabi__rabilink",
    agentRoleId: "",
    messageAdapters: ["rabilink"],
    rabiLinkWebhookPort: 8794,
    rabiLinkWebhookPath: "/rabilink",
    notificationRules: []
  }));

  assert.deepEqual(gatewayAdapterTypes(normalized), ["rabilink"]);
  assert.deepEqual(normalized.notificationRules?.map(rule => rule.id), ["default-rabilink"]);
  assert.deepEqual(normalized.notificationRules?.[0]?.routeKinds, ["rabilink"]);

  const claims = collectGatewayPortClaims([normalized], { managerPort: 8790 });
  assert.equal(claims.find(claim => claim.kind === "rabilink-webhook")?.port, 8794);
});

test("legacy message adapter target restrictions are ignored", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    messageAdapters: ["napcat"],
    messageAdapterPolicies: {
      napcat: { allowedGroups: ["10001"], allowedUsers: ["10002"], allowBroadcast: false, disabledPipelines: ["qq"] } as any
    }
  }));

  assert.deepEqual(Object.keys(messageAdapterPolicyFor(normalized, "napcat")).sort(), [
    "allowedFileRoots",
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
      { id: "bot", gatewayPort: 8791, httpUrl: localUrl(3001) },
      { id: "bot", gatewayPort: 8792, httpUrl: localUrl(3002) }
    ]
  }));
  assert.equal(instances[0].id, "bot");
  assert.equal(instances[1].id, "bot-2");
  assert.equal(instances[0].webuiUrl, localUrl(6099, "/webui"));
});

test("legacy NapCat endpoint fields do not create a runnable default instance", () => {
  const normalized = normalizeGatewayDefinition(gateway({
    gatewayPort: 8791,
    napcatHttpUrl: localUrl(3001),
    napcatWebuiUrl: localUrl(6099, "/webui")
  }));

  assert.deepEqual(normalized.napcatInstances, []);
  assert.equal(normalized.gatewayPort, 8791);
  assert.equal(normalized.napcatHttpUrl, localUrl(3001));
});

test("NapCat primary resolution chooses the first enabled normalized instance", () => {
  const resolved = normalizeGatewayNapCatConfig(gateway({
    gatewayPort: 8791,
    napcatHttpUrl: localUrl(3001),
    napcatInstances: [
      { id: "off", enabled: false, gatewayPort: 8792, httpUrl: localUrl(3002) },
      { id: "on", gatewayPort: 8793, httpUrl: localUrl(3003), accessToken: "bot-token" }
    ]
  }));

  assert.equal(resolved.primaryIndex, 1);
  assert.equal(resolved.primary?.id, "on");
  assert.equal(resolved.instances[0].enabled, false);
  assert.equal(resolved.instances[1].webuiUrl, localUrl(6099, "/webui"));
});

test("NapCat primary sync backfills gateway fields and clears stale tokens", () => {
  const definition = gateway({
    gatewayPort: 8791,
    napcatHttpUrl: localUrl(3001),
    napcatAccessToken: "stale-access",
    napcatWebuiToken: "stale-webui",
    napcatInstances: [
      { id: "old", enabled: false, gatewayPort: 8792, httpUrl: localUrl(3002), accessToken: "old-access", webuiToken: "old-webui" },
      { id: "primary", gatewayPort: 8793, httpUrl: localUrl(3003), webuiUrl: localUrl(6103, "/webui"), accessToken: "", webuiToken: "" }
    ]
  });

  const resolved = syncPrimaryNapCatInstanceFields(definition);

  assert.equal(resolved.primary?.id, "primary");
  assert.equal(definition.gatewayPort, 8793);
  assert.equal(definition.napcatHttpUrl, localUrl(3003));
  assert.equal(definition.napcatWebuiUrl, localUrl(6103, "/webui"));
  assert.equal(definition.napcatAccessToken, "");
  assert.equal(definition.napcatWebuiToken, "");
});

test("NapCat primary resolution falls back to the first instance when all are disabled", () => {
  const instances = normalizeNapCatInstances(gateway({
    napcatInstances: [
      { id: "a", enabled: false, gatewayPort: 8791, httpUrl: localUrl(3001) },
      { id: "b", enabled: false, gatewayPort: 8792, httpUrl: localUrl(3002) }
    ]
  }));

  const resolved = resolvePrimaryNapCatInstance(gateway(), instances);

  assert.equal(resolved.primaryIndex, 0);
  assert.equal(resolved.primary?.id, "a");
});

test("NapCat invalid ports are rejected", () => {
  assert.throws(
    () => normalizeNapCatInstances(gateway({ napcatInstances: [{ id: "bad", gatewayPort: 70000, httpUrl: localUrl(3000) }] })),
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
        { id: "a1", gatewayPort: 8790, httpUrl: localUrl(3000), webuiUrl: localUrl(6099, "/webui"), accessToken: "a1" },
        { id: "a2", gatewayPort: 8790, httpUrl: localUrl(3000), webuiUrl: localUrl(6100, "/webui"), accessToken: "a2" }
      ]
    }),
    gateway({
      id: "Rabi__b",
      gatewayPort: 8790,
      messageAdapters: ["napcat", "webhook"],
      webhookPort: 8790,
      napcatInstances: [
        { id: "b1", gatewayPort: 8790, httpUrl: localUrl(3000), webuiUrl: localUrl(6101, "/webui"), accessToken: "b1" }
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
        { id: "a1", gatewayPort: 8791, httpUrl: localUrl(3001) },
        { id: "a2", enabled: false, gatewayPort: 8792, httpUrl: localUrl(3002) }
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
      gateway({ id: "Rabi__a", gatewayPort: 8791, napcatInstances: [{ id: "a", gatewayPort: 8791, httpUrl: localUrl(3000) }] }),
      gateway({ id: "Rabi__b", gatewayPort: 8792, napcatInstances: [{ id: "b", gatewayPort: 8792, httpUrl: localUrl(3000) }] })
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
    allowedSpeakerNames: [],
    regex: "",
    schedules: undefined,
    template: "a\nb"
  });
});
