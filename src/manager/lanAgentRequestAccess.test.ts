import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";

test("Agent credentials cannot downgrade to local admin or survive disabled grants", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-access-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "auth.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node-fixture");
  const make = (url: string, extra: Record<string, string> = {}) => ({ method: "GET", url, headers: { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker", ...extra }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage);
  try {
    assert.equal(evaluateLanAgentRequest(make("/meta"), authority, true).kind, "denied");
    authority.setAgentEnabled("node-fixture", "worker", true);
    assert.equal(evaluateLanAgentRequest(make("/meta"), authority, true).kind, "agent");
    assert.equal(evaluateLanAgentRequest(make("/api/webgui-access"), authority, true).kind, "denied");
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
