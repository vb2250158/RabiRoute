import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createDshConnectionClient, cleanDshOrigin, dshConnectionLabel, isLocalDshSetupPage } from "../src/dshConnectionClient";

test("login link uses one POST body, never query or replay; returned origin is clean", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createDshConnectionClient((async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ ok: true, connection: { baseUrl: "http://127.0.0.1:3333/", state: "connected", message: "untrusted secret" } });
  }) as typeof fetch);
  const result = await client.connect({ launchUrl: "http://127.0.0.1:3333/?token=fixture-only" });
  assert.equal(result.baseUrl, "http://127.0.0.1:3333");
  assert.equal(result.message, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/agent-adapters/dsh/connection");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.redirect, "error");
  assert.match(String(calls[0].init?.body), /fixture-only/);
});
test("failures never expose response secrets or retry", async () => {
  let count = 0;
  const client = createDshConnectionClient((async () => { count++; return Response.json({ message: "secret-fixture" }, { status: 500 }); }) as typeof fetch);
  await assert.rejects(client.connect({ launchUrl: "secret-fixture" }), error => error instanceof Error && !error.message.includes("secret-fixture"));
  assert.equal(count, 1);
});
test("metadata and migration follow the contract without session requests", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const item = { baseUrl: "http://localhost:3333", state: "legacy" };
  const client = createDshConnectionClient((async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ ok: true, revision: 3, endpoints: [item], connection: item });
  }) as typeof fetch);
  await client.list(); await client.status(item.baseUrl); await client.connect({ baseUrl: item.baseUrl }); await client.disconnect(item.baseUrl);
  assert.equal(calls[0].url, "/api/agent-adapters/dsh/connections");
  assert.match(calls[1].url, /connection\?baseUrl=/);
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { baseUrl: item.baseUrl, expectedRevision: 3 });
  assert.equal(calls[3].init?.method, "DELETE");
  assert.equal(calls.some(call => /session|scan/.test(call.url)), false);
});
test("remote pages cannot present local authorization as their own computer", () => {
  assert.equal(isLocalDshSetupPage({ hostname: "127.0.0.1", pathname: "/" }), true);
  for (const hostname of ["remote.example", "192.168.1.2", "localhost.example"]) assert.equal(isLocalDshSetupPage({ hostname, pathname: "/" }), false);
  assert.equal(isLocalDshSetupPage({ hostname: "localhost", pathname: "/rabilink/proxy" }), false);
  assert.equal(dshConnectionLabel("connected"), "连接验证通过");
  assert.throws(() => cleanDshOrigin("http://localhost:3333/?token=fixture"));
});
test("panel clears secrets, loads once, has no timers and never changes session binding", () => {
  const component = fs.readFileSync(new URL("../src/components/DshConnectionPanel.vue", import.meta.url), "utf8");
  assert.match(component, /type="password"/);
  assert.match(component, /onMounted\(refresh\)/);
  assert.match(component, /finally \{ launchUrl.value = ""/);
  assert.doesNotMatch(component, /localStorage|sessionStorage|console\.|setInterval|setTimeout|sessionId|session\/prompt/);
  assert.match(component, /不会删除 DSH 会话/);
  const page = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
  assert.match(page, /<DshConnectionPanel/);
  assert.doesNotMatch(page, /DSH 扫描会读取 <code>RabiRoute Agent/);
});
