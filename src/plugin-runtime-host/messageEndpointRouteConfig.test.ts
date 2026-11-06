import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { classifyRouteChange, endpointRouteInputs, endpointRouteProjection, inheritedEndpointFields, mergeEndpointRouteDeclarations, readEndpointRouteDeclarations, readInstalledEndpointRouteDeclarations, type EndpointRouteConfigDeclaration } from "./messageEndpointRouteConfig.js";
import { parsePluginProfile } from "../plugin-kernel/profile.js";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import { scopeMessageEndpointHostPorts } from "../runtime/messageEndpointHostPorts.js";
import { canonicalPluginSourceFixture } from "../manager/canonicalPluginSource.fixture.js";

const types = ["napcat", "heartbeat", "wecom", "weixin", "feishu", "webhook", "rabilink"];
const environment: Record<string, string> = {
  gatewayPort: "GATEWAY_PORT", napcatInstances: "NAPCAT_INSTANCES", napcatHttpUrl: "NAPCAT_HTTP_URL", napcatWebuiUrl: "NAPCAT_WEBUI_URL", napcatAccessToken: "NAPCAT_ACCESS_TOKEN", napcatWebuiToken: "NAPCAT_WEBUI_TOKEN",
  heartbeatIntervalSeconds: "HEARTBEAT_INTERVAL_SECONDS", heartbeatMessage: "HEARTBEAT_MESSAGE", heartbeatSkipWhenAgentBusy: "HEARTBEAT_SKIP_WHEN_AGENT_BUSY",
  wecomBotId: "WECOM_BOT_ID", wecomBotSecret: "WECOM_BOT_SECRET", wecomWsUrl: "WECOM_WS_URL", weixinBaseUrl: "WEIXIN_BASE_URL", weixinBotType: "WEIXIN_BOT_TYPE",
  feishuAppId: "FEISHU_APP_ID", feishuAppSecret: "FEISHU_APP_SECRET", feishuVerificationToken: "FEISHU_VERIFICATION_TOKEN", feishuEncryptKey: "FEISHU_ENCRYPT_KEY", feishuEventSubscriptionEnabled: "FEISHU_EVENT_SUBSCRIPTION_ENABLED", feishuWebhookPort: "FEISHU_WEBHOOK_PORT", feishuWebhookPath: "FEISHU_WEBHOOK_PATH",
  webhookPort: "WEBHOOK_PORT", webhookPath: "WEBHOOK_PATH", rabiLinkWebhookPort: "RABILINK_WEBHOOK_PORT", rabiLinkWebhookPath: "RABILINK_WEBHOOK_PATH", rabiLinkWebhookHost: "RABILINK_WEBHOOK_HOST"
};

