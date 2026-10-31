import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { HostInstanceIdentityReset, IdentityResetAuthorizationError } from "./identityResetRoutes.js";
import { createCorePublicOperations, type CorePublicOperationsContext } from "./corePublicOperations.js";
import type { ApiOperationInput } from "./apiOperationContract.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { installDataMutationAuditSink } from "../observability/dataMutationAudit.js";

const operationId = "4dc1ac0f-12eb-4f71-9cd1-eac946a8b93f";
const localOperationId = "67cbf080-4354-4b90-9062-5a248e407e60";
const expectedGuid = "647f6388-a4dc-4327-ab17-3ccbd43ef9e2";
const newGuid = "86fc86cc-bde4-4968-9dbf-052ee1d21c4c";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reset-authority-"));
  const executable = path.join(root, "Host-fixture.exe");
  await fs.writeFile(executable, "fixture only; never executed");
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const global = new RabiGlobalConfigStore(root);
  global.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node");
  const hooks: {
    body?: () => Promise<void>;
    execute?: () => Promise<void>;
    beforeRoute?: (request: http.IncomingMessage) => void;
    complete?: boolean;
  } = {};
  let hostCalls = 0;
  const statusFile = (id = operationId) => path.join(root, "data", "rabilink", "identity-resets", id, "host-status.json");
  const requestFile = path.join(root, "data", "rabilink", "identity-reset-requests", `${operationId}.json`);
  const writeStatus = async (id = operationId, state = "committed") => {
    const file = statusFile(id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, operationId: id, oldGuid: expectedGuid,
      state, ...(state === "committed" ? { newGuid } : {}), privateKey: "private", ownerHash: "private", token: "private", message: "private" }));
  };
  const service = new HostInstanceIdentityReset({ stateRoot: root, applicationGenerationId: "fixture-generation",
    environment: { RABIROUTE_HOSTED: "1", RABIROUTE_HOST_EXECUTABLE: executable },
    execute: async (program, args) => {
      hostCalls++;
      assert.equal(program, executable);
      assert.deepEqual(args.slice(0, 4), ["--command", "reset-instance-id", "--application-generation-id", "fixture-generation"]);
      assert.equal(args[6], "--json");
      const input = JSON.parse(await fs.readFile(args[5]!, "utf8"));
      await hooks.execute?.();
      if (hooks.complete) await writeStatus(input.operationId);
      return { ok: true, state: "queued", operationId: input.operationId };
    }
  });
  const registry = new ManagerPluginRouteRegistry();
  const definitions = createCorePublicOperations({
    identity: () => ({ applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager" }),
    identityReset: { service, currentGuid: () => expectedGuid }
  } as unknown as CorePublicOperationsContext).filter(value => value.contract.pathTemplate.startsWith("/api/rabi/identity/reset-instance-id"));
  const registration = registry.registerOperations("fixture-reset-authority", definitions.map(definition => ({ ...definition,
    async prepare(input: Omit<ApiOperationInput, "body">) {
      const prepared = await definition.prepare!(input);
      if (typeof prepared !== "function") return prepared;
      return async (parsed: ApiOperationInput) => { if (parsed.request.method === "POST") await hooks.body?.(); return prepared(parsed); };
    }
  })));
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, global.getLanAgentAdmissionPolicy().enabled, () => global.getLanAgentAdmissionPolicy());
    if (access.kind === "denied") {
      response.writeHead(access.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: access.error })); return;
    }
    if (access.kind === "agent") {
      // A real principal is independent of loopback/DNS/forwarded-header exceptions.
      Object.defineProperty(request.socket, "remoteAddress", { value: "192.0.2.10", configurable: true });
    }
    hooks.beforeRoute?.(request);
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://localhost").pathname, body, undefined));
    // The registry owns one response publication; no private business headers precede its authority fence.
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
    // Do not alter the transport's address for the next keep-alive request.
    if (access.kind === "agent") Reflect.deleteProperty(request.socket, "remoteAddress");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await registration.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/rabi/identity/reset-instance-id`;
  const headers = { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "agent", "content-type": "application/json" };
  return { root, authority, global, credential, hooks, service, headers, url, statusFile, requestFile, writeStatus,
    hostCalls: () => hostCalls,
    revoke: () => authority.setNodeEnabled("node", false),
    restore: () => authority.setNodeEnabled("node", true),
    post: (remote = true, id = operationId, input: unknown = { operationId: id, expectedGuid, confirmed: true }) => fetch(url, {
      method: "POST", headers: remote ? headers : { "content-type": "application/json" }, body: JSON.stringify(input)
    }) };
}
async function denied(response: Response, commitState: "not_started" | "unknown") {
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.data, undefined);
  assert.ok(body.code === "authorization_revoked" || /AUTHORITY|SOURCE/.test(body.errorCode ?? ""));
  assert.equal(body.commitState ?? body.mutationOutcome ?? "not_started", commitState);
  if (commitState === "unknown") assert.equal(body.uncertain, true);
  for (const header of ["etag", "idempotency-key", "x-private-status"]) assert.equal(response.headers.get(header), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

test("reset custom-provider principal has equivalent local POST/GET, confirmation and exact completed replay", async t => {
  const f = await fixture(t);
  f.hooks.complete = true;
  for (const remote of [true, false]) {
    const id = remote ? operationId : localOperationId;
    const queued = await f.post(remote, id);
    assert.equal(queued.status, 202);
    assert.deepEqual(await queued.json(), { code: 0, data: { operationId: id, state: "queued" } });
    const completed = await fetch(`${f.url}/${id}`, { headers: remote ? f.headers : {} });
    assert.equal(completed.status, 200);
    assert.deepEqual(await completed.json(), { code: 0, data: { operationId: id, state: "committed", newGuid } });
    const replay = await f.post(remote, id);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { code: 0, data: { operationId: id, state: "committed", newGuid } });
  }
  assert.equal(f.hostCalls(), 2);
  for (const remote of [true, false]) {
    for (const input of [{ operationId, expectedGuid }, { operationId, expectedGuid, confirmed: false },
      { operationId, expectedGuid, confirmed: true, privatePath: "ignored?" }]) assert.equal((await f.post(remote, operationId, input)).status, 400);
    assert.equal((await f.post(remote, operationId, { operationId, expectedGuid: newGuid, confirmed: true })).status, 409);
    assert.equal((await f.post(remote, operationId, { operationId, expectedGuid, confirmed: true, extra: "x".repeat(3000) })).status, 413);
  }
  assert.equal(f.hostCalls(), 2);
});

test("reset credential-first ingress denies invalid/disabled agents and never substitutes local authority", async t => {
  const f = await fixture(t);
  const invalidHeaders: Record<string, string>[] = [{ authorization: "Bearer lan1:invalid", "x-rabiroute-agent-id": "agent" },
    { "x-rabiroute-agent-id": "agent" }];
  for (const headers of invalidHeaders) {
    const response = await fetch(f.url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ operationId, expectedGuid, confirmed: true }) });
    assert.ok([401, 403].includes(response.status));
  }
  f.revoke();
  assert.equal((await f.post()).status, 403);
  assert.equal(f.hostCalls(), 0);
  // Principal removal after ingress is sticky and cannot fall back, even on loopback.
  f.restore();
  f.hooks.beforeRoute = request => {
    f.revoke();
    assert.equal(evaluateLanAgentRequest(request, f.authority, true, () => f.global.getLanAgentAdmissionPolicy()).kind, "denied");
    Object.defineProperty(request.socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
  };
  await denied(await f.post(), "not_started");
});

test("reset body wait retains original Agent and global admission leases across revoke/ABA", async t => {
  for (const mode of ["agent-revoke", "agent-ABA", "global-revoke", "global-ABA"]) {
    await t.test(mode, async t => {
      const f = await fixture(t);
      const entered = deferred(), release = deferred();
      f.hooks.body = async () => { entered.resolve(); await release.promise; };
      const response = f.post();
      await entered.promise;
      if (mode.startsWith("agent")) { f.revoke(); if (mode.endsWith("ABA")) f.restore(); }
      else { f.global.patch({ webguiLan: { enabled: false } }); if (mode.endsWith("ABA")) f.global.patch({ webguiLan: { enabled: true } }); }
      release.resolve();
      await denied(await response, "not_started");
      assert.equal(f.hostCalls(), 0);
      await assert.rejects(fs.access(f.requestFile));
    });
  }
});

test("reset revalidates filesystem mkdir/write/read/status awaits and never calls Host after revoke", async t => {
  for (const stage of ["mkdir", "write", "write-failure", "request-read", "status-stat", "status-read"]) {
    await t.test(stage, async t => {
      const f = await fixture(t);
      if (stage.includes("read") || stage === "status-stat") {
        await fs.mkdir(path.dirname(f.requestFile), { recursive: true });
        await fs.writeFile(f.requestFile, JSON.stringify({ operationId, expectedGuid }));
        await f.writeStatus();
      }
      const method = stage === "mkdir" ? "mkdir" : stage.startsWith("write") ? "writeFile" : stage === "status-stat" ? "stat" : "readFile";
      const original = fs[method].bind(fs);
      let revoked = false;
      // Overloaded fs promises retain their public signatures at the mock boundary.
      t.mock.method(fs, method, async (...args: Parameters<typeof original>) => {
        const target = String(args[0]);
        const matches = stage === "mkdir" ? target.endsWith("identity-reset-requests") : stage.startsWith("write") || stage === "request-read" ? target === f.requestFile : target === f.statusFile();
        const result = await Reflect.apply(original, fs, args);
        if (matches && !revoked) {
          revoked = true; f.revoke();
          if (stage === "write-failure") throw new Error("fixture write failed after side effect");
        }
        return result;
      });
      await denied(await f.post(), stage === "mkdir" ? "not_started" : "unknown");
      assert.equal(revoked, true);
      assert.equal(f.hostCalls(), 0);
      if (stage === "mkdir") await assert.rejects(fs.access(f.requestFile));
      else await fs.access(f.requestFile);
    });
  }
});

test("reset Host success/rejection with revoked lease suppresses queued receipt and does not swallow auth error", async t => {
  for (const reject of [false, true]) {
    await t.test(String(reject), async t => {
      const f = await fixture(t);
      f.hooks.execute = async () => { f.revoke(); if (reject) throw new Error("fixture Host rejected"); };
      await denied(await f.post(), "unknown");
      assert.equal(f.hostCalls(), 1);
      await fs.access(f.requestFile);
    });
  }
});

test("reset revocation in the mutation audit immediately before Host dispatch prevents execution", async t => {
  const f = await fixture(t);
  let audited = false;
  const uninstall = installDataMutationAuditSink(record => {
    if (record.event === "device_identity_reset_request_created") { audited = true; f.revoke(); }
  });
  t.after(uninstall);
  await denied(await f.post(), "unknown");
  assert.equal(audited, true);
  assert.equal(f.hostCalls(), 0);
  await fs.access(f.requestFile);
});

test("reset authorization checked immediately before dispatch and again before POST receipt", async t => {
  for (const stage of ["before-dispatch", "before-receipt"]) {
    await t.test(stage, async t => {
      const f = await fixture(t);
      const enqueue = f.service.enqueue.bind(f.service);
      if (stage === "before-dispatch") {
        t.mock.method(f.service, "enqueue", async (...args: Parameters<typeof enqueue>) => {
          f.revoke(); return enqueue(...args);
        });
      } else {
        t.mock.method(f.service, "enqueue", async (...args: Parameters<typeof enqueue>) => {
          const result = await enqueue(...args); f.revoke(); return result;
        });
      }
      await denied(await f.post(), stage === "before-dispatch" ? "not_started" : "unknown");
      assert.equal(f.hostCalls(), stage === "before-dispatch" ? 0 : 1);
    });
  }
});

test("reset GET suppresses data after status read and deferred wait with original lease ABA", async t => {
  for (const stage of ["status-stat", "status-read", "deferred-wait", "before-disclosure"]) {
    await t.test(stage, async t => {
      const f = await fixture(t);
      await f.writeStatus();
      if (stage.startsWith("status")) {
        const method = stage === "status-stat" ? "stat" : "readFile";
        const original = fs[method].bind(fs);
        t.mock.method(fs, method, async (...args: Parameters<typeof original>) => {
          const result = await Reflect.apply(original, fs, args);
          if (String(args[0]) === f.statusFile()) f.revoke();
          return result;
        });
      } else {
        const waitStatus = f.service.waitStatus.bind(f.service);
        t.mock.method(f.service, "waitStatus", async (...args: Parameters<typeof waitStatus>) => {
          const result = await waitStatus(...args);
          f.revoke();
          if (stage === "deferred-wait") f.restore();
          return result;
        });
      }
      await denied(await fetch(`${f.url}/${operationId}`, { headers: f.headers }), "not_started");
      assert.equal(f.hostCalls(), 0);
    });
  }
});

test("reset real queued GET wait wakes after policy ABA but discloses no committed status", async t => {
  const f = await fixture(t);
  await f.writeStatus(operationId, "queued");
  const entered = deferred();
  const original = fs.stat.bind(fs);
  let reads = 0;
  t.mock.method(fs, "stat", async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (String(args[0]) === f.statusFile() && ++reads === 2) entered.resolve();
    return result;
  });
  const response = fetch(`${f.url}/${operationId}`, { headers: f.headers });
  await entered.promise; // Initial read and watcher registration-race read have both reached the real owner.
  f.global.patch({ webguiLan: { enabled: false } });
  f.global.patch({ webguiLan: { enabled: true } });
  await f.writeStatus();
  await denied(await response, "not_started");
  assert.equal(f.hostCalls(), 0);
});

test("reset internal authorize errors preserve the owner's no-side-effect classification", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.enqueue({ operationId, expectedGuid }, () => { throw new Error("denied"); }),
    (error: unknown) => error instanceof IdentityResetAuthorizationError && error.commitState === "not_started");
  assert.equal(f.hostCalls(), 0);
});
