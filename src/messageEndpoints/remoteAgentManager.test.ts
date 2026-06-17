import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { RemoteAgentHub } from "./remoteAgentManager.js";

test("RemoteAgentHub rejects task events from devices that do not own the task", async () => {
  const hub = new RemoteAgentHub({
    managerPort: 8790,
    passwordStorePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-agent-test-")), "connections.json"),
    getDefaultGatewayId: () => "main"
  });
  const sentPayloads: string[] = [];
  const deviceRecord = {
    info: { deviceId: "builder-device" },
    socket: {
      readyState: WebSocket.OPEN,
      send: (payload: string) => sentPayloads.push(payload)
    },
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
  (hub as unknown as { devices: Map<string, unknown> }).devices.set("builder-device", deviceRecord);

  const task = await hub.createTask({
    deviceId: "builder-device",
    originGatewayId: "main",
    message: "Run the remote build."
  });

  assert.throws(
    () => hub.receiveTaskEvent({
      taskId: task.taskId,
      status: "completed",
      device: { deviceId: "other-device" }
    }),
    /does not own task/
  );

  const updated = hub.receiveTaskEvent({
    taskId: task.taskId,
    status: "completed",
    device: { deviceId: "builder-device" }
  });
  assert.equal(updated.status, "completed");
  assert.equal(sentPayloads.length, 1);
});

test("RemoteAgentHub connects to scanned devices with password handshake", async (t) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const expectedPassword = "123456";
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/api/remote-agent/control") return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.once("message", (data) => {
        const msg = JSON.parse(data.toString()) as { type?: string; password?: string };
        if (msg.type !== "hello" || msg.password !== expectedPassword) {
          ws.send(JSON.stringify({ type: "error", error: "Invalid remote Agent password." }));
          ws.close();
          return;
        }
        ws.send(JSON.stringify({
          type: "registered",
          device: {
            deviceId: "builder-device",
            deviceName: "Builder",
            agentType: "codex",
            defaultCwd: "C:/work"
          }
        }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    wss.close();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const hub = new RemoteAgentHub({
    managerPort: 8790,
    passwordStorePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-agent-test-")), "connections.json"),
    getDefaultGatewayId: () => "main"
  });
  t.after(() => {
    hub.disconnectDevice("builder-device");
  });
  (hub as unknown as { discovered: Map<string, unknown> }).discovered.set("builder-device", {
    deviceId: "builder-device",
    deviceName: "Builder",
    agentType: "codex",
    host: "127.0.0.1",
    port: address.port,
    controlUrl: `ws://127.0.0.1:${address.port}/api/remote-agent/control`,
    discoveredAt: new Date().toISOString()
  });

  await assert.rejects(
    () => hub.connectDevice({ deviceId: "builder-device", password: "wrong" }),
    /Invalid remote Agent password/
  );

  const connected = await hub.connectDevice({ deviceId: "builder-device", password: expectedPassword });
  assert.equal(connected.connected, true);
  assert.equal(connected.deviceId, "builder-device");
  assert.equal(connected.passwordSaved, true);
  assert.equal(connected.defaultCwd, "C:/work");
});
