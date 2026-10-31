import test from "node:test";
import assert from "node:assert/strict";
import { assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
const agent = { agentId: "worker", name: "Worker", provider: "dsh", enabled: true, sessionId: "own-session" };
test("connection authentication does not require a pre-registered send session", () => {
  const sessionless = { agentId: "worker", name: "Worker", provider: "custom-provider", enabled: true };
  for (const binding of [sessionless, undefined]) {
    assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/settings", { enabled: true }, binding));
    assert.throws(() => assertLanAgentBodyAuthority("/api/agent/send", { sender: { agentType: "agent", sessionId: "new-session" } }, binding), /Explicit Agent type/);
    assert.throws(() => assertLanAgentBodyAuthority("/api/agent/threads", { action: "send" }, binding), /required/);
    assert.throws(() => assertLanAgentBodyAuthority("/api/agent/threads", { action: "create", prompt: "initial user input" }, binding), /required/);
    assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/settings", [], binding));
  }
});

test("remote delegation accepts explicit sessions while checking provider and matching IDs", () => {
  const body = { action: "send", sourceThreadId: "foreign-session", messageSource: { type: "agent", agentAdapter: "dsh", sessionId: "foreign-session" } };
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/agent/threads", body, {...agent,sessionId:body.sourceThreadId}));
  body.sourceThreadId = "own-session"; body.messageSource.sessionId = "own-session";
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/agent/threads", body, agent));
  body.messageSource.type = "system";
  assert.throws(() => assertLanAgentBodyAuthority("/api/agent/threads", body, agent), /impersonate/);
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/agent/send", { sender: { sessionId: "new-session" } }, {...agent,sessionId:"new-session"}));
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/retired/context", {}, agent));
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/agent/send", { sender: { sessionId: "own-child" } }, {...agent,sessionId:"own-child"}));
});
test("message processing supports registration and target workers while preserving actual decision identity", () => {
  assert.throws(() => assertLanAgentBodyAuthority("/api/message-processing/requirements/item/outcome", { decidedByThreadId: "foreign" }, agent), /does not match/);
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
  assert.throws(() => assertLanAgentBodyAuthority("/api/codex-hook/context", { session_id: "foreign", agentType: "dsh" }, agent), /does not match/);
});

test("explicit send and delegation IDs remain required and internally consistent", () => {
  for (const sessionId of ["", " x", "a\nb", undefined]) assert.throws(() => assertLanAgentBodyAuthority("/api/agent/send", {sender:{sessionId}}, agent), /full source session/);
  assert.throws(() => assertLanAgentBodyAuthority("/api/agent/threads", {action:"send",sourceThreadId:"one",messageSource:{type:"agent",agentAdapter:"dsh",sessionId:"two"}}, agent), /does not match|do not match/);
});
