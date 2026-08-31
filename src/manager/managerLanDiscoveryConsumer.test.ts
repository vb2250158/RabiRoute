import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverManagerLanEndpoints,
  validateManagerDiscoveryRecords,
  type ManagerDiscoveryServiceRecord
} from "./managerLanDiscoveryConsumer.js";

const service = (
  overrides: Partial<ManagerDiscoveryServiceRecord> = {}
): ManagerDiscoveryServiceRecord => ({
  name: "RabiRoute-test",
  host: "rabi-pc.local",
  port: 54_321,
  addresses: ["192.168.1.20"],
  txt: {
    protocol: "1",
    path: "/.well-known/rabiroute-manager",
    applicationGenerationId: "generation-a",
    managerInstanceId: "manager-a"
  },
  ...overrides
});

const document = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocolVersion: 1,
  applicationGenerationId: "generation-a",
  managerInstanceId: "manager-a",
  guid: "guid-a",
  name: "Rabi PC",
  computerName: "RABI-PC",
  deviceType: "RabiRoute Manager",
  version: "0.2.1",
  ...overrides
});

test("DNS-SD discovery returns the verified complete dynamic Manager URL", async () => {
  const requested: string[] = [];
  const result = await validateManagerDiscoveryRecords([service()], async url => {
    requested.push(url);
    return { code: 0, data: document() };
  });

  assert.deepEqual(requested, ["http://192.168.1.20:54321/.well-known/rabiroute-manager"]);
  assert.equal(result.observedServices, 1);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.endpoints, [{
    ...document(),
    host: "192.168.1.20",
    port: 54_321,
    baseUrl: "http://192.168.1.20:54321"
  }]);
});

test("DNS-SD discovery rejects a well-known document from another generation", async () => {
  const result = await validateManagerDiscoveryRecords([service()], async () => ({
    code: 0,
    data: document({ applicationGenerationId: "generation-b" })
  }));

  assert.equal(result.endpoints.length, 0);
  assert.deepEqual(result.issues.map(issue => issue.code), ["identity_mismatch"]);
});

test("DNS-SD discovery keeps verified peers while reporting invalid services", async () => {
  const invalid = service({
    name: "invalid",
    port: 54_322,
    addresses: ["192.168.1.21"],
    txt: { protocol: "1", path: "/wrong", applicationGenerationId: "generation-x", managerInstanceId: "manager-x" }
  });
  const result = await validateManagerDiscoveryRecords([invalid, service()], async url => ({
    code: 0,
    data: document({ guid: url.includes("192.168.1.20") ? "guid-a" : "guid-x" })
  }));

  assert.equal(result.endpoints.length, 1);
  assert.equal(result.endpoints[0]?.guid, "guid-a");
  assert.deepEqual(result.issues.map(issue => issue.code), ["invalid_txt"]);
});

test("one GUID cannot resolve to competing Manager generations", async () => {
  const second = service({
    name: "RabiRoute-second",
    port: 54_322,
    addresses: ["192.168.1.21"],
    txt: {
      protocol: "1",
      path: "/.well-known/rabiroute-manager",
      applicationGenerationId: "generation-b",
      managerInstanceId: "manager-b"
    }
  });
  const result = await validateManagerDiscoveryRecords([service(), second], async url => ({
    code: 0,
    data: document(url.includes("54322")
      ? { applicationGenerationId: "generation-b", managerInstanceId: "manager-b" }
      : {})
  }));

  assert.equal(result.endpoints.length, 0);
  assert.deepEqual(result.issues.map(issue => issue.code), ["ambiguous_guid"]);
});

test("one GUID cannot select between duplicated network authorities even when lifecycle text is copied", async () => {
  const second = service({ name: "copied", addresses: ["192.168.1.21"] });
  const result = await validateManagerDiscoveryRecords([service(), second], async () => ({ code: 0, data: document() }));
  assert.equal(result.endpoints.length, 0);
  assert.deepEqual(result.issues.map(issue => issue.code), ["ambiguous_guid"]);
});

test("DNS-SD hostnames and public addresses never become Manager authorities", async () => {
  let requests = 0;
  const result = await validateManagerDiscoveryRecords([
    service({ host: "attacker.example", addresses: ["203.0.113.10"] })
  ], async () => {
    requests += 1;
    return { code: 0, data: document() };
  });
  assert.equal(requests, 0);
  assert.equal(result.endpoints.length, 0);
  assert.deepEqual(result.issues.map(issue => issue.code), ["unreachable"]);
});

test("discovery bounds records and concurrent well-known requests", async () => {
  let active = 0;
  let maximumActive = 0;
  let requests = 0;
  const records = Array.from({ length: 40 }, (_, index) => service({
    name: `service-${index}`,
    addresses: [`192.168.1.${index + 1}`],
    port: 54_000 + index
  }));
  const result = await validateManagerDiscoveryRecords(records, async url => {
    requests += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
    return { code: 0, data: document({ guid: `guid-${url}` }) };
  });
  assert.equal(requests, 32);
  assert.ok(maximumActive <= 4, `maximum concurrency was ${maximumActive}`);
  assert.ok(result.issues.some(issue => issue.code === "limit_exceeded"));
});

test("well-known fetches reject redirects and oversized bodies", async () => {
  const observedRedirects: Array<RequestRedirect | undefined> = [];
  await assert.rejects(
    discoverManagerLanEndpoints({
      timeoutMs: 200,
      browse: async () => [service()],
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        observedRedirects.push(init?.redirect);
        return new Response("x".repeat(64 * 1024 + 1), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch
    }),
    /none passed generation fencing/
  );
  assert.deepEqual(observedRedirects, ["error"]);
});

test("no DNS-SD service is a clean empty discovery result", async () => {
  const result = await validateManagerDiscoveryRecords([], async () => {
    throw new Error("fetch must not run");
  });
  assert.deepEqual(result, { observedServices: 0, endpoints: [], issues: [] });
});
