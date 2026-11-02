import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./Start-RokidNativeTtsPlaybackServer.ps1", import.meta.url));

test("TTS servers choose separate live ports even when the old port is occupied", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rokid-tts-port-"));
  const occupied = net.createServer();
  const children = [];
  try {
    await new Promise((resolve, reject) => {
      occupied.once("error", error => error.code === "EADDRINUSE" ? resolve() : reject(error));
      occupied.listen(8794, "127.0.0.1", resolve);
    });
    const ready = await Promise.all([0, 1].map(async index => {
      const readyFile = path.join(directory, `${index}.json`);
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-DryRun", "-ReadyFile", readyFile], { stdio: "ignore", windowsHide: true });
      children.push(child);
      for (let attempt = 0; attempt < 150; attempt++) {
        if (child.exitCode !== null) throw new Error(`TTS child exited with ${child.exitCode}`);
        try { return JSON.parse(await fs.readFile(readyFile, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("TTS server did not publish readiness");
    }));
    assert.notEqual(ready[0].port, ready[1].port);
    assert.ok(ready.every(item => item.port !== 8794));
    for (const item of ready) {
      const response = await fetch(item.playbackUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "test" }) });
      assert.equal(response.status, 202);
      assert.equal((await response.json()).ok, true);
    }
    const explicitFile = path.join(directory, "occupied.json");
    const explicit = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-DryRun", "-Port", "8794", "-ReadyFile", explicitFile], { stdio: "ignore", windowsHide: true });
    children.push(explicit);
    const exitCode = await new Promise(resolve => explicit.once("exit", resolve));
    assert.notEqual(exitCode, 0);
    await assert.rejects(fs.access(explicitFile), { code: "ENOENT" });
    const blocked = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-DryRun", "-Port", "6000"], { stdio: "ignore", windowsHide: true });
    children.push(blocked);
    assert.notEqual(await new Promise(resolve => blocked.once("exit", resolve)), 0);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve))));
    if (occupied.listening) await new Promise(resolve => occupied.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
