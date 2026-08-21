import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import type { NapCatInstanceConfig } from "../config.js";
import { createMessageAdapterRuntime } from "../runtime/messageAdapterRuntime.js";
import {
  createNapCatAdapter,
  type NapCatAdapterDependencies
} from "./napcatAdapter.js";
import type { MessageAdapterDefinition } from "./messageAdapter.js";

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
  const adapter = createNapCatAdapter({
    instances: () => [instance("first", firstPort), instance("second", secondPort)],
    dataDir: () => dataDir,
    refreshProfile: () => {}
  });

  const dispose = await adapter.start();
  assert.equal(typeof dispose, "function");
  const running = readStatus(dataDir);
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
  const firstPort = await freePort();
  const blocker = net.createServer();
  const blockedPort = await listen(blocker);
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
