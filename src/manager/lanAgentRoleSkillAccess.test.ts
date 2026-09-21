import assert from "node:assert/strict";
import test from "node:test";
import { authorizeLanAgentRoleSkillRead } from "./lanAgentRoleSkillAccess.js";
import { remoteAgentTargetKey, type RouteAgentTargetsDefinition } from "../shared/routeAgentTargets.js";
import type { LanAgentRequestAccess } from "./lanAgentRequestAccess.js";

type Definition = RouteAgentTargetsDefinition & { persona: string };
const principal = { kind: "agent", nodeId: "node-a", agentId: "agent-a" } as const;
const roleIdForDefinition = (definition: Definition) => definition.persona;
function route(persona: string, instanceId = "node-a", agentId = "agent-a"): Definition {
  const binding = { instanceId, agentId };
  return { persona, remoteAgentTargets: [{ ...binding, id: remoteAgentTargetKey(binding), provider: "codex" }] };
}
function allowed(access: LanAgentRequestAccess, roleId: string, definitions: Definition[]) {
  return authorizeLanAgentRoleSkillRead(access, roleId, definitions, roleIdForDefinition);
}

test("configured persona allows all its Skills without a second per-Skill grant", () => {
  assert.deepEqual(allowed(principal, "persona-a", [route("persona-a")]), { allowed: true });
  // A secondary target is still configured, not only the selected primary target.
  const definition = { ...route("persona-a"), agentAdapters: ["dsh" as const], primaryAgentTarget: "local:dsh" };
  assert.deepEqual(allowed(principal, "persona-a", [definition]), { allowed: true });
  assert.deepEqual(allowed(principal, "persona-b", [route("persona-a"), route("persona-b")]), { allowed: true });
});

test("missing configuration and cross-persona requests fail closed", () => {
  for (const definitions of [[], [route("persona-b")]]) {
    assert.deepEqual(allowed(principal, "persona-a", definitions), {
      allowed: false, status: 403, error: "LAN_AGENT_PERSONA_NOT_CONFIGURED"
    });
  }
  assert.equal(allowed(principal, "Persona-a", [route("persona-a")]).allowed, false);
  assert.equal(allowed(principal, "", [route("")]).allowed, false);
});

test("node and Agent opaque identities both match exactly; same names do not grant access", () => {
  assert.equal(allowed(principal, "persona-a", [route("persona-a", "node-b", "agent-a")]).allowed, false);
  assert.equal(allowed(principal, "persona-a", [route("persona-a", "node-a", "agent-b")]).allowed, false);
  assert.equal(allowed({ ...principal, nodeId: "NODE-A" }, "persona-a", [route("persona-a")]).allowed, false);
  assert.equal(allowed({ ...principal, agentId: "" }, "persona-a", [route("persona-a")]).allowed, false);
});

test("current catalog is evaluated per read; removing a binding immediately revokes access", () => {
  const definitions = [route("persona-a")];
  assert.equal(allowed(principal, "persona-a", definitions).allowed, true);
  definitions[0] = route("persona-a", "node-b");
  assert.equal(allowed(principal, "persona-a", definitions).allowed, false);
});

test("legacy target migration reuses the shared normalizer, without a second binding store", () => {
  const definition: Definition = { persona: "persona-a", agentInstanceBindings: { codex: { instanceId: "node-a", agentId: "agent-a" } } };
  assert.equal(allowed(principal, "persona-a", [definition]).allowed, true);
  assert.equal(allowed({ ...principal, nodeId: "node-b" }, "persona-a", [definition]).allowed, false);
});

test("local management keeps its existing authentication and denied principals stay denied", () => {
  assert.deepEqual(allowed({ kind: "unrelated" }, "persona-a", []), { allowed: true });
  assert.deepEqual(allowed({ kind: "denied", status: 401, error: "LAN_AGENT_CREDENTIAL_REQUIRED" }, "persona-a", [route("persona-a")]), {
    allowed: false, status: 401, error: "LAN_AGENT_CREDENTIAL_REQUIRED"
  });
  assert.deepEqual(allowed({ kind: "denied", status: 403, error: "LAN_AGENT_DISABLED_OR_REVOKED" }, "persona-a", [route("persona-a")]), {
    allowed: false, status: 403, error: "LAN_AGENT_DISABLED_OR_REVOKED"
  });
});

test("malformed trusted configuration is not interpreted as permission", () => {
  const definition = route("persona-a");
  definition.remoteAgentTargets![0].id = "not-the-bound-identity";
  assert.throws(() => allowed(principal, "persona-a", [definition]), /Invalid remote Agent target identity/);
});
