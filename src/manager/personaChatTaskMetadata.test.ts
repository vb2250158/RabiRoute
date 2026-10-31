import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRequestParty } from "../agentRequests/store.js";
import type { PersonaChatReply } from "../shared/personaChatHistory.js";
import { enrichPersonaChatTasks } from "./personaChatTaskMetadata.js";
import { readChatDeliveryParties } from "./personaChatDeliveryLookup.js";

const row = (extra: Partial<PersonaChatReply> = {}): PersonaChatReply => ({ id: "row", receivedAt: "2026-01-01", sessionId: "source", targetSessionId: "target", kind: "agent_delivery", text: "Saved message", deliveryId: "delivery", ...extra });
const party = (id: string, remote = false): AgentRequestParty => ({ threadId: id, threadName: `Recorded ${id}`, agentType: "agent", endpoint: {
  kind: remote ? "instance" : "local", managerInstanceId: "manager", agentId: "agent", provider: "codex", sessionId: id,
  ...(remote ? { nodeId: "node", instanceId: "node" } : {}), authorizationIncarnation: "private-proof"
} });
const localTask = (id: string) => ({ id, title: `Local ${id}`, cwd: "", rolloutPath: "", firstUserMessage: "", updatedAt: "" });

test("old delivery resolves names by exact owner and never links a remote ID to local Desktop", async () => {
  const original = row({ targetTaskUrl: "codex://threads/target" });
  const result = await enrichPersonaChatTasks([original, row({ id: "duplicate" })], {
    readDeliveryParties: ids => { assert.deepEqual(ids, ["delivery"]); return new Map([["delivery", { source: party("source"), target: party("target", true) }]]); },
    nodeName: () => "Build computer",
    readTasks: ids => { assert.deepEqual(ids, ["source"]); return ids.map(localTask); },
    readRemoteTask: async (owner, id) => { assert.equal(owner.nodeId, "node"); return { id, title: "Remote review task" }; }
  });
  assert.equal(result[0].sessionTitle, "Local source");
  assert.equal(result[0].targetSessionTitle, "Remote review task");
  assert.equal(result[0].targetTaskOwner?.nodeName, "Build computer");
  assert.equal(result[0].targetTaskUrl, undefined);
  assert.equal(result[1].targetSessionTitle, "Remote review task");
  assert.equal(JSON.stringify(result).includes("private-proof"), false);
  assert.equal(original.targetSessionTitle, undefined, "append-only input is not mutated");
});

test("offline node and local metadata failure retain snapshot titles, IDs and message bodies", async () => {
  const [result] = await enrichPersonaChatTasks([row()], {
    readDeliveryParties: () => new Map([["delivery", { source: party("source"), target: party("target", true) }]]),
    readTasks: () => { throw new Error("Desktop offline"); },
    readRemoteTask: async () => { throw new Error("Node offline"); }
  });
  assert.equal(result.targetSessionTitle, "Recorded target");
  assert.equal(result.targetTaskOwner?.nodeId, "node");
  assert.equal(result.text, "Saved message");
  assert.equal(result.targetTaskUrl, undefined);
});

test("mismatched delivery parties cannot rename a different task; local target names refresh", async () => {
  const [result] = await enrichPersonaChatTasks([row()], {
    readDeliveryParties: () => new Map([["delivery", { source: party("other"), target: party("other", true) }]]),
    readTasks: ids => ids.map(localTask),
    readRemoteTask: async () => { throw new Error("must not query unrelated owner"); }
  });
  assert.equal(result.targetSessionTitle, "Local target");
  assert.equal(result.targetTaskUrl, "codex://threads/target");
  assert.equal(result.targetTaskOwner, undefined);
});

test("user and AIUI origins are never looked up as Desktop tasks; non-Codex owners are not relabeled", async () => {
  const [user, aiui, nonCodex] = await enrichPersonaChatTasks([
    row({ kind: "user_delivery", sessionId: "webgui" }),
    row({ kind: "aiui_user", sessionId: "aiui", targetSessionId: undefined }),
    row({ id: "other", targetSessionId: "other", targetSessionTitle: "Other provider task", targetTaskOwner: { kind: "local", provider: "dsh", agentId: "local:dsh" } })
  ], { readTasks: ids => { assert.deepEqual(ids.sort(), ["source", "target"]); return ids.map(localTask); } });
  assert.equal(user.taskUrl, undefined);
  assert.equal(aiui.taskUrl, undefined);
  assert.equal(nonCodex.targetSessionTitle, "Other provider task");
  assert.equal(nonCodex.targetTaskUrl, undefined);
});

test("delivery lookup preserves available endpoint records if legacy metadata fails", () => {
  const preparation = { source: party("source"), target: party("target", true), deliveryId: "delivery" };
  const result = readChatDeliveryParties({
    getEndpointDelivery: id => id === "delivery" ? { preparation } as ReturnType<import("../agentRequests/store.js").AgentRequestStore["getEndpointDelivery"]> : undefined,
    list: () => { throw new Error("legacy unavailable"); }
  }, ["delivery", "missing"]);
  assert.equal(result.get("delivery")?.target.threadId, "target");
  assert.equal(result.has("missing"), false);
});
