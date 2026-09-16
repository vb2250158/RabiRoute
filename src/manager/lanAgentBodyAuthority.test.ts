import test from "node:test";
import assert from "node:assert/strict";
import { assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
const agent = { agentId: "worker", name: "Worker", provider: "dsh", enabled: true, sessionId: "own-session", managedSessionIds: ["own-child"] };
test("remote source must belong to the selected Agent even if spoofed fields agree", () => {
  const body = { action: "send", sourceThreadId: "foreign-session", messageSource: { type: "agent", agentAdapter: "dsh", sessionId: "foreign-session" } };
  assert.throws(() => assertLanAgentBodyAuthority("/api/agent/threads", body, agent), /not owned/);
  body.sourceThreadId = "own-session"; body.messageSource.sessionId = "own-session";
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/agent/threads", body, agent));
  body.messageSource.type = "system";
  assert.throws(() => assertLanAgentBodyAuthority("/api/agent/threads", body, agent), /impersonate/);
  assert.throws(() => assertLanAgentBodyAuthority("/api/agent/send", { sender: { sessionId: "foreign-session" } }, agent), /not owned/);
  assert.throws(() => assertLanAgentBodyAuthority("/api/lan-agent/instances/a/agents/b/context", { session_id: "foreign-session" }, agent), /not owned/);
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/agent/send", { sender: { sessionId: "own-child" } }, agent));
});
test("message processing cannot impersonate another worker or register Manager ingress", () => {
  for (const body of [{ decidedByThreadId: "foreign" }, { worker: { threadId: "foreign" } }, { worker: { sessionId: "foreign" } }]) {
    assert.throws(() => assertLanAgentBodyAuthority("/api/message-processing/requirements/item/outcome", body, agent), /not owned/);
  }
  assert.throws(() => assertLanAgentBodyAuthority("/api/message-processing/requirements", { action: "register_group" }, agent), /owned by Manager/);
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/message-processing/requirements/item/outcome", { decidedByThreadId: "own-session" }, agent));
});