test("disabled field ownership is read as metadata and an active immutable owner takes precedence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "disabled-endpoint-declaration-"));
  try {
    await fs.writeFile(path.join(root, "gateway.mjs"), 'throw new Error("Declaration reads must never execute this platform module.");');
    const installed: EndpointRouteConfigDeclaration = {endpointType: "heartbeat", routeKeys: ["heartbeatMessage"], runtimeFields: {heartbeatMessage: {paths: ["heartbeatMessage"], default: "default"}}};
    await fs.writeFile(path.join(root, "route-config.json"), JSON.stringify(installed));
    const profile = parsePluginProfile({schemaVersion: 2, readyRequires: [], instances: [
      {id: "heartbeat", package: "org.example.heartbeat", version: "1.0.0", enabled: false},
      {id: "broken", package: "org.example.broken", version: "1.0.0", enabled: false}
    ]});
    const readManifest = async (id: string) => {
      if (id === "org.example.broken") throw new Error("Broken installed manifest.");
      return parsePluginManifest({schemaVersion: 2, id, version: "1.0.0", entries: {gateway: {execution: "in_process", module: "./gateway.mjs"}}, provides: ["endpoint.heartbeat@1"], requires: [], optional: [], permissions: []});
    };
    const result = await readInstalledEndpointRouteDeclarations(profile, {resolve: async () => ({sourceRoot: root, inProcessTrusted: true})}, readManifest);
    assert.deepEqual(result.declarations, [installed]);
    assert.deepEqual(result.diagnostics.map(item => item.instanceId), ["broken"]);
    assert.equal(classifyRouteChange({heartbeatMessage: "before"}, {heartbeatMessage: "after"}, mergeEndpointRouteDeclarations([], result.declarations)).kind, "endpoint");
    const active = {...installed, runtimeFields: {heartbeatMessage: {paths: ["heartbeatMessage"], default: "immutable prior default"}}};
    assert.equal(mergeEndpointRouteDeclarations([active], result.declarations)[0], active);
    await fs.writeFile(path.join(root, "route-config.json"), JSON.stringify({...installed, endpointType: "unrelated"}));
    const mismatched = await readInstalledEndpointRouteDeclarations({...profile, instances: profile.instances.slice(0, 1)}, {resolve: async () => ({sourceRoot: root, inProcessTrusted: true})}, readManifest);
    assert.deepEqual(mismatched.declarations, []);
    assert.equal(mismatched.diagnostics[0]?.instanceId, "heartbeat");
    const invalidJson = '{"default":"PRIVATE_DECLARATION_SENTINEL", BROKEN}';
    await fs.writeFile(path.join(root, "route-config.json"), invalidJson);
    const installedBad = await readInstalledEndpointRouteDeclarations({...profile, instances: profile.instances.slice(0, 1)}, {resolve: async () => ({sourceRoot: root, inProcessTrusted: true})}, readManifest);
    const activeBad = await readEndpointRouteDeclarations([{instance: {id: "heartbeat"}, package: {runtimeRoot: root, manifest: await readManifest("org.example.heartbeat")}}]);
    for (const failure of [installedBad, activeBad]) {
      assert.deepEqual(failure.declarations, []);
      assert.deepEqual(failure.diagnostics, [{instanceId: "heartbeat", message: "Invalid endpoint Route declaration JSON."}]);
      assert.doesNotMatch(JSON.stringify(failure.diagnostics), /PRIVATE_DECLARATION_SENTINEL/);
    }
    assert.equal(await fs.readFile(path.join(root, "route-config.json"), "utf8"), invalidJson);
  } finally {await fs.rm(root, {recursive: true, force: true});}
});

