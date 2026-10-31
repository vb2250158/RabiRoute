import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { setTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { dispatchVoiceTranscriptFixture } from "./personaHistoryOperationTestFixtures.js";
import { queryPersonaVoiceTranscriptViews } from "../personaVoiceTranscriptView.js";
import { type RoleSkillArchiveReply } from "./roleSkillDownloadRoutes.js";
import { dispatchSkillDownloadFixture } from "./personaSkillOperationTestFixtures.js";
import { createAgentUploadRoutes } from "./agentUploadRoutes.js";
import { AgentUploadStore, AgentUploadStoreError } from "./agentUploadStore.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const json = (response: http.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
};
type Revocation = "disable" | "instance-aba" | "global-aba"  | "reenroll";
const revocations: Revocation[] = ["disable", "instance-aba", "global-aba", "reenroll"];
async function fixture(t: TestContext, handler: http.RequestListener) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-async-authority-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const config = new RabiGlobalConfigStore(root);
  config.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const binding = { agentId: "worker", provider: "dsh", sessionId: "fixture-session" };
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true, () => config.getLanAgentAdmissionPolicy());
    if (access.kind !== "agent") { json(response, 403, { error: "denied" }); return; }
    setTrustedLanAgentSource(request, { nodeId: "fixture-node", agentId: "worker", provider: "dsh", sessionId: "fixture-session", sessionName: "Fixture" });
    handler(request, response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, authority,
    url: `http://127.0.0.1:${address.port}`,
    headers: { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" },
    revoke(mode: Revocation) {
      if (mode === "global-aba") {
        config.patch({ webguiLan: { enabled: false } }); config.patch({ webguiLan: { enabled: true } });
      } else if (mode === "reenroll") {
        authority.revokeNode("fixture-node");
        const replacement = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
      } else {
        authority.setNodeEnabled("fixture-node", false);
        if (mode === "instance-aba") {
          authority.setNodeEnabled("fixture-node", true);
          assert.ok(authority.acquireConnectionLease(credential.token), "fresh admission remains available after re-enable");
        }
      }
    }
  };
}

for (const mode of revocations) {
  test(`deferred voice response suppresses original authorized result after ${mode}`, { timeout: 10000 }, async t => {
    const entered = deferred(); const gate = deferred(); t.after(gate.resolve);
    const f = await fixture(t, (request, response) => {
      dispatchVoiceTranscriptFixture(request, new URL(request.url!, "http://fixture.invalid"), response, {
        roleDir: () => f.root,
        query: async () => {
          entered.resolve(); await gate.promise;
          return { ...queryPersonaVoiceTranscriptViews(f.root), matchedCount: 987654321 };
        }
      });
    });
    const pending = fetch(`${f.url}/api/roles/example/voice-transcripts`, { headers: f.headers });
    await entered.promise; f.revoke(mode); gate.resolve();
    const response = await pending; const body = await response.text();
    assert.equal(response.status, 403); assert.match(body, /LAN_AGENT_AUTHORIZATION_REVOKED|API_REQUEST_AUTHORITY_REVOKED/);
    assert.doesNotMatch(body, /987654321|identityPath|conversationPath/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  for (const archiveOk of [false, true]) {
    test(`deferred ZIP ${archiveOk ? "artifact" : "not-found"} suppresses revoked response after ${mode}`, { timeout: 10000 }, async t => {
      const entered = deferred(); const gate = deferred(); t.after(gate.resolve);
      const f = await fixture(t, (request, response) => {
        dispatchSkillDownloadFixture(request, new URL(request.url!, "http://fixture.invalid").pathname, response, {
          roleDirectory: () => f.root, temporaryRoot: f.root, json,
          reportCleanupError: () => assert.fail("Unexpected archive cleanup failure"),
          archive: async (_roleDir, _skillId, outputPath): Promise<RoleSkillArchiveReply> => {
            const bytes = Buffer.alloc(22, 0x41);
            if (archiveOk) fs.writeFileSync(outputPath, bytes);
            entered.resolve(); await gate.promise;
            return archiveOk ? { ok: true, sizeBytes: bytes.length, fileCount: 1, sha256: createHash("sha256").update(bytes).digest("hex") }
              : { ok: false, code: "not_found" };
          }
        });
      });
      const pending = fetch(`${f.url}/api/roles/example/skills/selected/download`, { headers: f.headers });
      await entered.promise; f.revoke(mode); gate.resolve();
      const response = await pending; const body = await response.text();
      assert.equal(response.status, 403); assert.match(body, /LAN_AGENT_AUTHORIZATION_REVOKED|API_REQUEST_AUTHORITY_REVOKED/);
      assert.doesNotMatch(body, /SKILL_ARCHIVE_NOT_FOUND|A{22}/);
      assert.equal(response.headers.get("content-disposition"), null);
    });
  }

  test(`real upload final publication rejects original request after ${mode}`, { timeout: 10000 }, async t => {
    const entered = deferred(); const gate = deferred(); t.after(gate.resolve);
    let routes!: ReturnType<typeof createAgentUploadRoutes>;
    const f = await fixture(t, (request, response) => { routes.handler(request, new URL(request.url!, "http://fixture.invalid"), response); });
    const store = new AgentUploadStore({ rootDir: path.join(f.root, "uploads") });
    routes = createAgentUploadRoutes({
      assertAuthorized() {},
      store: {
        limits: store.limits,
        get: (owner, id) => store.get(owner, id),
        uploadStream: input => store.uploadStream({ ...input, beforeCommit: async () => {
          await input.beforeCommit?.(); entered.resolve(); await gate.promise;
        } })
      }
    });
    t.after(() => routes.stopAcceptingAndDrain());
    const bytes = Buffer.from("fixture sensitive bytes"); const id = randomUUID();
    const pending = fetch(`${f.url}/api/agent/uploads/${id}`, { method: "PUT", body: bytes, headers: {
      ...f.headers, "content-type": "application/octet-stream", "idempotency-key": id,
      "x-rabiroute-file-name": "fixture.bin", "x-rabiroute-content-sha256": createHash("sha256").update(bytes).digest("hex")
    } });
    await entered.promise; f.revoke(mode); gate.resolve();
    const response = await pending; const body = await response.text();
    assert.equal(response.status, 403); assert.match(body, /forbidden/);
    assert.doesNotMatch(body, /fixture sensitive bytes|expiresAt/);
    assert.throws(() => store.get({ nodeId: "fixture-node", agentId: "worker" }, id),
      error => error instanceof AgentUploadStoreError && error.code === "not_found");
    assert.equal(fs.readdirSync(path.join(f.root, "uploads")).some(name => name.startsWith(".stream-") || name === id), false);
  });
}
