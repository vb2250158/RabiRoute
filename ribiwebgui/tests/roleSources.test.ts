import assert from "node:assert/strict";
import test from "node:test";
import { createRoleKnowledgeClient } from "../src/roleKnowledgeClient";
import { roleConfigPath, roleKnowledgePath } from "../src/roleScopedNavigation";

test("knowledge requests keep same-name roles on their selected source PC", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async input => {
    const path = String(input);
    paths.push(path);
    return new Response(JSON.stringify({ code: 0, data: { plans: path.includes("pc-one") ? 7 : 2 } }), { headers: { "content-type": "application/json" } });
  };
  try {
    const local = createRoleKnowledgeClient();
    const remote = createRoleKnowledgeClient("pc-one");
    const [localCounts, remoteCounts] = await Promise.all([local.loadRoleKnowledgeFileCounts("Shared"), remote.loadRoleKnowledgeFileCounts("Shared")]);
    assert.equal(localCounts.plans, 2);
    assert.equal(remoteCounts.plans, 7);
    assert.deepEqual(paths.sort(), ["/api/rabilink/peer/http/pc-one/persona/api/roles/Shared/counts", "/api/roles/Shared/counts"].sort());
  } finally { globalThis.fetch = original; }
});

test("canonical role links address roles independently of Route identity", () => {
  assert.equal(roleConfigPath("Role one"), "/roles/Role%20one/config");
  assert.equal(roleKnowledgePath("Unbound"), "/roles/Unbound/knowledge");
  assert.equal(roleConfigPath(""), "/roles");
});
