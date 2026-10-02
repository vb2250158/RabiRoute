import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostInstanceIdentityReset, handleInstanceIdentityReset } from "./identityResetRoutes.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";

const operationId = "4dc1ac0f-12eb-4f71-9cd1-eac946a8b93f";
const expectedGuid = "647f6388-a4dc-4327-ab17-3ccbd43ef9e2";

async function fixture(t: test.TestContext, available = true, savedGuid = expectedGuid) {
  const calls: unknown[] = [];
  const server = http.createServer((request, response) => {
    handleInstanceIdentityReset(request, new URL(request.url!, "http://localhost"), response, {
      service: {
        available: () => available,
        enqueue: async input => { calls.push(input); return { operationId: input.operationId, state: "queued" }; },
        status: async id => id === operationId ? { operationId: id, state: "queued" } : undefined
      },
      currentGuid: () => savedGuid,
      trustedRemote: request => request.headers["x-test-remote-agent"] === "true",
      readJson: async (request, maximum) => {
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > maximum) throw new Error("too large"); }
        return JSON.parse(body);
      },
      json: (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const url = `http://127.0.0.1:${port}/api/rabi/identity/reset-instance-id`;
  return { calls, url, requestAuthority: (host: string, origin: string) => new Promise<number>((resolve, reject) => {
    const request = http.request(url, { method: "POST", headers: { host, origin, "content-type": "application/json" } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode!));
    });
    request.once("error", reject); request.end(JSON.stringify({ operationId, expectedGuid, confirmed: true }));
  }), request: (body: unknown, headers: Record<string, string> = {}) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
  }) };
}

test("confirmed local reset returns a queued operation, with no claim of completion", async t => {
  const f = await fixture(t);
  const response = await f.request({ operationId, expectedGuid, confirmed: true });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { code: 0, data: { operationId, state: "queued" } });
  assert.deepEqual(f.calls, [{ operationId, expectedGuid }]);
  assert.equal((await fetch(`${f.url}/${operationId}`)).status, 200);
});

test("legacy uppercase GUID is passed exactly to the offline CAS owner", async t => {
  const f = await fixture(t, true, expectedGuid.toUpperCase());
  assert.equal((await f.request({ operationId, expectedGuid, confirmed: true })).status, 202);
  assert.deepEqual(f.calls, [{ operationId, expectedGuid: expectedGuid.toUpperCase() }]);
});

test("local authority permits localhost and bracketed IPv6 only at the current bound port", async t => {
  const f = await fixture(t);
  const port = new URL(f.url).port;
  for (const hostname of ["localhost", "[::1]"]) {
    const host = `${hostname}:${port}`;
    assert.equal(await f.requestAuthority(host, `http://${host}`), 202);
  }
  assert.equal(await f.requestAuthority(`rebound.example.test:${port}`, `http://rebound.example.test:${port}`), 403);
  assert.equal(await f.requestAuthority("localhost:1", "http://localhost:1"), 403);
});

test("reset rejects cross-origin, Relay, P2P and trusted remote Agent requests", async t => {
  const f = await fixture(t);
  const headerCases: Record<string, string>[] = [
    { origin: "https://other.example.test" }, { "sec-fetch-site": "cross-site" },
    { "x-rabilink-tunnel-local": "generation" }, { "x-rabiroute-relay-proxy": "1" },
    { "x-rabiroute-peer-proxy": "1" }, { "x-test-remote-agent": "true" },
    { "x-forwarded-for": "192.0.2.10" },
    { host: "rebound.example.test", origin: "http://rebound.example.test", "sec-fetch-site": "same-origin" },
    { host: "localhost:1", origin: "http://localhost:1", "sec-fetch-site": "same-origin" },
    { origin: f.url.replace("http:", "https:").replace("/api/rabi/identity/reset-instance-id", "") }
  ];
  for (const headers of headerCases) {
    assert.equal((await f.request({ operationId, expectedGuid, confirmed: true }, headers)).status, 403);
  }
  assert.equal(f.calls.length, 0);
});

