import test from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { assertLanAgentBodyAuthority, validateLanAgentRequestBody } from "./lanAgentBodyAuthority.js";

test("connected operation bodies have no extra source registration, provider, session or role gate", () => {
  const bindings = [undefined, { provider: "dsh", sessionId: "registered-session" }, { provider: "custom-provider" }];
  const payloads = [undefined, null, [], { action: "send" }, { action: "create", prompt: "message" },
    { sourceThreadId: "one", messageSource: { type: "agent", agentAdapter: "codex", sessionId: "two" } },
    { messageSource: { type: "system" } }, { messageSource: { type: "message_adapter" } },
    { sender: { agentType: "user", sessionId: "new-session" } }, { decidedByThreadId: "another-session" },
    { session_id: "another-session" }];
  for (const target of ["/api/agent/threads", "/api/agent/send", "/api/message-processing/requirements/item/outcome", "/api/codex-hook/context", "/api/settings"]) {
    for (const binding of bindings) for (const body of payloads) assert.doesNotThrow(() => assertLanAgentBodyAuthority(target, body, binding));
  }
});

test("body dispatch does not require a separately registered source guard", () => {
  const request = {} as http.IncomingMessage;
  assert.doesNotThrow(() => validateLanAgentRequestBody(request, { action: "send", prompt: "message" }));
});
