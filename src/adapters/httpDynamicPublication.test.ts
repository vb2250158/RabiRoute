import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import type { ApiExternalListenerPublication } from "../manager/apiExternalListenerBinding.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { createGatewayListenerRuntime } from "../runtime/gatewayListenerRuntime.js";
import { createFeishuAdapter } from "../plugins/io.rabiroute.endpoint.feishu/src/adapters/feishuAdapter.js";
import { createWebhookAdapter } from "./webhookAdapter.js";

function request(port: number, pathname: string, body: Buffer, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method: "POST", agent: false,
      headers: { connection: "close", "content-length": body.length, ...headers } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode ?? 0)); response.once("error", reject);
    });
    req.once("error", reject); req.end(body);
  });
}

for (const type of ["rabilink", "feishu"] as const) {
  test(`${type} zero binds concurrent actual ports and revokes its publication before accepted work drains`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `rabi-${type}-dynamic-`));
    const previous = { dataDir: config.dataDir, memoryDataDir: config.memoryDataDir };
    const oldGeneration = process.env.RABIROUTE_GATEWAY_GENERATION_ID;
    process.env.RABIROUTE_GATEWAY_GENERATION_ID = "http-dynamic-fixture";
    const disposers: Array<() => void | Promise<void>> = [];
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const accepted = new Promise<void>(resolve => { entered = resolve; });
    t.after(async () => {
      release(); await Promise.all(disposers.map(dispose => dispose()));
      Object.assign(config, previous);
      if (oldGeneration === undefined) delete process.env.RABIROUTE_GATEWAY_GENERATION_ID;
      else process.env.RABIROUTE_GATEWAY_GENERATION_ID = oldGeneration;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const active: Array<{ port: number; dataDir: string; dispose: () => void | Promise<void> }> = [];
    for (let index = 0; index < 2; index++) {
      const dataDir = path.join(root, String(index));
      Object.assign(config, { dataDir, memoryDataDir: dataDir });
      const registry = new ManagerPluginRouteRegistry();
      let publication: ApiExternalListenerPublication | undefined;
      const waitForRelease = async () => { if (index === 0) { entered(); await blocked; } };
      const adapter = type === "rabilink" ? createWebhookAdapter({ type, label: type, source: type, port: 0, path: "/callback",
        acceptedTypes: ["webhook.text"], routeKind: "voice_transcript", missingTextMessage: "missing text" }, {
        apiOperations: { registerExternalListener: definition => registry.registerExternalListener("fixture", definition) },
        publishListener: value => { publication = value; },
        async acceptPayload() { await waitForRelease(); return { time: 0, rawMessage: "fixture", messageId: "fixture" }; }
      }) : createFeishuAdapter({
        settings: () => ({ appId: "fixture-app", appSecret: "fixture-app-secret", verificationToken: "fixture-verification",
          encryptKey: "fixture-encryption", eventSubscriptionEnabled: true, webhookPort: 0, webhookPath: "/callback" }),
        dataDir: () => dataDir, memoryDataDir: () => dataDir, persist: () => true,
        forward: waitForRelease, apiOperations: registry, publishListener: value => { publication = value; }
      });
      const dispose = await adapter.start();
      assert.equal(typeof dispose, "function"); if (typeof dispose !== "function") throw new Error("No native disposer.");
      disposers.push(dispose);
      const port = publication?.binding.address.port;
      assert.ok(typeof port === "number" && port > 0);
      const status = JSON.parse(fs.readFileSync(path.join(dataDir, "gateway-status.json"), "utf8"));
      assert.equal(status.messageAdapters[type].listenerReady, true);
      assert.equal(status.messageAdapters[type].listenerLeaseId, publication?.binding.leaseId);
      assert.equal(status.messageAdapters[type].gatewayGenerationId, "http-dynamic-fixture");
      assert.equal(status.httpCallbacks[type].url, `http://127.0.0.1:${port}/callback`);
      active.push({ port, dataDir, dispose });
    }
    assert.notEqual(active[0]!.port, active[1]!.port);
    // RabiLink's status writer uses the current Gateway's dataDir, which is stable in production.
    Object.assign(config, { dataDir: active[0]!.dataDir, memoryDataDir: active[0]!.dataDir });
    const body = Buffer.from(JSON.stringify(type === "rabilink" ? { text: "controlled" } : {
      schema: "2.0", header: { event_id: "fixture-event", event_type: "im.message.receive_v1", token: "fixture-verification" },
      event: { sender: { sender_id: { open_id: "fixture-sender" } }, message: { message_id: "fixture-message", chat_id: "fixture-chat",
        chat_type: "group", message_type: "text", content: JSON.stringify({ text: "controlled" }) } }
    }));
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = "fixture-nonce";
    const headers: Record<string, string> = type === "feishu" ? { "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": nonce,
      "x-lark-signature": createHash("sha256").update(timestamp).update(nonce).update("fixture-encryption").update(body).digest("hex") } : {};
    const response = request(active[0]!.port, "/callback", body, headers).catch(() => undefined);
    await accepted;
    let retired = false;
    const retiring = Promise.resolve(active[0]!.dispose()).then(() => { retired = true; });
    const status = JSON.parse(fs.readFileSync(path.join(active[0]!.dataDir, "gateway-status.json"), "utf8"));
    assert.equal(status.messageAdapters[type].listenerReady, false);
    assert.equal(status.httpCallbacks[type].port, active[0]!.port, "retired port remains diagnostic metadata only");
    await response; assert.equal(retired, false);
    release(); await retiring; assert.equal(retired, true);
    await assert.rejects(request(active[0]!.port, "/callback", Buffer.from("{}")), /ECONNREFUSED|ECONNRESET|socket hang up/);
  });
}

test("protocol address readback returns only one current original owner and disappears before native drain", async () => {
  const runtime = createGatewayListenerRuntime({ identity: { gatewayId: "readback", gatewayGenerationId: "generation", pid: process.pid }, publish() {} });
  const definition = (listenerId: string, port: number) => ({ listenerId, address: { protocol: "http" as const, hostname: "127.0.0.1", port },
    protocol: "feishu-events-v2", invocation: "discovery-only" as const, authentication: { kind: "native" as const, description: "fixture" } });
  const one = runtime.registerExternalListener("one", definition("one", 12345));
  assert.equal(runtime.listenerAddressForProtocol("feishu-events-v2")?.port, 12345);
  const two = runtime.registerExternalListener("two", definition("two", 12346));
  assert.equal(runtime.listenerAddressForProtocol("feishu-events-v2"), undefined);
  two.stopAccepting(); assert.equal(runtime.listenerAddressForProtocol("feishu-events-v2")?.port, 12345);
  one.stopAccepting(); assert.equal(runtime.listenerAddressForProtocol("feishu-events-v2"), undefined);
  await runtime.dispose();
});
