import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CodexDesktopIpcClient, codexDesktopIpcPaths } from "../lib/codex-desktop-ipc.mjs";

test("Desktop discovery keeps explicit paths, current Codex home and older per-user sockets", () => {
  const options = { platform: "darwin", env: {}, homeDir: "/home/fixture", tempDir: "/tmp/fixture", uid: 501 };
  assert.deepEqual(codexDesktopIpcPaths(options), [
    path.join(options.homeDir, ".codex/ipc/ipc.sock"), path.join(options.tempDir, "codex-ipc/ipc-501.sock")
  ]);
  const custom = path.join(options.homeDir, "custom");
  const overridden = { ...options, env: { CODEX_HOME: custom, CODEX_DESKTOP_IPC_PATH: " explicit.sock " } };
  assert.deepEqual(codexDesktopIpcPaths(overridden), ["explicit.sock", path.join(custom, "ipc/ipc.sock"), path.join(options.tempDir, "codex-ipc/ipc-501.sock")]);
  assert.deepEqual(codexDesktopIpcPaths({ ...options, platform: "linux" }), codexDesktopIpcPaths(options));
  assert.deepEqual(codexDesktopIpcPaths({ ...options, platform: "win32" }), ["\\\\.\\pipe\\codex-ipc"]);
  const canonical = path.join(custom, "ipc/ipc.sock");
  assert.equal(codexDesktopIpcPaths({ ...overridden, env: { CODEX_HOME: custom, CODEX_DESKTOP_IPC_PATH: canonical } }).filter(p => p === canonical).length, 1);
});

test("a missing candidate connects to the same Desktop protocol without sending a task message", async t => {
  const suffix = randomUUID();
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\rabi-ipc-${suffix}` : path.join(os.tmpdir(), `rabi-ipc-${suffix}.sock`);
  const methods = [];
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
        methods.push(request.method);
        const body = Buffer.from(JSON.stringify({ type: "response", requestId: request.requestId, resultType: "success", result: { clientId: "fixture-desktop" } }));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body]));
      }
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  const client = new CodexDesktopIpcClient({ pipePaths: [endpoint + "-missing", endpoint], requestTimeoutMs: 1000 });
  t.after(async () => { client.close(); await new Promise(resolve => server.close(resolve)); });
  await client.connect();
  assert.equal(client.clientId, "fixture-desktop");
  assert.deepEqual(methods, ["initialize"]);
});
