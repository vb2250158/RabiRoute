import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  controlUrlFromObservedAddress,
  REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES,
  REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES,
  RemoteAgentHub
} from "./remoteAgentManager.js";

test("RemoteAgentHub shares the bridge's default file size limits", () => {
  assert.equal(REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES, 10 * 1024 * 1024);
  assert.equal(REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES, 25 * 1024 * 1024);
});

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
  const terminalEventCount = updated.events.length;
  const duplicate = hub.receiveTaskEvent({
    taskId: task.taskId,
    status: "progress",
    device: { deviceId: "builder-device" },
    summary: "late duplicate"
  });
  assert.equal(duplicate.status, "completed");
  assert.equal(duplicate.events.length, terminalEventCount);
  assert.equal(sentPayloads.length, 1);
});

test("RemoteAgentHub sends local files with remote tasks", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-agent-test-"));
  const inputPath = path.join(tempDir, "notes.txt");
  fs.writeFileSync(inputPath, "hello remote file", "utf8");
  const hub = new RemoteAgentHub({
    managerPort: 8790,
    passwordStorePath: path.join(tempDir, "connections.json"),
    fileStoreDir: path.join(tempDir, "files"),
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
    message: "Use the attached file.",
    filePaths: [inputPath]
  });

  assert.equal(task.files.length, 1);
  assert.equal(task.files[0].name, "notes.txt");
  assert.equal(task.files[0].contentBase64, undefined);
  const payload = JSON.parse(sentPayloads[0]) as { task: { files: Array<{ name: string; contentBase64: string }> } };
  assert.equal(payload.task.files[0].name, "notes.txt");
  assert.equal(Buffer.from(payload.task.files[0].contentBase64, "base64").toString("utf8"), "hello remote file");
});

test("RemoteAgentHub stores returned remote files under the task file store", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-agent-test-"));
  const hub = new RemoteAgentHub({
    managerPort: 8790,
    passwordStorePath: path.join(tempDir, "connections.json"),
    fileStoreDir: path.join(tempDir, "files"),
    getDefaultGatewayId: () => "main"
  });
  const deviceRecord = {
    info: { deviceId: "builder-device" },
    socket: {
      readyState: WebSocket.OPEN,
      send: () => undefined
    },
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
  (hub as unknown as { devices: Map<string, unknown> }).devices.set("builder-device", deviceRecord);
  const task = await hub.createTask({
    deviceId: "builder-device",
    originGatewayId: "main",
    message: "Return an artifact."
  });

  const updated = hub.receiveTaskEvent({
    taskId: task.taskId,
    status: "completed",
    device: { deviceId: "builder-device" },
    files: [{
      name: "../artifact.txt",
      contentBase64: Buffer.from("remote artifact", "utf8").toString("base64")
    }]
  });

  const saved = updated.events.at(-1)?.savedFiles?.[0];
  assert.ok(saved?.path);
  assert.equal(saved.name, "artifact.txt");
  assert.equal(fs.readFileSync(saved.path, "utf8"), "remote artifact");
  assert.ok(saved.path.startsWith(path.join(tempDir, "files", task.taskId)));
  assert.equal(updated.events.at(-1)?.files?.[0].contentBase64, undefined);
});

