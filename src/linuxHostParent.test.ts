import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("Linux hosted Manager requires IPC and shuts down when the owning Host disappears", { skip: process.platform !== "linux" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-host-parent-test-"));
  const entry = path.join(dir, "child.mjs");
  fs.writeFileSync(entry, `import { bindLinuxHostParentLifetime } from ${JSON.stringify(new URL("./linuxHostParent.ts", import.meta.url).href)}; bindLinuxHostParentLifetime(); console.log('ready'); setInterval(()=>{},1000);`);
  const env = { ...process.env, RABIROUTE_HOSTED: "1", RABIROUTE_HOST_TRANSPORT: "node-ipc" };
  try {
    const child = fork(entry, [], { execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error("child exited before readiness"))); });
    child.disconnect();
    assert.equal((await exit).signal, "SIGTERM");
    const unowned = spawn(process.execPath, ["--import", "tsx", entry], { env, stdio: ["ignore", "pipe", "pipe"] });
    let error = ""; unowned.stderr.on("data", chunk => { error += chunk; });
    const code = await new Promise(resolve => unowned.once("exit", resolve));
    assert.notEqual(code, 0); assert.match(error, /requires its live parent IPC/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
