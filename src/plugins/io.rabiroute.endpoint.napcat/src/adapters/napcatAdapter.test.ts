import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import type { NapCatInstanceConfig } from "../../../../config.js";
import { createMessageAdapterRuntime } from "../../../../runtime/messageAdapterRuntime.js";
import {
  createNapCatAdapter as createNativeNapCatAdapter,
  type NapCatAdapterDependencies
} from "./napcatAdapter.js";
import type { MessageAdapterDefinition } from "../../../../adapters/messageAdapter.js";

import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";

const createNapCatAdapter = (dependencies: NapCatAdapterDependencies = {}) =>
  createNativeNapCatAdapter({ apiOperations: new ManagerPluginRouteRegistry(), ...dependencies });

function instance(id: string, port: number): NapCatInstanceConfig {
  return {
    id,
    name: `NapCat ${id}`,
    enabled: true,
    autoLoginOnRabiStart: false,
    gatewayPort: port,
    httpUrl: `http://127.0.0.1:${port + 1000}`,
    webuiUrl: `http://127.0.0.1:${port + 2000}`,
    accessToken: ""
  };
}

function listen(server: net.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("TCP server has no address."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

function readStatus(dataDir: string) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "gateway-status.json"), "utf8"));
}

test("automatic WS owns a distinct real socket, publishes its port and preserves the saved zero", async t => {
  const previousGeneration = process.env.RABIROUTE_GATEWAY_GENERATION_ID;
  process.env.RABIROUTE_GATEWAY_GENERATION_ID = "fixture-dynamic-generation";
  t.after(() => { if (previousGeneration === undefined) delete process.env.RABIROUTE_GATEWAY_GENERATION_ID;
    else process.env.RABIROUTE_GATEWAY_GENERATION_ID = previousGeneration; });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-automatic-ws-"));
  const blocker = net.createServer(); const occupiedPort = await listen(blocker);
  t.after(async () => { await close(blocker); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const saved = instance("automatic", 0), registry = new ManagerPluginRouteRegistry();
  let received!: () => void;
  const event = new Promise<void>(resolve => { received = resolve; });
  const adapter = createNapCatAdapter({ instances: () => [saved], dataDir: () => dataDir, apiOperations: registry,
    refreshProfile() {}, async handleEvent() { received(); } });
  const dispose = await adapter.start(); t.after(() => dispose?.());
  const publication = registry.catalogSnapshot().listeners[0]!;
  assert.ok(publication.binding.address.port > 0);
  assert.notEqual(publication.binding.address.port, occupiedPort);
  assert.equal(saved.gatewayPort, 0);
  assert.equal(readStatus(dataDir).napcatInstances.automatic.gatewayPort, publication.binding.address.port);
  assert.equal(readStatus(dataDir).napcatInstances.automatic.listenerReady, true);
  assert.equal(readStatus(dataDir).napcatInstances.automatic.listenerLeaseId, publication.binding.leaseId);
  assert.equal(readStatus(dataDir).gatewayGenerationId, "fixture-dynamic-generation");
  assert.equal(readStatus(dataDir).napcatInstances.automatic.gatewayGenerationId, "fixture-dynamic-generation");
  const socket = await connect(publication.binding.address.port);
  socket.send(JSON.stringify({ post_type: "message", message_type: "private", user_id: 12345, message: "controlled" }));
  await event;
  const closed = waitForClose(socket); const stopping = dispose?.();
  assert.equal(readStatus(dataDir).napcatInstances.automatic.listenerReady, false);
  await stopping; await closed;
  assert.equal(registry.catalogSnapshot().listeners.length, 0);
});

function definition(dependencies: NapCatAdapterDependencies): MessageAdapterDefinition {
  return {
    manifest: {
      type: "napcat",
      label: "NapCat / OneBot",
      host: "gateway",
      transport: "websocket",
      lifecycle: "fiber"
    },
    create: () => createNapCatAdapter(dependencies)
  };
}

test("NapCat Fiber waits for every listener and closes clients and ports", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const firstPort = await freePort();
  const secondPort = await freePort();
  fs.writeFileSync(path.join(dataDir, "gateway-status.json"), JSON.stringify({ pid: 1,
    napcat: { connected: true, activeConnections: 2 },
    napcatInstances: { first: { connected: true, activeConnections: 1 }, second: { connected: true, activeConnections: 1 } } }));
  const adapter = createNapCatAdapter({
    instances: () => [instance("first", firstPort), instance("second", secondPort)],
    dataDir: () => dataDir,
    refreshProfile: () => {}
  });

  const dispose = await adapter.start();
  t.after(() => dispose?.());
  assert.equal(typeof dispose, "function");
  const running = readStatus(dataDir);
  assert.equal(running.napcat.connected, false);
  assert.equal(running.napcat.activeConnections, 0);
  assert.equal(running.napcatInstances.first.connected, false);
  assert.equal(running.napcatInstances.second.connected, false);
  assert.equal(running.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(running.startedAt)));
  assert.ok(Number.isFinite(Date.parse(running.updatedAt)));
  assert.equal(running.messageAdapters.napcat.status, "running");
  assert.equal(running.messageAdapters.napcat.message.includes("2 个实例"), true);

  const socket = await connect(firstPort);
  const closed = waitForClose(socket);
  await dispose?.();
  await closed;

  const firstProbe = net.createServer();
  const secondProbe = net.createServer();
  await listen(firstProbe, firstPort);
  await listen(secondProbe, secondPort);
  await close(firstProbe);
  await close(secondProbe);
  const disabled = readStatus(dataDir);
  assert.equal(disabled.messageAdapters.napcat.status, "disabled");
  assert.equal(disabled.napcatInstances.first.connected, false);
  assert.equal(disabled.napcatInstances.second.connected, false);
});

