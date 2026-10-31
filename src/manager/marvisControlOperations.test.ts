import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMarvisControlOperations } from "./marvisControlOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

/** Test only the HTTP boundary; the controlled opener never launches a user desktop application. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "marvis-operation-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "marvis-node");
  const calls: unknown[] = []; let fail = false, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("marvis", createMarvisControlOperations(body => {
    calls.push(body); if (fail) throw new Error("Native opener rejected the launch.");
    return { ok: true, mode: "desktop", target: body.appId || "native-default", message: "Launch attempted." };
  }));
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority("/api/agent/marvis-open", body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
    entered();
  });
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await rm(root, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/agent/marvis-open?ignored=yes`;
  const begin = () => {
    let request!: http.ClientRequest;
    const result = new Promise<{ status: number; body: any }>((resolve, reject) => {
      request = http.request(url, { method: "POST", headers: { authorization: "Bearer " + credential.token, "content-type": "text/plain" } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); request.on("error", reject); request.setTimeout(10000, () => request.destroy(new Error("Owned Marvis HTTP fixture timeout.")));
    });
    return { request, result };
  };
  const send = async (body: unknown) => { const pending = begin(); pending.request.end(JSON.stringify(body)); return pending.result; };
  return { calls, registration, started, begin, send, fail: () => { fail = true; }, disable: () => { authority.setNodeEnabled(credential.nodeId, false, true); } };
}

test("an enrolled unbound node invokes the native opener once and receives launch-attempt DTO", async t => {
  const f = await fixture(t), body = { appId: "example.app", url: null, ignored: "preserved for native owner" };
  assert.deepEqual(await f.send(body), { status: 200, body: { ok: true, mode: "desktop", target: "example.app", message: "Launch attempted." } });
  assert.deepEqual(f.calls, [body]);
  assert.equal((await f.send({})).status, 200); assert.deepEqual(f.calls[1], {});
});

test("invalid optional field types fail before launching and owner errors retain native status", async t => {
  const f = await fixture(t);
  assert.equal((await f.send({ appId: 1 })).status, 400); assert.equal((await f.send({ url: false })).status, 400); assert.equal(f.calls.length, 0);
  f.fail(); assert.deepEqual(await f.send({ appId: null }), { status: 400, body: { ok: false, message: "Native opener rejected the launch." } }); assert.equal(f.calls.length, 1);
});

test("revoking original connection during body decoding prevents the host launch", async t => {
  const f = await fixture(t), pending = f.begin(); pending.request.write("{"); await f.started; f.disable(); pending.request.end("}");
  assert.equal((await pending.result).status, 403); assert.equal(f.calls.length, 0);
});

test("retirement joins an admitted body and removes future host launch admission", async t => {
  const f = await fixture(t), pending = f.begin(); pending.request.write("{"); await f.started;
  let retired = false; const retirement = f.registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  pending.request.end("}"); assert.equal((await pending.result).status, 200); await retirement; assert.equal(f.calls.length, 1);
});
