import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGatewayDefinition, type GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { assertAgentSendPermission } from "./agentSendPermission.js";
import type { TrustedLanAgentSource } from "./lanAgentBodyAuthority.js";

function route(overrides: Partial<GatewayDefinition> = {}): GatewayDefinition {
  const definition = {
    id: "route-main",
    gatewayPort: 8789,
    agentAdapters: ["codex"],
    primaryAgentAdapter: "codex",
    codexThreadId: "primary-1",
    codexHooks: { onlyPrimaryPersonaCanSendMessages: false },
    ...overrides
  } as GatewayDefinition;
  definition.gatewayPort ??= 8789;
  return definition;
}

test("Codex personas can all send by default", () => {
  assert.doesNotThrow(() => assertAgentSendPermission({ agentType: "plan_agent", sessionId: "plan-1" }, route()));
});

test("enabled Codex Hook accepts only the configured primary persona session", () => {
  const definition = route({ codexHooks: { onlyPrimaryPersonaCanSendMessages: true } as GatewayDefinition["codexHooks"] });
  assert.doesNotThrow(() => assertAgentSendPermission({ agentType: "primary_persona", sessionId: "primary-1" }, definition));
  assert.throws(
    () => assertAgentSendPermission({ agentType: "plan_secretary", sessionId: "secretary-1" }, definition),
    /Only the configured Codex primary persona session/i
  );
  assert.throws(
    () => assertAgentSendPermission({ agentType: "primary_persona", sessionId: "secretary-1" }, definition),
    /Only the configured Codex primary persona session/i
  );
});

test("the Codex-only Hook does not affect another primary Agent adapter", () => {
  const definition = route({
    agentAdapters: ["copilotCli", "codex"],
    primaryAgentAdapter: "copilotCli",
    codexHooks: { onlyPrimaryPersonaCanSendMessages: true } as GatewayDefinition["codexHooks"]
  });
  assert.doesNotThrow(() => assertAgentSendPermission({ agentType: "plan_agent", sessionId: "plan-1" }, definition));
});

test("enabled DSH Hook accepts only the configured DSH primary persona session", () => {
  const definition = route({
    agentAdapters: ["dsh"],
    primaryAgentAdapter: "dsh",
    dshSessionId: "session-primary",
    codexHooks: { onlyPrimaryPersonaCanSendMessages: true } as GatewayDefinition["codexHooks"]
  });
  assert.doesNotThrow(() => assertAgentSendPermission({ agentType: "primary_persona", sessionId: "session-primary" }, definition));
  assert.throws(
    () => assertAgentSendPermission({ agentType: "plan_secretary", sessionId: "session-secretary" }, definition),
    /Only the configured DSH primary persona session/i
  );
});

test("enabled Antigravity Hook accepts only the configured Antigravity primary persona session", () => {
  // The Hook used to be gated on `primaryAdapter` being literally codex or dsh,
  // which silently disabled the restriction for Antigravity and read the wrong
  // session field. Both are now derived from the adapter.
  const definition = route({
    agentAdapters: ["antigravity"],
    primaryAgentAdapter: "antigravity",
    antigravityConversationId: "a1e8f5ce-7e09-47d2-833f-ea27f532810b",
    codexHooks: { onlyPrimaryPersonaCanSendMessages: true } as GatewayDefinition["codexHooks"]
  });
  assert.doesNotThrow(() => assertAgentSendPermission({
    agentType: "primary_persona",
    sessionId: "a1e8f5ce-7e09-47d2-833f-ea27f532810b"
  }, definition));
  assert.throws(
    () => assertAgentSendPermission({ agentType: "plan_secretary", sessionId: "secretary-1" }, definition),
    /Only the configured Antigravity primary persona session/i
  );
  // A Codex task id must not pass as an Antigravity conversation id.
  assert.throws(
    () => assertAgentSendPermission({ agentType: "primary_persona", sessionId: "primary-1" }, definition),
    /Only the configured Antigravity primary persona session/i
  );
});

