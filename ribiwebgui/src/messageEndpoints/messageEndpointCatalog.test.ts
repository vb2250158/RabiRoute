import assert from "node:assert/strict";
import test from "node:test";
import { registerTrustedWebSettingsRenderer, resolveWebSettingsCatalog } from "../pluginRenderers";
import { availableWebContributions } from "../pluginContributions";
import type { WebPluginCatalog } from "../pluginCatalogClient";
import { gatewayEndpointTypesForWebCatalog, messageEndpointCatalog, messageEndpointGroups } from "./messageEndpointCatalog";

function register(type: string) {
  return registerTrustedWebSettingsRenderer({
    instanceId: `test:${type}`, pluginId: `io.test.${type}`, rendererId: `test.endpoint.${type}`,
    placementId: "route.adapters.message-endpoint-settings", allowedSlots: [type],
    contributionKind: "message-endpoint-settings", contributionSurface: "route.adapters",
    schemaId: `test.${type}.route`, readCommandId: `test.${type}.read`, writeCommandId: `test.${type}.write`,
    loader: async () => ({ template: "<div />" })
  });
}
function contribution(type: string) {
  return {
    kind: "message-endpoint-settings", instanceId: `test:${type}`, pluginId: `io.test.${type}`,
    id: `${type}-card`, hosts: ["web"], surface: "route.adapters", slot: type,
    rendererId: `test.endpoint.${type}`, schemaId: `test.${type}.route`,
    readCommandId: `test.${type}.read`, writeCommandId: `test.${type}.write`, endpointType: type,
    catalog: { title: type, note: "Plugin owned card", icon: "mdi-message", order: 0, group: { id: "chat", title: "Chat", note: "Chat endpoints", order: 0 } }
  };
}
function plugin(type: string, status = "active") {
  return { instanceId: `test:${type}`, pluginId: `io.test.${type}`, status, manifest: { id: `io.test.${type}`, hosts: ["web"] } };
}
test("disabled endpoint removes only its add entry and preserves the configured unavailable card", () => {
  const cleanup = [register("napcat"), register("wecom")];
  try {
    const configured = { messageAdapters: ["napcat", "wecom"], messageAdapterPolicies: { napcat: { inputEnabled: true }, wecom: { outputEnabled: false } }, wecomBotId: "original-account" } as const;
    const before = JSON.stringify(configured);
    const catalog = { plugins: [plugin("napcat"), plugin("wecom", "disabled")], contributions: [contribution("napcat"), contribution("wecom")] } as unknown as WebPluginCatalog;
    const entries = messageEndpointCatalog(resolveWebSettingsCatalog(availableWebContributions(catalog)));
    assert.deepEqual(entries.map(item => item.type), ["napcat"]);
    const groups = messageEndpointGroups(entries, [...configured.messageAdapters]);
    assert.equal(groups.flatMap(group => group.choices).find(item => item.type === "wecom")?.available, false);
    assert.equal(JSON.stringify(configured), before);
  } finally { cleanup.forEach(dispose => dispose()); }
});
test("a bad endpoint contribution cannot hide an unrelated valid endpoint or impersonate another card", () => {
  const cleanup = [register("napcat"), register("wecom")];
  try {
    const bad = { ...contribution("wecom"), endpointType: "napcat" };
    const entries = messageEndpointCatalog(resolveWebSettingsCatalog([contribution("napcat"), bad]));
    assert.deepEqual(entries.map(item => item.type), ["napcat"]);
    assert.deepEqual(messageEndpointCatalog(resolveWebSettingsCatalog([contribution("napcat"), { ...contribution("wecom"), catalog: { ...contribution("wecom").catalog, group: { id: "bad" } } }])).map(item => item.type), ["napcat"]);
  } finally { cleanup.forEach(dispose => dispose()); }
});

test("resident Gateway requirements follow actual active manifest hosts and trusted card ownership for open endpoint types", () => {
  const cleanup = [register("third-party-chat"), register("third-party-device"), register("disabled-chat")];
  try {
    const gateway = { ...plugin("third-party-chat"), manifest: { id: "io.test.third-party-chat", hosts: ["manager", "gateway", "web"], capabilities: ["endpoint.third-party-chat@1"] } };
    const manager = { ...plugin("third-party-device"), manifest: { id: "io.test.third-party-device", hosts: ["manager", "web"], capabilities: ["endpoint.third-party-device@1"] } };
    const disabled = { ...plugin("disabled-chat", "inactive"), manifest: { id: "io.test.disabled-chat", hosts: ["gateway", "web"], capabilities: ["endpoint.disabled-chat@1"] } };
    const catalog = { plugins: [gateway, manager, disabled], contributions: [contribution("third-party-chat"), contribution("third-party-device"), contribution("disabled-chat")] } as unknown as WebPluginCatalog;
    const renderers = resolveWebSettingsCatalog(availableWebContributions(catalog));
    const types = gatewayEndpointTypesForWebCatalog(catalog.plugins, renderers);
    assert.deepEqual([...types], ["third-party-chat"]);
    assert.deepEqual([...gatewayEndpointTypesForWebCatalog([], renderers)], [], "an unloaded catalog cannot invent a resident runtime requirement");
    const configured = ["third-party-chat", "third-party-device", "unknown-retired", "disabled-chat"];
    const groups = messageEndpointGroups(messageEndpointCatalog(renderers), configured);
    assert.equal(groups.flatMap(group => group.choices).find(choice => choice.type === "unknown-retired")?.available, false);
    assert.deepEqual(configured, ["third-party-chat", "third-party-device", "unknown-retired", "disabled-chat"]);
  } finally { cleanup.forEach(dispose => dispose()); }
});


test("the retired timer is neither an add choice nor an unavailable connector card", () => {
  const cleanup = [register("napcat"), register("heartbeat")];
  try {
    const renderers = resolveWebSettingsCatalog([contribution("napcat"), contribution("heartbeat")]);
    const entries = messageEndpointCatalog(renderers);
    assert.deepEqual(entries.map(item => item.type), ["napcat"]);
    const configured = ["napcat", "heartbeat", "unknown-chat"];
    const groups = messageEndpointGroups(entries, configured);
    assert.deepEqual(groups.flatMap(item => item.choices).map(item => item.type), ["napcat", "unknown-chat"]);
    assert.deepEqual(configured, ["napcat", "heartbeat", "unknown-chat"], "historical configuration is not deleted by rendering");
  } finally { cleanup.forEach(dispose => dispose()); }
});


test("scheduled automation requires only its active native worker, never a connector card", () => {
  const worker = { ...plugin("heartbeat"), manifest: { id: "io.test.heartbeat", hosts: ["manager", "gateway"], capabilities: ["endpoint.heartbeat@1"] } } as unknown as WebPluginCatalog["plugins"][number];
  assert.deepEqual([...gatewayEndpointTypesForWebCatalog([worker], [])], ["heartbeat"]);
  assert.deepEqual([...gatewayEndpointTypesForWebCatalog([{ ...worker, status: "inactive" }], [])], []);
  assert.deepEqual(messageEndpointCatalog([]), []);
});