test("RemoteAgentHub connects to scanned devices with password handshake", async (t) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const expectedPassword = "test-only-secret-abcdef";
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/api/remote-agent/control") return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      const nonce = randomBytes(32).toString("base64url");
      ws.send(JSON.stringify({ type: "challenge", protocolVersion: 3, algorithm: "hmac-sha256", nonce }));
      ws.once("message", (data) => {
        const msg = JSON.parse(data.toString()) as { type?: string; proof?: string; protocolVersion?: number };
        const expectedProof = createHmac("sha256", expectedPassword)
          .update(`rabiroute.remote-agent.v3:manager:${nonce}`)
          .digest("base64url");
        if (msg.type !== "hello" || msg.protocolVersion !== 3 || msg.proof !== expectedProof) {
          ws.send(JSON.stringify({ type: "error", error: "Invalid remote Agent password." }));
          ws.close();
          return;
        }
        const serverProof = createHmac("sha256", expectedPassword)
          .update(`rabiroute.remote-agent.v3:server:${nonce}`)
          .digest("base64url");
        ws.send(JSON.stringify({
          type: "registered",
          protocolVersion: 3,
          serverProof,
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
    protocolVersion: 3,
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

test("RemoteAgentHub uses the observed discovery address for control URLs", () => {
  assert.equal(
    controlUrlFromObservedAddress("ws://192.168.0.57:8797/api/remote-agent/control", "26.26.26.1", 8801),
    "ws://26.26.26.1:8801/api/remote-agent/control"
  );
  assert.equal(
    controlUrlFromObservedAddress("", "10.0.0.5", 8797),
    "ws://10.0.0.5:8797/api/remote-agent/control"
  );
  assert.equal(
    controlUrlFromObservedAddress("wss://agent.example.com/api/remote-agent/control", "10.0.0.5", 443, true),
    "wss://agent.example.com/api/remote-agent/control"
  );
  assert.throws(
    () => controlUrlFromObservedAddress("wss://user:secret@agent.example.com/api/remote-agent/control", "10.0.0.5", 443, true),
    /invalid public control URL/
  );
  assert.throws(
    () => controlUrlFromObservedAddress("wss://agent.example.com/api/remote-agent/control?token=secret", "10.0.0.5", 443, true),
    /invalid public control URL/
  );
});

test("RemoteAgentHub requires the exact remote Agent protocol version", async () => {
  const hub = new RemoteAgentHub({
    managerPort: 8790,
    passwordStorePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-agent-test-")), "connections.json"),
    getDefaultGatewayId: () => "main"
  });
  for (const [deviceId, protocolVersion] of [["missing-version", undefined], ["old-version", 2], ["future-version", 4]] as const) {
    (hub as unknown as { discovered: Map<string, unknown> }).discovered.set(deviceId, {
      deviceId,
      host: "127.0.0.1",
      port: 8797,
      controlUrl: "ws://127.0.0.1:8797/api/remote-agent/control",
      protocolVersion,
      discoveredAt: new Date().toISOString()
    });
    await assert.rejects(
      () => hub.connectDevice({ deviceId, password: "test-only-secret-abcdef" }),
      /is incompatible; protocol 3 is required/
    );
  }
});

test("RemoteAgentHub rejects registered before a mutually authenticated challenge", async (t) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.send(JSON.stringify({
        type: "registered",
        protocolVersion: 3,
        serverProof: "not-a-valid-proof",
        device: { deviceId: "spoofed-device" }
      }));
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
  (hub as unknown as { discovered: Map<string, unknown> }).discovered.set("spoofed-device", {
    deviceId: "spoofed-device",
    host: "127.0.0.1",
    port: address.port,
    controlUrl: `ws://127.0.0.1:${address.port}/api/remote-agent/control`,
    protocolVersion: 3,
    discoveredAt: new Date().toISOString()
  });
  await assert.rejects(
    () => hub.connectDevice({ deviceId: "spoofed-device", password: "test-only-secret-abcdef" }),
    /server authentication failed/
  );
});

test("RemoteAgentHub rejects an invalid bridge server proof", async (t) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      const nonce = randomBytes(32).toString("base64url");
      ws.send(JSON.stringify({ type: "challenge", protocolVersion: 3, algorithm: "hmac-sha256", nonce }));
      ws.once("message", () => {
        ws.send(JSON.stringify({
          type: "registered",
          protocolVersion: 3,
          serverProof: "invalid-server-proof",
          device: { deviceId: "invalid-proof-device" }
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
  (hub as unknown as { discovered: Map<string, unknown> }).discovered.set("invalid-proof-device", {
    deviceId: "invalid-proof-device",
    host: "127.0.0.1",
    port: address.port,
    controlUrl: `ws://127.0.0.1:${address.port}/api/remote-agent/control`,
    protocolVersion: 3,
    discoveredAt: new Date().toISOString()
  });
  await assert.rejects(
    () => hub.connectDevice({ deviceId: "invalid-proof-device", password: "test-only-secret-abcdef" }),
    /server authentication failed/
  );
});

test("RemoteAgentHub closes and permanently settles an authentication timeout", async (t) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const password = "test-only-secret-abcdef";
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      const nonce = randomBytes(32).toString("base64url");
      ws.send(JSON.stringify({ type: "challenge", protocolVersion: 3, algorithm: "hmac-sha256", nonce }));
      ws.once("message", () => {
        const serverProof = createHmac("sha256", password)
          .update(`rabiroute.remote-agent.v3:server:${nonce}`)
          .digest("base64url");
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "registered",
              protocolVersion: 3,
              serverProof,
              device: { deviceId: "slow-device" }
            }));
          }
        }, 60);
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-agent-test-"));
  const passwordStorePath = path.join(tempDir, "connections.json");
  const hub = new RemoteAgentHub({
    managerPort: 8790,
    passwordStorePath,
    connectionTimeoutMs: 20,
    getDefaultGatewayId: () => "main"
  });
  (hub as unknown as { discovered: Map<string, unknown> }).discovered.set("slow-device", {
    deviceId: "slow-device",
    host: "127.0.0.1",
    port: address.port,
    controlUrl: `ws://127.0.0.1:${address.port}/api/remote-agent/control`,
    protocolVersion: 3,
    discoveredAt: new Date().toISOString()
  });
  await assert.rejects(
    () => hub.connectDevice({ deviceId: "slow-device", password }),
    /connection timed out/
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fs.existsSync(passwordStorePath), false);
  const device = hub.listDevices().find((item) => item.deviceId === "slow-device");
  assert.equal(device?.connected, false);
  assert.equal(device?.passwordSaved, false);
  assert.match(device?.connectionError || "", /connection timed out/);
});
