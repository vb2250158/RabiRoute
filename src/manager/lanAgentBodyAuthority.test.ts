import test from "node:test";
import assert from "node:assert/strict";
import { assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
const agent = { agentId: "worker", name: "Worker", provider: "dsh", enabled: true, sessionId: "own-session", managedSessionIds: ["own-child"] };
test("sessionless Agents can submit management bodies but cannot claim any source session", () => {
  const sessionless = { agentId: "worker", name: "Worker", provider: "custom-provider", enabled: true };
  for (const binding of [sessionless, undefined]) {
    assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/settings", { enabled: true }, binding));
    assert.throws(() => assertLanAgentBodyAuthority("/api/agent/send", { sender: { sessionId: "foreign" } }, binding), /not owned/);
    assert.throws(() => assertLanAgentBodyAuthority("/api/agent/threads", { action: "send" }, binding), /requires/);
    assert.throws(() => assertLanAgentBodyAuthority("/api/agent/threads", { action: "create", prompt: "initial user input" }, binding), /requires/);
    assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/settings", [], binding));
  }
});

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
test("message processing supports registration and target workers while preserving actual decision identity", () => {
  assert.throws(() => assertLanAgentBodyAuthority("/api/message-processing/requirements/item/outcome", { decidedByThreadId: "foreign" }, agent), /not owned/);
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/message-processing/requirements", { action: "dispatch", worker: { threadId: "another-worker" } }, agent));
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/message-processing/requirements", { action: "register_group" }, agent));
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/message-processing/requirements/item/outcome", { decidedByThreadId: "own-session" }, agent));
});
test("future and management payload schemas are independent of source authority fields", () => {
  for (const target of ["/api/future/settings", "/api/future/context", "/api/codex-hook/sessions/other"]) {
    for (const body of [null, "value", [], { sender: "display-name", worker: { sessionId: "target-session" }, sourceThreadId: "target-thread", messageSource: "configured-value" }]) {
      assert.doesNotThrow(() => assertLanAgentBodyAuthority(target, body, undefined));
    }
  }
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/agent/threads", { action: "create", workspace: "another-workspace", worker: { sessionId: "target" } }, undefined));
});
test("hook events require actual source session and provider, while session management has no binding grant", () => {
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/codex-hook/sessions/other", { roleId: "persona-other" }, undefined));
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/codex-hook/context", { session_id: "own-session", agentType: "dsh" }, agent));
  assert.throws(() => assertLanAgentBodyAuthority("/api/codex-hook/context", { session_id: "own-session" }, agent), /provider/);
  assert.throws(() => assertLanAgentBodyAuthority("/api/codex-hook/context", { session_id: "foreign", agentType: "dsh" }, agent), /not owned/);
});
