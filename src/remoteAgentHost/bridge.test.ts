import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import test from "node:test";
import { WebSocket } from "ws";
import { REMOTE_AGENT_PROTOCOL_VERSION } from "../messageEndpoints/remoteAgentProtocol.js";
import { RemoteAgentHub } from "../messageEndpoints/remoteAgentManager.js";
import { RemoteAgentHostBridge } from "./bridge.js";
import { RemoteAgentHostConfigStore } from "./configStore.js";

function managerProof(password: string, nonce: string): string {
  return createHmac("sha256", password)
    .update(`rabiroute.remote-agent.v3:manager:${nonce}`)
    .digest("base64url");
}

test("RemoteAgentHostBridge authenticates a primary Manager and accepts a task", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-bridge-"));
  const store = new RemoteAgentHostConfigStore(path.join(root, "config.json"));
  store.patchSettings({ password: "bridge-test-password-32-bytes" });
  const received: string[] = [];
  let resolveTask!: () => void;
  const taskAccepted = new Promise<void>(resolve => { resolveTask = resolve; });
  const server = http.createServer();
  const bridge = new RemoteAgentHostBridge({
    configStore: store,
    server,
    onTask: async task => {
      received.push(task.taskId);
      resolveTask();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    bridge.stop();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/remote-agent/control`);
  t.after(() => socket.close());

  const frames: Array<Record<string, any>> = [];
  socket.on("message", raw => {
    const frame = JSON.parse(raw.toString()) as Record<string, any>;
    frames.push(frame);
    if (frame.type === "challenge") {
      socket.send(JSON.stringify({
        type: "hello",
        protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
        proof: managerProof(store.read().password, frame.nonce),
        manager: { deviceName: "Test Manager" }
      }));
    }
    if (frame.type === "registered") {
      socket.send(JSON.stringify({
        type: "task",
        task: {
          taskId: "task-1",
          deviceId: store.read().deviceId,
          message: "Test task",
          taskKind: "test",
          originGatewayId: "origin",
          status: "delivered",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          events: []
        }
      }));
    }
  });

  await Promise.race([
    taskAccepted,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Remote Agent task was not accepted.")), 3_000))
  ]);
  assert.ok(frames.some(frame => frame.type === "registered"));
  assert.equal(received[0], "task-1");
});

test("primary RemoteAgentHub connects to the Host and delivers a task", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-integration-"));
  const store = new RemoteAgentHostConfigStore(path.join(root, "host-config.json"));
  store.patchSettings({ password: "hub-host-integration-password" });
  const received: string[] = [];
  let resolveAccepted!: () => void;
  const accepted = new Promise<void>(resolve => { resolveAccepted = resolve; });
  const server = http.createServer();
  const bridge = new RemoteAgentHostBridge({
    configStore: store,
    server,
    onTask: async task => {
      received.push(task.message);
      resolveAccepted();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const hub = new RemoteAgentHub({
    managerPort: 8790,
    passwordStorePath: path.join(root, "connections.json"),
    getDefaultGatewayId: () => "main"
  });
  t.after(() => {
    hub.disconnectDevice(store.read().deviceId);
    bridge.stop();
    server.close();
  });
  (hub as unknown as { discovered: Map<string, unknown> }).discovered.set(store.read().deviceId, {
    deviceId: store.read().deviceId,
    deviceName: store.read().deviceName,
    agentType: "rabi-agent",
    agentTypes: store.read().profile.agentAdapters,
    host: "127.0.0.1",
    port: address.port,
    controlUrl: `ws://127.0.0.1:${address.port}/api/remote-agent/control`,
    protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
    discoveredAt: new Date().toISOString()
  });

  const connected = await hub.connectDevice({
    deviceId: store.read().deviceId,
    password: store.read().password
  });
  assert.equal(connected.connected, true);

  const task = await hub.createTask({
    deviceId: store.read().deviceId,
    originGatewayId: "main",
    taskKind: "integration",
    message: "primary Manager integration task"
  });
  await Promise.race([
    accepted,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Host did not receive the primary Manager task.")), 3_000))
  ]);

  assert.equal(task.deviceId, store.read().deviceId);
  assert.deepEqual(received, ["primary Manager integration task"]);
});
