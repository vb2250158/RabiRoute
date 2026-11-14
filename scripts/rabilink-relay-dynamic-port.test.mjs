import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import test from "node:test";

test("relay publishes its OS-assigned endpoint after listening", { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabilink-dynamic-port-"));
  const children = [];
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", error => error.code === "EADDRINUSE" ? resolve() : reject(error));
    occupied.listen(8788, "127.0.0.1", resolve);
  });
  try {
    const endpoints = await Promise.all([undefined, undefined, "PORT", "RABILINK_RELAY_PORT"].map((portVariable, index) => new Promise((resolve, reject) => {
      const env = { ...process.env, HOST: "127.0.0.1", RABILINK_RELAY_DATA_DIR: path.join(root, String(index)) };
      delete env.PORT;
      delete env.RABILINK_RELAY_PORT;
      if (portVariable) env[portVariable] = "0";
      const child = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let pending = "";
      let errors = "";
      child.stderr.on("data", chunk => { errors += chunk; });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`relay exited before readiness: ${code} ${errors}`)));
      child.stdout.on("data", chunk => {
        pending += chunk;
        const match = pending.match(/^RABILINK_RELAY_READY:(\{[^\n]+\})\r?$/m);
        if (!match) return;
        try {
          const endpoint = JSON.parse(match[1]);
          assert.equal(endpoint.pid, child.pid);
          assert.equal(endpoint.host, "127.0.0.1");
          assert.ok(endpoint.port > 0 && endpoint.port <= 65535);
          resolve(endpoint);
        } catch (error) { reject(error); }
      });
    })));
    assert.equal(new Set(endpoints.map(endpoint => endpoint.port)).size, endpoints.length);
    assert.ok(endpoints.every(endpoint => endpoint.port !== 8788));
    for (const endpoint of endpoints) {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/health`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    }
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve))));
    if (occupied.listening) await new Promise(resolve => occupied.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
