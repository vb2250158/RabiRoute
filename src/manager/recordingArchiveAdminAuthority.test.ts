import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { RecordingArchiveBindings, archiveSettingsEtag } from "./recordingArchiveBindings.js";
import { recordingArchiveAdminFixtureHandler as recordingArchiveAdminHandler } from "./resourceApiTestSupport.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { assertLanAgentBodyAuthority, registerLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";

const input = { owner: "phone", roleId: "role", storageNamespaceId: "11111111-2222-3333-4444-555555555555", provision: true, enabled: true, expectedRevision: 0 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-authority-"));
  const role = path.join(dir, "role");
  await fs.mkdir(path.join(role, "all-day-recording"), { recursive: true });
  const authority = new LanAgentAuthority({ statePath: path.join(dir, "authority.json") });
  const global = new RabiGlobalConfigStore(dir);
  global.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node");
  const bindings = new RecordingArchiveBindings(dir, () => role);
  const etag = archiveSettingsEtag(await bindings.listBindings());
  const admitted = deferred();
  const options = { bindings, receiptRoot: dir, identity: () => ({ applicationGenerationId: "gen", managerInstanceId: "instance" }), workerId: () => "fixture-pc", readOnly: () => false };
  const handler = recordingArchiveAdminHandler(options);
  const server = http.createServer((req, res) => {
    if (req.headers["x-rabiroute-agent-id"] !== undefined) {
      assert.equal(evaluateLanAgentRequest(req, authority, true, () => global.getLanAgentAdmissionPolicy()).kind, "agent");
      registerLanAgentBodyGuard(req, body => assertLanAgentBodyAuthority(
        new URL(req.url!, "http://localhost").pathname, body, { provider: "custom-provider" }
      ));
      admitted.resolve();
    }
    handler(req, new URL(req.url!, "http://localhost"), res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/resource-cache/archive-settings`;
  const headers = { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "agent", "content-type": "application/json", "if-match": etag, "idempotency-key": "operation", "x-rabiroute-expected-application-generation-id": "gen", "x-rabiroute-expected-manager-instance-id": "instance" };
  return { dir, role, authority, global, bindings, admitted, options, url, headers,
    revoke: () => authority.setNodeEnabled("node", false),
    put: () => fetch(url, { method: "PUT", headers, body: JSON.stringify(input) }) };
}

async function denied(response: Response, commitState: "not_started" | "unknown") {
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { code: "authorization_revoked", commitState });
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("idempotency-key"), null);
}

test("archive authenticated custom provider has local-equivalent settings and exact durable replay", async t => {
  const value = await fixture(t);
  const remote = await fetch(value.url, { headers: value.headers });
  const local = await fetch(value.url);
  assert.equal(remote.status, 200); assert.equal(local.status, 200);
  assert.deepEqual(await remote.json(), await local.json());
  assert.equal(remote.headers.get("etag"), local.headers.get("etag"));
  const first = await value.put(); assert.equal(first.status, 200);
  const replay = await value.put(); assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);
  assert.equal(replay.headers.get("etag"), first.headers.get("etag"));
  assert.ok(await value.bindings.lookupOwner("phone"));
});

test("archive waits never disclose a revoked or ABA-replaced original principal", async t => {
  for (const mode of ["revoke", "agent-aba", "global-aba", "reenroll"]) {
    await t.test(mode, async child => {
      const value = await fixture(child), entered = deferred(), release = deferred();
      const read = value.bindings.listBindings.bind(value.bindings);
      child.mock.method(value.bindings, "listBindings", async () => {
        const data = await read(); entered.resolve(); await release.promise; return data;
      });
      const pending = fetch(value.url, { headers: value.headers });
      await entered.promise;
      value.revoke();
        value.authority.setNodeEnabled("node", true);
      if (mode === "global-aba") {
        value.global.patch({ webguiLan: { enabled: false } });
        value.global.patch({ webguiLan: { enabled: true } });
      }
      if (mode === "reenroll") {
        value.authority.revokeNode("node");
        const fresh = value.authority.enroll(value.authority.issueBootstrapTicket().ticket, "node");
      }
      release.resolve();
      await denied(await pending, "not_started");
    });
  }
});

test("archive streamed PUT revocation fails before dispatch or provisioning", async t => {
  const value = await fixture(t);
  const pending = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const request = http.request(value.url, { method: "PUT", headers: value.headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on("error", reject);
    request.write("{");
    void value.admitted.promise.then(() => { value.revoke(); request.end(JSON.stringify(input).slice(1)); });
  });
  assert.deepEqual(await pending, { status: 403, body: { code: "authorization_revoked", commitState: "not_started" } });
  assert.equal(await value.bindings.lookupOwner("phone"), null);
  await assert.rejects(fs.access(path.join(value.role, "all-day-recording", "media-archive")));
});

test("archive file awaits fence settings publication and namespace marker; dispatched denial stays uncertain", async t => {
  for (const stage of ["lock", "root", "namespace-open", "namespace-write", "namespace-sync", "config-open", "config-write", "config-sync"]) {
    await t.test(stage, async child => {
      const value = await fixture(child);
      let intercepted = false;
      if (stage === "root") {
        const lstat = fs.lstat.bind(fs);
        child.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
          const result = await lstat(...args);
          if (!intercepted && String(args[0]) === value.role) { intercepted = true; value.revoke(); }
          return result;
        });
      } else {
        const open = fs.open.bind(fs);
        child.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
          const handle = await open(...args);
          const name = String(args[0]);
          const target = stage === "lock" ? name === path.join(value.dir, "resource-cache.json.lock")
            : stage.startsWith("namespace-") ? name.includes("namespace.json.") && name.endsWith(".partial")
              : name.startsWith(path.join(value.dir, "resource-cache.json.")) && name.endsWith(".partial");
          if (target && !intercepted) {
            intercepted = true;
            if (stage === "lock" || stage.endsWith("open")) value.revoke();
            else {
              const method = stage.endsWith("sync") ? "sync" : "writeFile";
              const original = handle[method].bind(handle);
              child.mock.method(handle, method, async (...values: any[]) => {
                const result = await (original as (...args: any[]) => Promise<unknown>)(...values);
                value.revoke(); return result;
              });
            }
          }
          return handle;
        });
      }
      await denied(await value.put(), "unknown");
      assert.equal(intercepted, true, "must exercise the real filesystem await");
      assert.equal(await value.bindings.lookupOwner("phone"), null);
      if (stage.startsWith("namespace-") || stage === "lock" || stage === "root")
        await assert.rejects(fs.access(path.join(value.role, "all-day-recording", "media-archive", "namespace.json")));
    });
  }
});

test("archive revoke after settings commit suppresses receipt, not the already committed write", async t => {
  const value = await fixture(t);
  const configure = value.bindings.configureAdministrative.bind(value.bindings);
  t.mock.method(value.bindings, "configureAdministrative", async (...args: Parameters<typeof configure>) => {
    const result = await configure(...args); value.revoke(); return result;
  });
  await denied(await value.put(), "unknown");
  assert.equal((await value.bindings.lookupOwner("phone"))?.bindingRevision, 1);
  assert.equal((await value.bindings.listBindings()).revision, 1);
});
