/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import type { XiaomiHomeAuthorizationSnapshot } from "../../src/shared/xiaomiHomeAuthContract";
import { xiaomiHomeAuthClient } from "../src/xiaomiHomeAuthClient";

const snapshot: XiaomiHomeAuthorizationSnapshot = {
  schemaVersion: 1,
  state: "ready",
  configured: true,
  credentialSource: "protected",
  removable: true,
  baseUrl: "http://127.0.0.1:8123",
  endpointAccountId: "account-stable",
  revision: "authorization-current"
};

test("Xiaomi Home credential client fences every mutation and only sends the candidate on connect", async () => {
  const candidate = ["candidate", "secret"].join("-");
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "00000000-0000-4000-8000-000000000001" }
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    if (String(input) === "/meta") {
      return new Response(JSON.stringify({ applicationGenerationId: "generation-current", managerInstanceId: "manager-current" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ code: 0, data: snapshot }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    await xiaomiHomeAuthClient.read();
    await xiaomiHomeAuthClient.connect({
      accessToken: candidate,
      baseUrl: "http://127.0.0.1:8123",
      settingsRevision: "settings-current",
      authorizationRevision: "authorization-current"
    });
    await xiaomiHomeAuthClient.refresh("authorization-current");
    await xiaomiHomeAuthClient.disconnect("authorization-current");
    assert.deepEqual(requests.map(item => String(item.input)), [
      "/api/agent/xiaomi-home/auth",
      "/meta",
      "/api/agent/xiaomi-home/auth",
      "/meta",
      "/api/agent/xiaomi-home/auth/refresh",
      "/meta",
      "/api/agent/xiaomi-home/auth"
    ]);
    const mutationRequests = requests.filter(item => String(item.input) !== "/meta" && item.init?.method);
    for (const item of mutationRequests) {
      const headers = new Headers(item.init?.headers);
      assert.equal(headers.get("x-rabiroute-expected-application-generation-id"), "generation-current");
      assert.equal(headers.get("x-rabiroute-expected-manager-instance-id"), "manager-current");
      assert.match(String(headers.get("idempotency-key")), /^xiaomi-home-(connect|refresh|disconnect)-/);
    }
    assert.deepEqual(JSON.parse(String(mutationRequests[0]?.init?.body)), {
      accessToken: candidate,
      baseUrl: "http://127.0.0.1:8123",
      settingsRevision: "settings-current",
      authorizationRevision: "authorization-current"
    });
    assert.deepEqual(JSON.parse(String(mutationRequests[1]?.init?.body)), { authorizationRevision: "authorization-current" });
    assert.deepEqual(JSON.parse(String(mutationRequests[2]?.init?.body)), { authorizationRevision: "authorization-current" });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
  }
});