test("NapCat Fiber can mount, unmount, and mount the same port again", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-runtime-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const port = await freePort();
  const dependencies: NapCatAdapterDependencies = {
    instances: () => [instance("default", port)],
    dataDir: () => dataDir,
    refreshProfile: () => {}
  };
  const runtime = await createMessageAdapterRuntime([definition(dependencies)]);
  t.after(() => runtime.dispose());

  const first = await runtime.mount("napcat");
  await first.dispose();
  const second = await runtime.mount("napcat");
  await second.dispose();

  const probe = net.createServer();
  await listen(probe, port);
  await close(probe);
  assert.equal(readStatus(dataDir).messageAdapters.napcat.status, "disabled");
});

test("NapCat activation failure rolls back listeners created earlier", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-failure-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const blocker = net.createServer();
  const blockedPort = await listen(blocker);
  const firstPort = await freePort(); // Allocate while the conflicting listener owns its port.
  t.after(() => close(blocker));
  const adapter = createNapCatAdapter({
    instances: () => [instance("first", firstPort), instance("blocked", blockedPort)],
    dataDir: () => dataDir,
    refreshProfile: () => {}
  });

  await assert.rejects(async () => { await adapter.start(); }, (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE");
  const probe = net.createServer();
  await listen(probe, firstPort);
  await close(probe);
  assert.equal(readStatus(dataDir).messageAdapters.napcat.status, "error");
});

test("NapCat activation preserves its original failure after joining failed listener cleanup", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-cleanup-failure-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const blocker = net.createServer();
  const blockedPort = await listen(blocker);
  t.after(() => close(blocker));
  const firstPort = await freePort();
  const registry = new ManagerPluginRouteRegistry();
  const register = registry.registerExternalListener.bind(registry);
  t.mock.method(registry, "registerExternalListener", (...args: Parameters<typeof register>) => {
    const binding = register(...args);
    return { ...binding, async dispose() { await binding.dispose(); throw undefined; } };
  });
  const adapter = createNapCatAdapter({ apiOperations: registry,
    instances: () => [instance("first", firstPort), instance("blocked", blockedPort)],
    dataDir: () => dataDir, refreshProfile: () => {}
  });
  await assert.rejects(async () => { await adapter.start(); }, error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].code, "EADDRINUSE");
    assert.equal(error.errors[1], undefined);
    return true;
  });
  const probe = net.createServer();
  await listen(probe, firstPort);
  await close(probe);
  assert.equal(readStatus(dataDir).messageAdapters.napcat.status, "error");
});
