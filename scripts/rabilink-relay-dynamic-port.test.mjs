import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("relay publishes its OS-assigned endpoint after listening", { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabilink-dynamic-port-"));
  const children = [];
  try {
    const endpoints = await Promise.all([0, 1].map(index => new Promise((resolve, reject) => {
      const env = { ...process.env, HOST: "127.0.0.1", RABILINK_RELAY_DATA_DIR: path.join(root, String(index)) };
      env.PORT = "0";
      delete env.RABILINK_RELAY_PORT;
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
    assert.notEqual(endpoints[0].port, endpoints[1].port);
    for (const endpoint of endpoints) {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/health`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    }
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve))));
    await fs.rm(root, { recursive: true, force: true });
  }
});
