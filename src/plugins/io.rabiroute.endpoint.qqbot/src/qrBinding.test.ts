import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { QrConnectCallbacks } from "@tencent-connect/qqbot-connector";
import { ManagerPluginRouteRegistry } from "@rabiroute/host-api/manager/managerPluginRouteRegistry";
import { createBotAccounts } from "./accounts.js";
import { createBotQrOperations } from "./qrBinding.js";

test("QQ OAuth binds the mobile-selected bot without disclosing credentials and cancels unconfirmed writes", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-qqbot-qr-"));
  const accounts = createBotAccounts(root);
  const registry = new ManagerPluginRouteRegistry();
  const controller = new AbortController();
  const identity = { applicationGenerationId: "test-generation", managerInstanceId: "test-manager" };
  const credentials = { appId: "213456789", appSecret: "fixture-selected-qq-bot" };
  let callbacks: QrConnectCallbacks;
  let sdkSignal: AbortSignal | undefined;
  let finishCheck: () => void = () => {};
  let deferCheck = false;
  let checks = 0;
  let starts = 0;
  const operations = createBotQrOperations(accounts, { async check(input) {
    checks++;
    assert.deepEqual(input, { ...credentials, sandbox: false });
    if (deferCheck) await new Promise<void>(resolve => { finishCheck = resolve; });
  } }, { lifecycleFence: identity, access: () => true, readOnly: false }, controller.signal, (input, options) => {
    starts++;
    callbacks = input;
    sdkSignal = options?.signal;
    assert.equal(options?.displayQrCodeToConsole, false);
    return () => {};
  });
  const registration = await registry.registerOperationsAsync("qqbot-qr-fixture", operations, controller.signal);
  const server = http.createServer((req, res) => {
    if (!registry.handle(req, new URL(req.url!, "http://127.0.0.1"), res)) res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    controller.abort();
    await registration.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/message/qqbot/qr/`;
  const headers = { "x-rabiroute-expected-application-generation-id": identity.applicationGenerationId,
    "x-rabiroute-expected-manager-instance-id": identity.managerInstanceId };
  const request = (id: string, method = "GET") => fetch(base + id, { method, headers });
  async function eventually(id: string, predicate: (state: any) => boolean) {
    for (let attempt = 0; attempt < 25; attempt++) {
      const result = await (await request(id)).json();
      assert.ok(!JSON.stringify(result).includes(credentials.appSecret));
      if (predicate(result.data)) return result.data;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail("QQ QR state did not update");
  }

  const id = randomUUID();
  const stale = await fetch(base + id, { method: "POST" });
  assert.equal(stale.status, 409);
  assert.equal(starts, 0);
  const started = await request(id, "POST");
  assert.equal(started.status, 200);
  assert.equal(started.headers.get("cache-control"), "no-store");
  assert.equal((await started.json()).data.state, "waiting");
  assert.equal((await request(id, "POST")).status, 200);
  assert.equal(starts, 1);
  callbacks!.onQrDisplayed!("https://q.qq.com/fixture-qr");
  const waiting = await eventually(id, state => !!state.qrCodeDataUrl);
  assert.match(waiting.qrCodeDataUrl, /^data:image\/png;base64,/);
  callbacks!.onSuccess([credentials]);
  const ready = await eventually(id, state => state.state === "ready");
  assert.equal(ready.accounts.length, 1);
  const account = ready.accounts[0];
  assert.equal(account.appId, credentials.appId);
  assert.equal(account.sandbox, false);
  assert.equal(accounts.credentials(account.id)?.appSecret, credentials.appSecret);
  assert.ok(!(await fs.readFile(path.join(root, "data/.runtime/qqbot/accounts.json"), "utf8")).includes(credentials.appSecret));
  assert.equal(sdkSignal?.aborted, true);

  const repeat = randomUUID();
  await request(repeat, "POST");
  callbacks!.onSuccess([credentials]);
  const reauthorized = await eventually(repeat, state => state.state === "ready");
  assert.equal(reauthorized.accounts[0].id, account.id);
  assert.equal(reauthorized.accounts[0].revision, account.revision);

  const cancelled = randomUUID();
  deferCheck = true;
  await request(cancelled, "POST");
  callbacks!.onSuccess([credentials]);
  assert.equal((await (await request(cancelled, "DELETE")).json()).data.state, "cancelled");
  assert.equal(sdkSignal?.aborted, true);
  finishCheck();
  assert.equal((await (await request(cancelled)).json()).data.state, "cancelled");
  assert.equal(checks, 3);
  assert.equal(accounts.receipt(`qqbot-qr:${cancelled}`), undefined);
});
