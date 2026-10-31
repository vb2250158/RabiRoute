import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

test("an enrolled computer with no Agent catalog can use public APIs with an explicit invocation", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unbound-computer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "computer");
  const request = { method: "GET", url: "/api/roles/persona/plans", headers: {
    authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-type": "codex", "x-rabiroute-session-id": "never-registered-session"
  } } as unknown as IncomingMessage;
  assert.equal(evaluateLanAgentRequest(request, authority, true).kind, "agent");
  assert.equal(hasAuthenticatedConnectionRequest(request), true);
  assert.deepEqual(assertTrustedLanAgentPrincipal(request)?.source,
    { agentId: "codex", provider: "codex", sessionId: "never-registered-session" });
  assert.deepEqual(authority.getSnapshot().nodes, [{ nodeId: "computer", enabled: true }]);
  assert.doesNotThrow(() => assertTrustedLanAgentPrincipal(request), "backend discovery must not change connection authority");
  authority.revokeNode("computer");
  assert.throws(() => assertTrustedLanAgentPrincipal(request), /revoked/);
});

test("node-only service calls need no Agent registration; partial or forged invocation metadata is rejected", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unbound-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "computer");
  const request = (extra: Record<string, string>, token = credential.token) => ({ method: "GET", url: "/api/agent/help",
    headers: { authorization: `Bearer ${token}`, ...extra } }) as unknown as IncomingMessage;
  const system = request({});
  assert.equal(evaluateLanAgentRequest(system, authority, true).kind, "agent");
  assert.equal(assertTrustedLanAgentPrincipal(system)?.source, undefined);
  assert.equal(evaluateLanAgentRequest(request({ "x-rabiroute-agent-type": "codex" }), authority, true).kind, "denied");
  assert.equal(evaluateLanAgentRequest(request({ "x-rabiroute-agent-type": "codex", "x-rabiroute-session-id": "session" }, "lan1:invalid"), authority, true).kind, "denied");
  const selected = request({ "x-rabiroute-agent-type": "dsh", "x-rabiroute-session-id": "one" });
  assert.equal(evaluateLanAgentRequest(selected, authority, true).kind, "agent");
  selected.headers["x-rabiroute-session-id"] = "two";
  assert.equal(evaluateLanAgentRequest(selected, authority, true).kind, "denied");
});