for (const provider of ["codex", "dsh"] as const) {
  test(`${provider} remote primary permission requires the exact approved principal and Route binding`, () => {
    const remote: TrustedLanAgentSource = {
      nodeId: "remote-node", agentId: "remote-agent", provider,
      sessionId: "primary-1", sessionName: "Remote primary"
    };
    const definition = route({
      primaryAgentAdapter: provider,
      agentAdapters: [provider],
      dshSessionId: "primary-1",
      codexHooks: { onlyPrimaryPersonaCanSendMessages: true } as GatewayDefinition["codexHooks"]
    });
    const sender = { agentType: "primary_persona", sessionId: "primary-1" };
    const denied = /Only the configured .* primary persona session/i;
    // A colliding local session ID never grants a remote principal local authority.
    assert.throws(() => assertAgentSendPermission(sender, definition, remote), denied);
    definition.remoteAgentTargets = [{ id: "remote:remote-node:remote-agent", provider, instanceId: remote.nodeId, agentId: remote.agentId }];
    definition.primaryAgentTarget = "remote:remote-node:remote-agent";
    assert.doesNotThrow(() => assertAgentSendPermission(sender, definition, remote));
    for (const mismatch of [
      { nodeId: "other-node" }, { agentId: "other-agent" },
      { sessionId: "other-session" }, { sessionId: "" },
      { provider: provider === "codex" ? "dsh" as const : "codex" as const }
    ]) {
      assert.throws(() => assertAgentSendPermission(sender, definition, { ...remote, ...mismatch }), denied);
    }
    assert.throws(() => assertAgentSendPermission({ ...sender, sessionId: "other-session" }, definition, remote), denied);
    assert.throws(() => assertAgentSendPermission({ ...sender, agentType: "plan_agent" }, definition, remote), denied);
    // Remote primary sessions need not share the local primary's bare ID.
    const differentRemote = { ...remote, sessionId: "remote-primary" };
    assert.doesNotThrow(() => assertAgentSendPermission({ ...sender, sessionId: differentRemote.sessionId }, definition, differentRemote));
    assert.throws(() => assertAgentSendPermission(sender, definition), denied);
    definition.primaryAgentTarget = "";
    assert.throws(() => assertAgentSendPermission(sender, definition), /not configured/);
  });
}

test("the Route configuration enables this setting for managed primary Agents", () => {
  assert.equal(normalizeGatewayDefinition({
    id: "codex-route",
    gatewayPort: 8801,
    agentAdapters: ["codex"],
    primaryAgentAdapter: "codex"
  }).codexHooks?.onlyPrimaryPersonaCanSendMessages, false);

  assert.equal(normalizeGatewayDefinition({
    id: "secondary-codex-route",
    gatewayPort: 8802,
    agentAdapters: ["copilotCli", "codex"],
    primaryAgentAdapter: "copilotCli",
    codexHooks: {
      sessionContextEnabled: true,
      reasoningContextEnabled: true,
      planTaskCompletionEnabled: true,
      agentCommunicationEnforcementEnabled: true,
      onlyPrimaryPersonaCanSendMessages: true
    }
  }).codexHooks, undefined);

  assert.equal(normalizeGatewayDefinition({
    id: "dsh-route",
    gatewayPort: 8805,
    agentAdapters: ["dsh"],
    primaryAgentAdapter: "dsh",
    dshSessionId: "session-00000000-0000-4000-8000-000000000001",
    dshCwd: "C:/Project",
    codexHooks: { onlyPrimaryPersonaCanSendMessages: true } as GatewayDefinition["codexHooks"]
  }).codexHooks?.onlyPrimaryPersonaCanSendMessages, true);
});

test("the removed Route-level setting cannot enable the Hook", () => {
  const normalized = normalizeGatewayDefinition({
    id: "legacy-route",
    gatewayPort: 8804,
    agentAdapters: ["codex"],
    primaryAgentAdapter: "codex",
    codexOnlyPrimaryPersonaCanSendMessages: true
  } as unknown as GatewayDefinition);
  assert.equal(normalized.codexHooks?.onlyPrimaryPersonaCanSendMessages, false);
  assert.equal("codexOnlyPrimaryPersonaCanSendMessages" in normalized, false);
});
