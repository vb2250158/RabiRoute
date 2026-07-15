import assert from "node:assert/strict";
import test from "node:test";
import { parseRoleKnowledgeResourceRoute } from "./roleKnowledgeRoute.js";

test("role knowledge routes prefer specific memory resources over memory item ids", () => {
  assert.deepEqual(parseRoleKnowledgeResourceRoute("/api/roles/GameDailyRabi/memory/recent"), {
    roleId: "GameDailyRabi",
    resource: "memory/recent",
    itemId: ""
  });
  assert.deepEqual(parseRoleKnowledgeResourceRoute("/roles/Rabi/memory/recent/memory-001"), {
    roleId: "Rabi",
    resource: "memory/recent",
    itemId: "memory-001"
  });
  assert.deepEqual(parseRoleKnowledgeResourceRoute("/roles/Rabi/memory/consolidation-runs/run-001"), {
    roleId: "Rabi",
    resource: "memory/consolidation-runs",
    itemId: "run-001"
  });
  assert.deepEqual(parseRoleKnowledgeResourceRoute("/roles/Rabi/memory"), {
    roleId: "Rabi",
    resource: "memory",
    itemId: ""
  });
});
