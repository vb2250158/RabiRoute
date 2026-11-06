import assert from "node:assert/strict";
import test from "node:test";
import { chatTaskOwner, personaHistoryTaskKey } from "./personaChatHistory.js";

test("display task ownership preserves the exact endpoint while excluding execution credentials", () => {
  const party = { endpoint: { kind: "instance" as const, provider: "codex", agentId: "agent", nodeId: "original-node", instanceId: "alias-node",
    managerInstanceId: "private-generation", authorizationIncarnation: "fake-private-proof", sessionId: "task" } };
  const before = structuredClone(party);
  assert.deepEqual(chatTaskOwner(party, id => `Name ${id}`), {
    kind: "instance", provider: "codex", agentId: "agent", nodeId: "original-node", nodeName: "Name original-node"
  });
  assert.deepEqual(party, before);
  assert.equal(chatTaskOwner(undefined), undefined);
  assert.equal(chatTaskOwner({}), undefined);
  const fallback = chatTaskOwner({ endpoint: { kind: "instance", provider: "codex", agentId: "agent", instanceId: "other-node" } });
  assert.equal(fallback?.nodeId, "other-node");
  assert.notEqual(personaHistoryTaskKey("same-task", chatTaskOwner(party)), personaHistoryTaskKey("same-task", fallback));
});
