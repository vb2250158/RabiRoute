import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { registeredWebSettingsRenderers, registerTrustedWebSettingsRenderer } from "../src/pluginRenderers";
import type { AgentWebModuleApi } from "../src/agentAdapters/registerAgentAdapterRenderer";
import type { GatewayDefinition } from "../src/types";

const packages = [
  ["codex", "codex", "Codex"], ["copilotCli", "copilot-cli", "CopilotCli"], ["marvis", "marvis", "Marvis"],
  ["astrbot", "astrbot", "Astrbot"], ["dsh", "dsh", "Dsh"], ["workbuddy", "workbuddy", "Workbuddy"],
  ["antigravity", "antigravity", "Antigravity"], ["deviceAgent", "device-agent", "Device"], ["grokBot", "grok-bot", "GrokBot"]
] as const;

test("all nine Agent Web entries register and retire only their own real lazy card", async t => {
  const disposers: Array<() => void> = [];
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); });
  for (const [type, slug, card] of packages) {
    const instanceId = `agent:${slug}`, pluginId = `io.rabiroute.agent.${slug}`;
    const packageRoot = new URL(`../../plugins/builtin/${pluginId}/1.0.0/`, import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(new URL("rabi.plugin.json", packageRoot), "utf8"));
    assert.deepEqual(manifest.entries.web, { execution: "in_process", module: "./web/client.mjs" },
      "the published Web entry must point directly at the generated asset wrapper");
    assert.equal(fs.existsSync(new URL("web.mjs", packageRoot)), false, "no redundant Web entry forwarding layer");
    const api: AgentWebModuleApi = { instanceIds: [instanceId], forInstance: () => ({ registerSettingsRenderer: input =>
      registerTrustedWebSettingsRenderer({ ...input, instanceId, pluginId }) }) };
    const module = await import(`../src/bundles/agents/${slug}`);
    disposers.push(module.activate(api));
    const registration = registeredWebSettingsRenderers().find(item => item.instanceId === instanceId)!;
    assert.equal(registration.rendererId, `agent.${type}.card.v1`);
    assert.equal(registration.contributionKind, "agent-adapter-settings");
    assert.deepEqual(registration.allowedSlots, [type]);
    const source = fs.readFileSync(new URL(`../src/bundles/agents/${slug}.ts`, import.meta.url), "utf8");
    assert.ok(source.includes(`import("../../agentAdapters/${card}AgentCard.vue")`));
    assert.equal(typeof registration.component, "object");
  }
  assert.equal(registeredWebSettingsRenderers().length, 9);
  const route: GatewayDefinition = { id: "route", gatewayPort: 0, codexThreadId: "codex-id", codexThreadName: "Codex name", codexCwd: "D:/Codex",
    dshSessionId: "dsh-id", dshSessionName: "DSH name", dshCwd: "D:/DSH", dshBaseUrl: "http://localhost:3333",
    workbuddySessionId: "workbuddy-id", workbuddySessionName: "WorkBuddy name", workbuddyCwd: "D:/WorkBuddy",
    antigravityConversationId: "antigravity-id", antigravityConversationName: "Antigravity name", antigravityCwd: "D:/Antigravity" };
  const before = structuredClone(route);
  for (const slug of ["codex", "dsh", "workbuddy", "antigravity"]) {
    const registration = registeredWebSettingsRenderers().find(item => item.instanceId === `agent:${slug}`)!;
    assert.equal(registration.agentRoute?.session?.(route).sessionId, `${slug}-id`);
  }
  assert.deepEqual(route, before);
  const copilot = registeredWebSettingsRenderers().find(item => item.instanceId === "agent:copilot-cli")!;
  const warnings = copilot.agentRoute!.warnings!({ ...route, copilotCwd: "D:/Expected", copilotThreadName: "Saved" }, {
    type: "copilotCli", label: "Copilot", maturity: "experimental", installed: true, sessions: [{ id: "task", name: "Saved", projectPath: "D:/Other" }]
  });
  assert.ok(warnings.some(warning => warning.includes("D:/Other")));
  disposers[0]();
  assert.equal(registeredWebSettingsRenderers().length, 8);
  assert.equal(registeredWebSettingsRenderers().some(item => item.instanceId === "agent:dsh"), true);
});

test("Route renders contributed cards and retains the original target and primary owners", () => {
  const page = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
  assert.match(page, /configuredAgentRows\(agentDefs\.value, agentTypes\.value\)/);
  assert.match(page, /<AgentAdapterCardHost :renderer="agent\.renderer" :context="agentCardContext\(agent\.type\)"/);
  assert.doesNotMatch(page, /v-model="gateway\.(?:astrbotPassword|copilotCliBin|marvisAppId|dshSessionId|workbuddyEndpoint|antigravityConversationId)"/);
  assert.match(page, /selectRouteAgent\(gateway\.value, value\)/);
  assert.match(page, /remoteAgentTargetKey\(\{ instanceId: instance\.instanceId, agentId: remote\.agentId, ownerDeviceId: instance\.ownerDeviceId \}\)/);
  assert.match(page, /manifest\.capabilities\.managedTasks\?\.\[feature\] === true/);
  assert.doesNotMatch(page, /gateway\.value\.(?:dshSessionId|workbuddySessionId|antigravityConversationId|astrbotPassword|copilotThreadName)/);
  assert.ok(page.indexOf("watch(() => [gateway.value?.id, agentDefs.value.map") > page.indexOf("const agentDefs ="), "the catalog watcher must not enter an uninitialized setup binding");
  assert.match(page, /v-if="agentCardOpened\[agent\.type\] \|\| agentParamOpen\[agent\.type\]" v-show="agentParamOpen\[agent\.type\]"/);
});

test("each card retains its original saved fields and session selection handlers", () => {
  const fields: Record<string, string[]> = {
    Codex: ["codexThreadId", "codexThreadName", "codexCwd", "agentModel", "agentReasoningEffort", "selectCodexSession"],
    Dsh: ["dshSessionId", "dshSessionName", "dshCwd", "dshBaseUrl", "dshAgentPreset", "dshModelProvider", "dshModel", "dshReasoningEffort", "selectDshSession"],
    GrokBot: ["grokBotAgentId", "selectGrokBotRoutePersona"],
    CopilotCli: ["copilotCliBin", "copilotThreadName", "copilotCwd", "selectCopilotSession"],
    Marvis: ["marvisAppId", "openMarvis"],
    Astrbot: ["astrbotUrl", "astrbotUsername", "astrbotPassword", "astrbotProjectId", "astrbotSessionId", "testAstrbotLogin"],
    Workbuddy: ["workbuddySessionId", "workbuddySessionName", "workbuddyCwd", "workbuddyEndpoint", "selectWorkbuddySession"],
    Antigravity: ["antigravityConversationId", "antigravityConversationName", "antigravityCwd", "selectAntigravitySession"]
  };
  for (const [card, names] of Object.entries(fields)) {
    const source = fs.readFileSync(new URL(`../src/agentAdapters/${card}AgentCard.vue`, import.meta.url), "utf8");
    for (const name of names) assert.ok(source.includes(name), `${card} lost ${name}`);
    assert.match(source, /store\.selectedGateway\?\.id === props\.context\.routeId/);
  }
});
