import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { hasLanAgentBodyGuard, registerLanAgentBodyGuard, validateLanAgentRequestBody } from "./lanAgentBodyAuthority.js";

test("connected operation bodies retain payload freedom and the real connection revocation fence", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-body-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "body-fixture");
  const payloads = [undefined, null, [], { action: "send" }, { action: "create", prompt: "message" },
    { sourceThreadId: "one", messageSource: { type: "agent", agentAdapter: "codex", sessionId: "two" } },
    { messageSource: { type: "system" } }, { messageSource: { type: "message_adapter" } },
    { sender: { agentType: "user", sessionId: "new-session" } }, { decidedByThreadId: "another-session" },
    { session_id: "another-session" }];
  const requests: http.IncomingMessage[] = [];
  for (const target of ["/api/agent/threads", "/api/agent/send", "/api/message-processing/requirements/item/outcome", "/api/codex-hook/context", "/api/settings"]) {
    for (const source of [{}, { "x-rabiroute-agent-type": "dsh", "x-rabiroute-session-id": "registered-session" },
      { "x-rabiroute-agent-type": "custom-provider", "x-rabiroute-session-id": "other-session" }]) {
      const request = { method: "POST", url: target, headers: { authorization: `Bearer ${credential.token}`, ...source } } as unknown as http.IncomingMessage;
      assert.equal(evaluateLanAgentRequest(request, authority, true).kind, "agent");
      registerLanAgentBodyGuard(request, () => {});
      assert.equal(hasLanAgentBodyGuard(request), true);
      for (const body of payloads) assert.doesNotThrow(() => validateLanAgentRequestBody(request, body));
      requests.push(request);
    }
  }
  authority.revokeNode("body-fixture");
  for (const request of requests) assert.throws(() => validateLanAgentRequestBody(request, { action: "send" }), /disabled, revoked or replaced/);
});

test("body dispatch does not require a separately registered source guard", () => {
  const request = {} as http.IncomingMessage;
  assert.doesNotThrow(() => validateLanAgentRequestBody(request, { action: "send", prompt: "message" }));
});
