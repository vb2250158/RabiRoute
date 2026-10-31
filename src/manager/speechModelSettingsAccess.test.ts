import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import test, { type TestContext } from "node:test";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { setTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { evaluateLanAgentRequest, hasTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";

function request(remoteAddress = "192.0.2.10", headers: IncomingMessage["headers"] = { host: "manager.example" }): IncomingMessage {
  return { method: "GET", url: "/api/speech/settings", socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "speech-settings-access-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  let policy = { enabled: true, incarnation: "initial" };
  const admit = () => {
    const remote = request("192.0.2.10", {
      host: "manager.example", authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "fixture-agent"
    });
    assert.equal(evaluateLanAgentRequest(remote, authority, true, () => policy).kind, "agent");
    return remote;
  };
  const grantFallbacks = (remote: IncomingMessage) => {
    markAuthenticatedConnectionRequest(remote);
    setTrustedLanAgentSource(remote, { nodeId: "fixture-node", agentId: "fixture-agent", provider: "codex", sessionId: "fixture-session", sessionName: "Fixture" });
    Object.assign(remote.socket, { remoteAddress: "127.0.0.1" });
    remote.headers.host = "127.0.0.1:1234";
    delete remote.headers.authorization;
    delete remote.headers["x-rabiroute-agent-id"];
  };
  return { authority, admit, grantFallbacks, replacePolicy: (next: typeof policy) => { policy = next; } };
}

test("ingress-authenticated enabled Agent needs neither a session source nor a local origin", t => {
  const f = fixture(t);
  assert.equal(localModelSettingsRequestAllowed(f.admit()), true);
});

test("verified connection access is preserved without trusting copied objects or credential headers", () => {
  const remote = request();
  remote.headers.authorization = "Bearer forged";
  remote.headers["x-rabilink-tunnel-local"] = "forged";
  assert.equal(localModelSettingsRequestAllowed(remote), false);
  markAuthenticatedConnectionRequest(remote);
  assert.equal(localModelSettingsRequestAllowed(remote), true);
  assert.equal(localModelSettingsRequestAllowed({ ...remote }), false);
});

test("unissued Agent header denies even an authenticated connection on a safe local origin", () => {
  for (const agentId of ["fixture-agent", "", ["fixture-agent"]]) {
    const local = request("127.0.0.1", { host: "127.0.0.1:1234", "x-rabiroute-agent-id": agentId });
    markAuthenticatedConnectionRequest(local);
    assert.equal(localModelSettingsRequestAllowed(local), false);
  }
});

test("node revocation and reenrollment cannot fall back through connection, source or loopback", t => {
  const f = fixture(t);
  const remote = f.admit();
  f.grantFallbacks(remote);
  assert.equal(localModelSettingsRequestAllowed(remote), true);
  f.authority.revokeNode("fixture-node");
  assert.equal(localModelSettingsRequestAllowed(remote), false);
  const replacement = f.authority.enroll(f.authority.issueBootstrapTicket().ticket, "fixture-node");
  remote.headers.authorization = `Bearer ${replacement.token}`;
  assert.equal(localModelSettingsRequestAllowed(remote), false);
});

test("Agent disable-enable does not revive the original settings request", t => {
  const f = fixture(t);
  const remote = f.admit();
  f.authority.setNodeEnabled("fixture-node", false);
  f.grantFallbacks(remote);
  f.authority.setNodeEnabled("fixture-node", true);
  assert.equal(localModelSettingsRequestAllowed(remote), false);
  assert.equal(localModelSettingsRequestAllowed(remote), false);
  assert.equal(localModelSettingsRequestAllowed(f.admit()), true);
});

test("global disable-enable admission fence takes precedence over authenticated connection", t => {
  const f = fixture(t);
  const remote = f.admit();
  f.grantFallbacks(remote);
  f.replacePolicy({ enabled: false, incarnation: "disabled" });
  assert.equal(localModelSettingsRequestAllowed(remote), false);
  f.replacePolicy({ enabled: true, incarnation: "reenabled" });
  assert.equal(localModelSettingsRequestAllowed(remote), false);
  assert.equal(localModelSettingsRequestAllowed(f.admit()), true);
});

test("nested ingress denial remains sticky after principal and remote headers are removed", t => {
  const f = fixture(t);
  const remote = f.admit();
  remote.headers.authorization = "Bearer forged";
  assert.equal(evaluateLanAgentRequest(remote, f.authority, true).kind, "denied");
  assert.equal(hasTrustedLanAgentPrincipal(remote), false);
  f.grantFallbacks(remote);
  assert.equal(localModelSettingsRequestAllowed(remote), false);
  assert.equal(evaluateLanAgentRequest(remote, f.authority, true).kind, "denied");
  assert.equal(localModelSettingsRequestAllowed(remote), false);
});

test("unauthenticated local pages retain loopback, forwarding, host and origin checks", () => {
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(localModelSettingsRequestAllowed(request(address, { host: "localhost:1234", origin: "http://localhost:1234", "sec-fetch-site": "same-origin" })), true);
  }
  assert.equal(localModelSettingsRequestAllowed(request("::1", { host: "[::1]:1234" })), true);
  for (const [address, headers] of [
    ["192.0.2.10", { host: "127.0.0.1:1234" }],
    ["127.0.0.1", {}],
    ["127.0.0.1", { host: "attacker.example" }],
    ["127.0.0.1", { host: "[invalid" }],
    ["127.0.0.1", { host: "127.0.0.1:1234", origin: "https://attacker.example" }],
    ["127.0.0.1", { host: "127.0.0.1:1234", origin: "invalid" }],
    ["127.0.0.1", { host: "127.0.0.1:1234", "x-forwarded-for": "192.0.2.10" }],
    ["127.0.0.1", { host: "127.0.0.1:1234", forwarded: "for=192.0.2.10" }],
    ["127.0.0.1", { host: "127.0.0.1:1234", "sec-fetch-site": "cross-site" }]
  ] satisfies Array<[string, IncomingMessage["headers"]]>) {
    assert.equal(localModelSettingsRequestAllowed(request(address, headers)), false, JSON.stringify({ address, headers }));
  }
});
