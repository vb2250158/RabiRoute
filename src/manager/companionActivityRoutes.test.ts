import test from "node:test";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompanionContinuationStore } from "./companionContinuation.js";
import { CompanionActivity } from "./companionActivity.js";
import { companionActivityHandler } from "./companionActivityRoutes.js";

test("local menu admission resolves the persona Route and recording consent, rejects origin/tunnel/readonly requests", async t => {
  let readOnly = false, consent = false;
  const recoveryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "companion-route-recovery-"));
  t.after(() => fs.rm(recoveryRoot, { recursive: true, force: true }));
  const continuation = new CompanionContinuationStore(recoveryRoot);
  const service = new CompanionActivity({ presets: [{ id: "adaptive", label: "自适应", labelEn: "Adaptive", reviewSeconds: 25, replyAgeSeconds: 30, guidance: "observe" }],
    changed: () => {}, reaction: () => {}, save: async () => {}, cancelSpeech: async () => {}, speak: async () => {}, deliver: async () => {} });
  const handler = companionActivityHandler(service, { continuation, local: () => true, readOnly: () => readOnly,
    verifyGateway: (role, gateway) => { assert.equal(role, "one"); return gateway || "persona-route"; },
    saveSummaryDefault: async () => consent, last: async () => null });
  const server = http.createServer((req, res) => { if (!handler(req, new URL(req.url!, `http://${req.headers.host}`), res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/roles/one/companion`;
  t.after(async () => { await service.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const body = { requestId: "menu-request-1", presetId: "adaptive", title: "", autoReview: false, voice: false, observationOwner: "desktop" };
  const start = (headers: Record<string,string> = {}) => fetch(`${base}/start`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await start({ origin: "https://untrusted.invalid" })).status, 403);
  assert.equal((await start({ "x-rabilink-tunnel-local": "1" })).status, 403);
  readOnly = true; assert.equal((await start()).status, 403); readOnly = false;
  const accepted = await start(); assert.equal(accepted.status, 200);
  const s = (await accepted.json() as any).data.session;
  assert.equal(s.gatewayId, "persona-route"); assert.equal(s.saveSummary, false);
  assert.equal((await continuation.read("one"))?.gatewayId, "persona-route");
  const command = async (session: any, action: string) => {
    const response = await fetch(`${base}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: session.id, revision: session.revision, action }) });
    assert.equal(response.status, 200);
    return (await response.json() as any).data.session;
  };
  const paused = await command(s, "pause");
  assert.equal(await continuation.read("one"), null);
  const resumed = await command(paused, "resume");
  assert.equal((await continuation.read("one"))?.gatewayId, "persona-route");
  const end = await fetch(`${base}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: resumed.id, revision: resumed.revision, action: "stop" }) });
  assert.equal(end.status, 200);
  assert.equal(await continuation.read("one"), null);
  assert.equal(((await (await fetch(base)).json()) as any).data.resumeIntent, null);
  consent = true; body.requestId = "menu-request-2";
  assert.equal(((await (await start()).json()) as any).data.session.saveSummary, true);
  assert.equal((await fetch(`${base}/frame?reviewId=unknown`)).status, 404);
});

test("authenticated remote Agents share companionship start, read and stop", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-remote-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "auth.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "remote-fixture");
  authority.registerAgentCatalog(credential.token, [{ agentId: "worker", provider: "custom-provider" }]);
  const service = new CompanionActivity({ presets: [{ id: "adaptive", label: "自适应", labelEn: "Adaptive", reviewSeconds: 25, replyAgeSeconds: 30, guidance: "observe" }],
    changed: () => {}, reaction: () => {}, save: async () => {}, cancelSpeech: async () => {}, speak: async () => {}, deliver: async () => {} });
  const handler = companionActivityHandler(service, { local: () => false, readOnly: () => false,
    verifyGateway: () => "persona-route", saveSummaryDefault: async () => false, last: async () => null });
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true);
    if (access.kind !== "agent") { response.writeHead(403); response.end(); return; }
    handler(request, new URL(request.url!, `http://${request.headers.host}`), response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await service.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/roles/one/companion`;
  const headers = { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker", "x-rabilink-tunnel-local": "fixture", "content-type": "application/json", origin: "https://remote.invalid" };
  const start = await fetch(`${base}/start`, { method: "POST", headers, body: JSON.stringify({ requestId: "remote-start", presetId: "adaptive", title: "", autoReview: false, voice: false, observationOwner: "browser" }) });
  assert.equal(start.status, 200);
  const session = ((await start.json()) as any).data.session;
  assert.equal((await fetch(base, { headers })).status, 200);
  const stop = await fetch(`${base}/command`, { method: "POST", headers, body: JSON.stringify({ sessionId: session.id, revision: session.revision, action: "stop" }) });
  assert.equal(stop.status, 200);
  authority.setAgentEnabled("remote-fixture", "worker", false);
  assert.equal((await fetch(base, { headers })).status, 403);
});