test("seven package projections preserve actual config parser facts and scope future empty/false/zero changes", async () => {
  const declarations = await Promise.all(types.map(async type => {
    const source = await canonicalPluginSourceFixture(`io.rabiroute.endpoint.${type}`);
    return JSON.parse(await fs.readFile(path.join(source.directory, "route-config.json"), "utf8")) as EndpointRouteConfigDeclaration;
  }));
  const original = Object.fromEntries(Object.values(environment).map(key => [key, process.env[key]]));
  // @ts-expect-error The endpoint owns this pure JavaScript projection artifact.
  const napcatProject = (await import("../plugins/io.rabiroute.endpoint.napcat/route-config.mjs")).projectRouteTransport;
  const rows: Record<string, unknown>[] = [
    {gatewayPort: 9010},
    {gatewayPort: 9010, napcatInstances: [], napcatAccessToken: "", webhookPort: 0, webhookPath: "", rabiLinkWebhookHost: " ", rabiLinkWebhookPort: 0, rabiLinkWebhookPath: "", heartbeatIntervalSeconds: 0, heartbeatMessage: "", heartbeatSkipWhenAgentBusy: false, feishuWebhookPath: " ", feishuWebhookPort: 0, feishuEventSubscriptionEnabled: false, weixinBaseUrl: " ", weixinBotType: "", wecomBotSecret: ""},
    {gatewayPort: 9010, napcatInstances: [{id: "a b", gatewayPort: 9011, httpUrl: "http://localhost:3001", accessToken: "test-only", enabled: false}, {id: "active", gatewayPort: 9012}], webhookPort: 9013, rabiLinkWebhookPath: "/mobile", feishuWebhookPort: 9014, heartbeatIntervalSeconds: 5, heartbeatSkipWhenAgentBusy: true, wecomBotSecret: "  test-only  ", feishuAppSecret: "  test-only  ", weixinBotType: "  7  "}
  ];
  try {
    for (const [index, row] of rows.entries()) {
      for (const key of Object.values(environment)) delete process.env[key];
      // Boot may inherit configured environment credentials and legacy defaults.
      process.env.WECOM_BOT_SECRET = "environment-test-only";
      for (const [field, value] of Object.entries(row)) process.env[environment[field]!] = typeof value === "object" ? JSON.stringify(value)
        : field === "rabiLinkWebhookHost" ? String(value).trim() || "0.0.0.0" : String(value);
      const boot = (await import(pathToFileURL(path.resolve("src/config.ts")).href + `?endpointProjection=${index}`)).config as Record<string, unknown>;
      const shared = {prepareModules: async () => {}, assertModules() {}, module<T>() { return {config: boot} as T; }};
      for (const declaration of declarations) {
        const projected = endpointRouteProjection(row, declaration);
        const inherited = inheritedEndpointFields(row, row, declaration);
        const activation = {__routeTransport: projected, __routeTransportInputs: endpointRouteInputs(row, declaration), __routeInheritedFields: inherited};
        const effective = declaration.endpointType === "napcat" ? napcatProject(activation, boot) : projected;
        const scoped = scopeMessageEndpointHostPorts(shared, effective, declaration.endpointType === "napcat" ? [] : inherited).module<{config: Record<string, unknown>}>("config").config;
        for (const field of Object.keys(declaration.runtimeFields)) assert.deepEqual(scoped[field], boot[field], `${declaration.endpointType}.${field} boot parser row ${index}`);
        // Changed fields must also match the parser without using boot inheritance.
        const changedInheritance = inheritedEndpointFields({gatewayPort: 9010}, row, declaration);
        const changedActivation = {...activation, __routeInheritedFields: changedInheritance};
        const changedTransport = declaration.endpointType === "napcat" ? napcatProject(changedActivation, boot) : projected;
        const changed = scopeMessageEndpointHostPorts(shared, changedTransport, declaration.endpointType === "napcat" ? [] : changedInheritance).module<{config: Record<string, unknown>}>("config").config;
        for (const [field, mapping] of Object.entries(declaration.runtimeFields)) {
          if (mapping.paths.some(key => key !== "gatewayPort" && Object.hasOwn(row, key))) assert.deepEqual(changed[field], boot[field], `${declaration.endpointType}.${field} changed parser row ${index}`);
        }
      }
    }
    const bootRoute = {gatewayPort: 9010, wecomBotSecret: "old-test-only", heartbeatIntervalSeconds: 30, heartbeatSkipWhenAgentBusy: true};
    const nextRoute = {...bootRoute, wecomBotSecret: "", heartbeatIntervalSeconds: 0, heartbeatSkipWhenAgentBusy: false, webhookPort: 0, webhookPath: ""};
    const change = classifyRouteChange(bootRoute, nextRoute, declarations);
    assert.equal(change.kind, "endpoint");
    assert.ok(change.endpointTypes.includes("wecom") && change.endpointTypes.includes("heartbeat") && change.endpointTypes.includes("webhook"));
    const wecom = declarations.find(item => item.endpointType === "wecom")!;
    const effective = scopeMessageEndpointHostPorts({prepareModules: async () => {}, assertModules() {}, module<T>() {return {config: {wecomBotSecret: "old-test-only", botNickname: "first"}} as T;}},
      endpointRouteProjection(nextRoute, wecom), inheritedEndpointFields(bootRoute, nextRoute, wecom)).module<{config: Record<string, unknown>}>("config").config;
    assert.equal(effective.wecomBotSecret, "", "Explicit secret removal cannot fall back to the boot credential.");
    assert.throws(() => {effective.wecomBotSecret = "mutated";}, /read-only/);
    assert.equal(endpointRouteProjection(nextRoute, declarations.find(item => item.endpointType === "webhook")!).webhookPort, 0);
    assert.equal(endpointRouteProjection(nextRoute, declarations.find(item => item.endpointType === "heartbeat")!).heartbeatIntervalSeconds, 900);
    assert.equal(endpointRouteProjection(nextRoute, declarations.find(item => item.endpointType === "heartbeat")!).heartbeatSkipWhenAgentBusy, false);
    assert.equal(classifyRouteChange(bootRoute, {...bootRoute, unknownPluginField: "new"}, declarations).kind, "shared");
  } finally {for (const [key, value] of Object.entries(original)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}}
});
