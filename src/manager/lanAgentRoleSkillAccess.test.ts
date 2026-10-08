import assert from "node:assert/strict";
import test from "node:test";
import { authorizeLanAgentRoleSkillRead, authorizeLanAgentRoleSkillRequest } from "./lanAgentRoleSkillAccess.js";

const principal = { kind: "agent", nodeId: "node-a", agentId: "agent-a" } as const;
test("authenticated connections read any persona's skills without another binding", () => {
  for (const role of ["persona-a", "persona-b", "示例人格"]) {
    assert.deepEqual(authorizeLanAgentRoleSkillRead(principal, role, [], () => ""), { allowed: true });
    for (const prefix of ["/api/roles", "/roles"]) {
      assert.deepEqual(authorizeLanAgentRoleSkillRequest(principal, "GET", `${prefix}/${encodeURIComponent(role)}/skills/example/download`, [], () => ""), { allowed: true });
    }
  }
});
test("connection authentication and download path contracts still apply", () => {
  const denied = { kind: "denied", status: 401, error: "LAN_AGENT_CREDENTIAL_REQUIRED" } as const;
  assert.deepEqual(authorizeLanAgentRoleSkillRead(denied, "persona-a", [], () => ""), {
    allowed: false, status: 401, error: denied.error
  });
  assert.equal(authorizeLanAgentRoleSkillRead({ ...principal, agentId: "" }, "persona-a", [], () => "").allowed, false);
  assert.equal(authorizeLanAgentRoleSkillRequest(principal, "GET", "/roles/persona-a/skills/..%2fsecret/download", [], () => "").allowed, false);
});
