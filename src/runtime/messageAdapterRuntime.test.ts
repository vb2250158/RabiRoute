import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import { createWebhookAdapter, type WebhookAdapterProfile } from "../adapters/webhookAdapter.js";
import type { MessageAdapterDefinition, MessageAdapterDispose } from "../adapters/messageAdapter.js";
import { createMessageAdapterRuntime } from "./messageAdapterRuntime.js";

function profile(port: number): WebhookAdapterProfile {
  return {
    type: "webhook",
    label: "测试 Webhook",
    source: "webhook-test",
    path: "/runtime-test",
    port,
    acceptedTypes: ["webhook.text"],
    routeKind: "voice_transcript",
    missingTextMessage: "missing text"
  };
}

function definition(
  adapterProfile: WebhookAdapterProfile,
  onListening?: () => void | MessageAdapterDispose | Promise<void | MessageAdapterDispose>
): MessageAdapterDefinition {
  return {
    manifest: {
      type: "webhook",
      label: adapterProfile.label,
      host: "gateway",
      transport: "http",
      lifecycle: "fiber"
    },
    create: () => createWebhookAdapter(adapterProfile, { onListening })
  };
}

async function listen(server: http.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server has no TCP address.");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function get(port: number, requestPath: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: requestPath, headers: { connection: "close" }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
  });
}

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-runtime-"));
const previousDataDir = config.dataDir;
const previousAdapterTypes = config.messageAdapterTypes;

test.before(() => {
  config.dataDir = testDataDir;
  config.messageAdapterTypes = ["webhook"];
});

test.after(() => {
  config.dataDir = previousDataDir;
  config.messageAdapterTypes = previousAdapterTypes;
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

function resetGatewayStatus(): void {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.mkdirSync(testDataDir, { recursive: true });
}

test("Webhook Fiber releases its port and supports repeated mounting", async (t) => {
  resetGatewayStatus();
  const dataDir = testDataDir;
  const port = await freePort();
  let listeningCount = 0;
  const runtime = await createMessageAdapterRuntime([
    definition(profile(port), () => { listeningCount += 1; })
  ]);
  t.after(() => runtime.dispose());

  assert.deepEqual(runtime.registry.listManifests(), [{
    type: "webhook",
    label: "测试 Webhook",
    host: "gateway",
    transport: "http",
    lifecycle: "fiber"
  }]);

  const first = await runtime.mount("webhook");
  const firstResponse = await get(port, "/runtime-test");
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(JSON.parse(firstResponse.body).status, "ready");
  await first.dispose();

  const portProbe = http.createServer();
  await listen(portProbe, port);
  await close(portProbe);

  const second = await runtime.mount("webhook");
  assert.equal((await get(port, "/runtime-test")).statusCode, 200);
  await second.dispose();
  assert.equal(listeningCount, 2);

  const status = JSON.parse(fs.readFileSync(path.join(dataDir, "gateway-status.json"), "utf8"));
  assert.equal(status.messageAdapters.webhook.status, "disabled");
});

test("Webhook Fiber closes its listener before awaiting acquired resource cleanup", async (t) => {
  resetGatewayStatus();
  const port = await freePort();
  let acquired = 0;
  let released = 0;
  let markReleaseStarted!: () => void;
  let completeRelease!: () => void;
  const releaseStarted = new Promise<void>((resolve) => { markReleaseStarted = resolve; });
  const releaseGate = new Promise<void>((resolve) => { completeRelease = resolve; });
  const runtime = await createMessageAdapterRuntime([
    definition(profile(port), () => {
      acquired += 1;
      return async () => {
        released += 1;
        markReleaseStarted();
        await releaseGate;
      };
    })
  ]);
  t.after(() => runtime.dispose());

  const mounted = await runtime.mount("webhook");
  assert.equal(acquired, 1);
  assert.equal(released, 0);
  const disposing = mounted.dispose();
  await releaseStarted;
  assert.equal(released, 1);

  const portProbe = http.createServer();
  await listen(portProbe, port);
  await close(portProbe);
  completeRelease();
  await disposing;
});

test("Webhook disposal ignores request abort errors caused by listener shutdown", async (t) => {
  resetGatewayStatus();
  const port = await freePort();
  const runtime = await createMessageAdapterRuntime([definition(profile(port))]);
  t.after(() => runtime.dispose());
  const mounted = await runtime.mount("webhook");

  let requestClosed!: () => void;
  const closed = new Promise<void>((resolve) => { requestClosed = resolve; });
  const request = http.request({
    host: "127.0.0.1",
    port,
    path: "/runtime-test",
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "100" },
    agent: false
  });
  request.on("error", () => requestClosed());
  request.on("close", () => requestClosed());
  await new Promise<void>((resolve) => request.once("socket", (socket) => {
    if ((socket as import("node:net").Socket).connecting) socket.once("connect", resolve);
    else resolve();
  }));
  request.write("{");
  await new Promise((resolve) => setImmediate(resolve));

  await mounted.dispose();
  await closed;
  const status = JSON.parse(fs.readFileSync(path.join(testDataDir, "gateway-status.json"), "utf8"));
  assert.equal(status.messageAdapters.webhook.status, "disabled");
});

test("Webhook activation failure leaves no listener and can be retried", async (t) => {
  resetGatewayStatus();
  const port = await freePort();
  const blocker = http.createServer();
  await listen(blocker, port);
  t.after(() => close(blocker));

  const runtime = await createMessageAdapterRuntime([definition(profile(port))]);
  t.after(() => runtime.dispose());

  await assert.rejects(runtime.mount("webhook"), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "EADDRINUSE");
    return true;
  });

  await close(blocker);
  const mounted = await runtime.mount("webhook");
  assert.equal((await get(port, "/runtime-test")).statusCode, 200);
  await mounted.dispose();
});

test("Webhook partial activation rollback closes an already-bound listener", async (t) => {
  resetGatewayStatus();
  const port = await freePort();
  const runtime = await createMessageAdapterRuntime([
    definition(profile(port), () => { throw new Error("listening hook failed"); })
  ]);
  t.after(() => runtime.dispose());

  await assert.rejects(runtime.mount("webhook"), /listening hook failed/);

  const portProbe = http.createServer();
  await listen(portProbe, port);
  await close(portProbe);
});

test("duplicate Message Adapter definitions fail registration", async () => {
  const port = await freePort();
  const duplicate = definition(profile(port));
  await assert.rejects(
    createMessageAdapterRuntime([duplicate, duplicate]),
    /Message adapter already registered: webhook/
  );
});
