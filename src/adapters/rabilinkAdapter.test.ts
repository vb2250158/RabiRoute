import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import { createMessageAdapterRuntime } from "../runtime/messageAdapterRuntime.js";
import { rabiLinkMessageAdapterDefinition } from "./builtinMessageAdapters.js";
import { rabiLinkRelayWorkerSnapshotForTests } from "./rabilinkRelayWorker.js";
import { createRabiLinkAdapter } from "./rabilinkAdapter.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";

function controlledRabiLinkDefinition() {
  const registry = new ManagerPluginRouteRegistry();
  return { ...rabiLinkMessageAdapterDefinition, create: () => createRabiLinkAdapter({
    apiOperations: { registerExternalListener: definition => registry.registerExternalListener("rabilink-fixture", definition) }
  }) };
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

function configureRabiLink(t: test.TestContext, port: number, relayEnabled: boolean, dispose: () => Promise<void>): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rabilink-adapter-"));
  const previous = {
    dataDir: config.dataDir,
    rabiLinkWebhookPort: config.rabiLinkWebhookPort,
    rabiLinkWebhookHost: config.rabiLinkWebhookHost,
    rabiLinkWebhookPath: config.rabiLinkWebhookPath,
    rabiLinkRelayEnabled: config.rabiLinkRelayEnabled,
    rabiLinkRelayUrl: config.rabiLinkRelayUrl,
    rabiLinkRelayDeviceId: config.rabiLinkRelayDeviceId
  };
  Object.assign(config, {
    dataDir,
    rabiLinkWebhookPort: port,
    rabiLinkWebhookHost: "127.0.0.1",
    rabiLinkWebhookPath: "/rabilink-test",
    rabiLinkRelayEnabled: relayEnabled,
    rabiLinkRelayUrl: relayEnabled ? "https://relay.test" : "",
    rabiLinkRelayDeviceId: "adapter-test"
  });
  t.after(async () => {
    try { await dispose(); }
    finally { Object.assign(config, previous); fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
  return dataDir;
}

test("RabiLink Fiber owns the HTTP listener and a disabled Relay lease", async (t) => {
  const port = await freePort();
  let runtime: Awaited<ReturnType<typeof createMessageAdapterRuntime>> | undefined;
  const dataDir = configureRabiLink(t, port, false, async () => { await runtime?.dispose(); });
  runtime = await createMessageAdapterRuntime([controlledRabiLinkDefinition()]);

  const mounted = await runtime.mount("rabilink");
  const response = await get(port, "/rabilink-test");
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).adapterType, "rabilink");
  assert.deepEqual(rabiLinkRelayWorkerSnapshotForTests(), []);

  await mounted.dispose();
  const status = JSON.parse(fs.readFileSync(path.join(dataDir, "gateway-status.json"), "utf8"));
  assert.equal(status.messageAdapters.rabilink.status, "disabled");
  assert.equal(status.messageAdapters.rabilink.relayWorker, "disabled");

  const portProbe = http.createServer();
  await listen(portProbe, port);
  await close(portProbe);
});

test("RabiLink port conflicts reject mounting before a Relay worker starts", async (t) => {
  const port = await freePort();
  let runtime: Awaited<ReturnType<typeof createMessageAdapterRuntime>> | undefined;
  configureRabiLink(t, port, true, async () => { await runtime?.dispose(); });
  const blocker = http.createServer();
  await listen(blocker, port);
  t.after(() => close(blocker));
  runtime = await createMessageAdapterRuntime([controlledRabiLinkDefinition()]);

  await assert.rejects(runtime.mount("rabilink"), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "EADDRINUSE");
    return true;
  });
  assert.deepEqual(rabiLinkRelayWorkerSnapshotForTests(), []);
});
