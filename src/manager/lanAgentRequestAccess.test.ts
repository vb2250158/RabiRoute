import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal, hasTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { getTrustedLanAgentSource, setTrustedLanAgentSource, validateLanAgentRequestBody, registerLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";

test("request principal fences the original credential and global ABA independently of session or provider", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-principal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "auth.json") });
  const config = new RabiGlobalConfigStore(root);
  config.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node-fixture");
  authority.registerAgentCatalog(credential.token, [{ agentId: "worker", provider: "custom-provider" }]);
  const make = () => ({ method: "GET", url: "/meta", headers: { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" } } as unknown as IncomingMessage);
  const admit = () => {
    const request = make();
    assert.equal(evaluateLanAgentRequest(request, authority, true, () => config.getLanAgentAdmissionPolicy()).kind, "agent");
    return request;
  };
  const request = admit();
  assert.equal(hasTrustedLanAgentPrincipal(request), true);
  assert.equal(assertTrustedLanAgentPrincipal(request)?.binding?.provider, "custom-provider");
  assert.equal(getTrustedLanAgentSource(request), undefined);
  assert.throws(() => validateLanAgentRequestBody(request, {}), /guard is unavailable/);
  registerLanAgentBodyGuard(request, () => undefined);
  assert.doesNotThrow(() => validateLanAgentRequestBody(request, {}));
  assert.equal(evaluateLanAgentRequest(request, authority, true).kind, "agent");
  const originalLease = assertTrustedLanAgentPrincipal(request);
  assert.equal(evaluateLanAgentRequest(request, authority, true).kind, "agent");
  assert.equal(assertTrustedLanAgentPrincipal(request), originalLease);
  const otherCredential = authority.enroll(authority.issueBootstrapTicket().ticket, "node-other");
  authority.setAgentEnabled("node-other", "worker", true);
  const swapped = admit();
  swapped.headers.authorization = `Bearer ${otherCredential.token}`;
  assert.equal(evaluateLanAgentRequest(swapped, authority, true).kind, "denied");
  swapped.headers.authorization = `Bearer ${credential.token}`;
  assert.equal(evaluateLanAgentRequest(swapped, authority, true).kind, "denied");
  delete swapped.headers["x-rabiroute-agent-id"];
  assert.throws(() => assertTrustedLanAgentPrincipal(swapped), /principal is unavailable/);
  const nested = admit();
  config.patch({ webguiLan: { enabled: false } });
  config.patch({ webguiLan: { enabled: true } });
  assert.equal(evaluateLanAgentRequest(nested, authority, true).kind, "denied");
  assert.throws(() => assertTrustedLanAgentPrincipal(request), /admission was disabled/);
  const pending = admit();
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const operation = wait.then(() => { assertTrustedLanAgentPrincipal(pending); });
  authority.setAgentEnabled("node-fixture", "worker", false);
  finish();
  await assert.rejects(operation, /revoked or replaced/);
  authority.setAgentEnabled("node-fixture", "worker", true);
  const current = admit();
  setTrustedLanAgentSource(current, { nodeId: "node-fixture", agentId: "worker", provider: "dsh", sessionId: "fixture", sessionName: "Fixture" });
  authority.setAgentEnabled("node-fixture", "worker", false);
  authority.setAgentEnabled("node-fixture", "worker", true);
  assert.throws(() => getTrustedLanAgentSource(current), /revoked or replaced/);
  assert.throws(() => validateLanAgentRequestBody(current, {}), /revoked or replaced/);
  const revoked = admit();
  authority.revokeNode("node-fixture");
  const replacement = authority.enroll(authority.issueBootstrapTicket().ticket, "node-fixture");
  authority.setAgentEnabled("node-fixture", "worker", true);
  revoked.headers.authorization = `Bearer ${replacement.token}`;
  assert.throws(() => assertTrustedLanAgentPrincipal(revoked), /revoked or replaced/);
  assert.equal(evaluateLanAgentRequest(revoked, authority, false).kind, "denied");
  assert.equal(hasTrustedLanAgentPrincipal(revoked), false);
  assert.throws(() => validateLanAgentRequestBody(revoked, {}), /principal is unavailable/);
});

test("authenticated Agent uses APIs without a second secret; malformed and revoked credentials fail", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-access-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "auth.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node-fixture");
  const make = (url: string, extra: Record<string, string> = {}) => ({ method: "GET", url, headers: { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker", ...extra }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage);
  try {
    assert.equal(evaluateLanAgentRequest(make("/meta"), authority, true).kind, "denied");
    authority.setAgentEnabled("node-fixture", "worker", true);
    assert.equal(evaluateLanAgentRequest(make("/meta"), authority, true).kind, "agent");
    for (const target of ["/api/webgui-access", "/api/unknown-business", "/api/roles/persona-a/skills?view=extra", "/api/codex-hook/sessions/other", "/api/codex-hook/roles", "/api/codex-hook/doctor"]) {
      assert.deepEqual(evaluateLanAgentRequest(make(target), authority, true), {
        kind: "agent", nodeId: "node-fixture", agentId: "worker"
      });
    }
    const post = make("/api/roles/persona-a/skills");
    post.method = "POST";
    assert.deepEqual(evaluateLanAgentRequest(post, authority, true), {
      kind: "agent", nodeId: "node-fixture", agentId: "worker"
    });
    for (const target of ["/api/roles/persona-b/skills", "/roles/persona-b/skills/example"]) {
      assert.deepEqual(evaluateLanAgentRequest(make(target), authority, true), {
        kind: "agent", nodeId: "node-fixture", agentId: "worker"
      });
    }
    for (const target of ["/api/unknown/../admin", "/api/unknown/%2e%2e/admin", "/api/unknown/%252fadmin", "/api/unknown?access_token=fixture", "/api/unknown?query=%00"]) {
      assert.equal(evaluateLanAgentRequest(make(target), authority, true).kind, "denied", target);
    }
    assert.equal(evaluateLanAgentRequest(make("/meta", { "x-rabiroute-webgui-token": "admin-fixture" }), authority, true).kind, "denied");
    assert.equal(evaluateLanAgentRequest(make("/meta?webgui_token=fixture"), authority, true).kind, "denied");
    assert.equal(evaluateLanAgentRequest(make("/meta", { authorization: "Bearer lan1:malformed" }), authority, true).kind, "denied");
    assert.equal(evaluateLanAgentRequest(make("/meta"), authority, false).kind, "denied");
    authority.setAgentEnabled("node-fixture", "worker", false);
    assert.equal(evaluateLanAgentRequest(make("/api/lan-agent/resources"), authority, true).kind, "denied");
    const self = make("/api/lan-agent/self");
    delete self.headers["x-rabiroute-agent-id"];
    assert.equal(evaluateLanAgentRequest(self, authority, true).kind, "unrelated");
    const nodeMeta = make("/meta");
    delete nodeMeta.headers["x-rabiroute-agent-id"];
    assert.equal(evaluateLanAgentRequest(nodeMeta, authority, true).kind, "unrelated");
    for (const target of ["/meta?extra=1", "/meta/", "/api/unknown-business"]) {
      nodeMeta.url = target;
      assert.equal(evaluateLanAgentRequest(nodeMeta, authority, true).kind, "denied");
    }
    nodeMeta.url = "/meta";
    nodeMeta.method = "POST";
    assert.equal(evaluateLanAgentRequest(nodeMeta, authority, true).kind, "denied");
    nodeMeta.method = "GET";
    assert.equal(evaluateLanAgentRequest(nodeMeta, authority, false).kind, "denied");
    for (const target of ["/api/lan-agent/releases/../self", "/api/lan-agent/releases/%2e%2e/self", "/api/lan-agent/releases/manifest?token=fixture"]) {
      const request = make(target);
      delete request.headers["x-rabiroute-agent-id"];
      assert.equal(evaluateLanAgentRequest(request, authority, true).kind, "denied");
    } // Endpoint separately checks node identity; this is not admin admission.
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
