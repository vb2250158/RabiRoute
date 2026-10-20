import assert from "node:assert/strict";
import test from "node:test";
import { authorizeLanAgentRoleSkillRead, authorizeLanAgentRoleSkillRequest } from "./lanAgentRoleSkillAccess.js";

const principal = { kind: "agent", nodeId: "node-a", agentId: "agent-a" } as const;

test("authenticated Agents read public persona Skills without Route grants", () => {
  for (const persona of ["persona-a", "persona-b", "示例角色"]) {
    assert.deepEqual(authorizeLanAgentRoleSkillRead(principal, persona, [], () => ""), { allowed: true });
    for (const prefix of ["/api/roles", "/roles"]) {
      for (const suffix of ["/skills", "/skills/example", "/skills/example/download"]) {
        assert.deepEqual(authorizeLanAgentRoleSkillRequest(principal, "GET", `${prefix}/${encodeURIComponent(persona)}${suffix}`), { allowed: true });
      }
    }
  }
});

test("local management retains ingress authentication and denied principals stay denied", () => {
  assert.deepEqual(authorizeLanAgentRoleSkillRequest({ kind: "unrelated" }, "GET", "/roles/persona/skills"), { allowed: true });
  for (const denied of [
    { kind: "denied", status: 401, error: "LAN_AGENT_CREDENTIAL_REQUIRED" },
    { kind: "denied", status: 403, error: "LAN_AGENT_DISABLED_OR_REVOKED" }
  ] as const) {
    const expected = { allowed: false, status: denied.status, error: denied.error };
    assert.deepEqual(authorizeLanAgentRoleSkillRequest(denied, "GET", "/roles/persona/skills"), expected);
    assert.deepEqual(authorizeLanAgentRoleSkillRead(denied, "persona-a", [], () => ""), expected);
  }
  assert.equal(authorizeLanAgentRoleSkillRead({ ...principal, agentId: "" }, "persona-a", [], () => "").allowed, false);
});

test("removing Route authorization does not allow malformed download paths", () => {
  for (const pathname of ["/roles/%ZZ/skills/example/download", "/roles/persona/skills/..%2fother/download"]) {
    assert.deepEqual(authorizeLanAgentRoleSkillRequest(principal, "GET", pathname), {
      allowed: false, status: 403, error: "INVALID_SKILL_DOWNLOAD_PATH"
    });
  }
});