test("reset fences the GUID and rejects missing confirmation, extra fields and oversized bodies", async t => {
  const f = await fixture(t);
  for (const body of [ { operationId, expectedGuid }, { operationId, expectedGuid, confirmed: false },
    { operationId, expectedGuid, confirmed: true, extra: "ignored?" },
    { operationId: "../escape", expectedGuid, confirmed: true },
    { operationId, expectedGuid, confirmed: true, large: "x".repeat(3000) } ]) {
    assert.equal((await f.request(body)).status, 400);
  }
  assert.equal((await f.request({ operationId, expectedGuid: operationId, confirmed: true })).status, 409);
  assert.equal((await f.request({ operationId, expectedGuid, confirmed: true }, { "content-type": "text/plain" })).status, 415);
  assert.equal(f.calls.length, 0);
});

test("source Manager cannot pretend a reset is available", async t => {
  const f = await fixture(t, false);
  assert.equal((await f.request({ operationId, expectedGuid, confirmed: true })).status, 503);
  assert.equal(f.calls.length, 0);
});

test("Host enqueue uses a fixed command, generation fence, persisted request and sanitized receipt", async t => {
  const mutations: RecordedDataMutationAudit[] = [];
  const stopAudit = installDataMutationAuditSink(record => mutations.push(record));
  t.after(stopAudit);
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-reset-api-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const executable = path.join(stateRoot, "Host.exe");
  await fs.writeFile(executable, "fixture");
  let count = 0;
  const service = new HostInstanceIdentityReset({ stateRoot, applicationGenerationId: "generation-fixture",
    environment: { RABIROUTE_HOSTED: "1", RABIROUTE_HOST_EXECUTABLE: executable },
    execute: async (program, args) => {
      assert.equal(program, executable);
      assert.deepEqual(args.slice(0, 4), ["--command", "reset-instance-id", "--application-generation-id", "generation-fixture"]);
      assert.deepEqual(JSON.parse(await fs.readFile(args[5]!, "utf8")), { operationId, expectedGuid });
      count++;
      return { ok: true, state: "queued", operationId };
    }
  });
  assert.equal((await service.enqueue({ operationId, expectedGuid })).state, "queued");
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.event, "device_identity_reset_request_created");
  assert.equal(mutations[0]?.operationId, operationId);
  assert.equal(mutations[0]?.outcome, "committed");
  await assert.rejects(service.enqueue({ operationId, expectedGuid }), /结果未确认/);
  assert.equal(mutations.length, 1);
  assert.equal(count, 1);
  const folder = path.join(stateRoot, "data", "rabilink", "identity-resets", operationId);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "host-status.json"), JSON.stringify({ schemaVersion: 1, operationId, oldGuid: expectedGuid, state: "committed", newGuid: operationId,
    privateKey: "private", ownerHash: "private", token: "private", message: "private" }));
  assert.deepEqual(await service.status(operationId), { operationId, state: "committed", newGuid: operationId });
  assert.equal((await service.enqueue({ operationId, expectedGuid })).state, "committed");
  assert.equal(count, 1);
  await assert.rejects(service.enqueue({ operationId, expectedGuid: operationId }), /其他请求/);
  await assert.rejects(service.status("../escape"), /操作 ID 无效/);
  for (const newGuid of [undefined, "invalid", expectedGuid.toUpperCase()]) {
    await fs.writeFile(path.join(folder, "host-status.json"), JSON.stringify({ schemaVersion: 1, operationId, oldGuid: expectedGuid, state: "committed", newGuid }));
    await assert.rejects(service.status(operationId), /操作状态无效/);
  }
});

test("a queued status wait wakes on its operation file event and stops on cancellation", async t => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-reset-wait-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const directory = path.join(stateRoot, "data", "rabilink", "identity-resets", operationId);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "host-status.json");
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, operationId, oldGuid: expectedGuid, state: "queued" }));
  const service = new HostInstanceIdentityReset({ stateRoot, applicationGenerationId: "generation" });
  const waiting = service.waitStatus(operationId, new AbortController().signal);
  await new Promise(resolve => setTimeout(resolve, 30));
  await fs.writeFile(`${file}.tmp`, JSON.stringify({ schemaVersion: 1, operationId, oldGuid: expectedGuid, state: "committed", newGuid: operationId }));
  await fs.rename(`${file}.tmp`, file);
  assert.equal((await waiting)?.state, "committed");
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, operationId, oldGuid: expectedGuid, state: "queued" }));
  const controller = new AbortController();
  const cancelled = service.waitStatus(operationId, controller.signal);
  controller.abort();
  assert.equal((await cancelled)?.state, "queued");
});
