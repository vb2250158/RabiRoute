import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { probeWorkbuddyHook } from "./hookInstallation.js";
import { workbuddyHomeDir } from "../workbuddyHome.js";
import { workbuddyHomeDir as storeHome } from "../workbuddySessionStore.js";

function fixture(t: test.TestContext, source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-probe-"));
  fs.mkdirSync(path.join(root, "scripts"));
  const script = path.join(root, "scripts", "rabi-workbuddy-hook.mjs");
  fs.writeFileSync(script, source);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, script };
}
const healthy = "console.log(JSON.stringify({ok:true,detail:'synthetic'}));";

test("self-check can call its own parent HTTP server without blocking health", { timeout: 5000 }, async t => {
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => markStarted = resolve);
  const server = http.createServer((request, response) => {
    if (request.url === "/check") { markStarted(); setTimeout(() => response.end("ok"), 150); }
    else { response.end("healthy"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const data = fixture(t, `await fetch(${JSON.stringify(base + "/check")});${healthy}`);
  let completed = false;
  const probe = probeWorkbuddyHook(data.root, { timeoutMs: 2000 }).then(result => { completed = true; return result; });
  await Promise.race([started, probe.then(() => { throw new Error("probe ended before parent HTTP request"); })]);
  const began = performance.now();
  assert.equal(await (await fetch(`${base}/health`)).text(), "healthy");
  const healthMs = performance.now() - began;
  assert.equal(completed, false, "health is served while self-check is awaiting the same parent");
  assert.equal((await probe).ok, true);
  t.diagnostic(`fixture health latency ${healthMs} ms`);
});

for (const [name, source] of [
  ["nonzero exit overrides successful JSON", `${healthy}process.exitCode=7;`],
  ["string truthiness is not a verdict", "console.log(JSON.stringify({ok:'false'}));"],
  ["null is not healthy", "console.log('null');"],
  ["malformed stdout is not echoed", "console.log('synthetic-sensitive-value');"],
  ["stderr failure is not echoed", `${healthy}console.error('[rabi-workbuddy-context] synthetic-sensitive-value');`],
  ["oversized stdout is terminated", "process.stdout.write('synthetic-sensitive-value'.repeat(10000));setInterval(()=>{},1000);"],
  ["combined stderr budget is enforced", `${healthy}process.stderr.write('x'.repeat(70000));setInterval(()=>{},1000);`]
]) {
  test(name!, { timeout: 5000 }, async t => {
    const data = fixture(t, source!);
    const result = await probeWorkbuddyHook(data.root, { timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.detail, /synthetic-sensitive-value/);
    fs.writeFileSync(data.script, healthy);
    assert.equal((await probeWorkbuddyHook(data.root, { timeoutMs: 2000 })).ok, true, "closed child releases the probe slot");
  });
}

for (const mode of ["timeout", "abort"] as const) {
  test(`${mode} confirms child exit and releases the probe slot`, { timeout: 5000 }, async t => {
    const data = fixture(t, "");
    const pidFile = path.join(data.root, "pid");
    let started!: () => void;
    const received = new Promise<void>(resolve => started = resolve);
    const server = http.createServer((_request, response) => { response.end("ok"); started(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    fs.writeFileSync(data.script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));await fetch('http://127.0.0.1:${address.port}/started');setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const probe = probeWorkbuddyHook(data.root, { signal: controller.signal, timeoutMs: mode === "timeout" ? 700 : 2000 });
    await Promise.race([received, probe.then(() => { throw new Error("child did not reach fixture HTTP"); })]);
    if (mode === "abort") controller.abort();
    const result = await probe;
    assert.equal(result.ok, false);
    assert.match(result.detail, mode === "timeout" ? /超时/ : /取消/);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    fs.writeFileSync(data.script, healthy);
    assert.equal((await probeWorkbuddyHook(data.root)).ok, true);
  });
}

test("already aborted self-check never executes the script", async t => {
  const data = fixture(t, "throw new Error('should not run');");
  const controller = new AbortController(); controller.abort();
  const result = await probeWorkbuddyHook(data.root, { signal: controller.signal });
  assert.equal(result.ok, false); assert.match(result.detail, /取消/);
});

test("hook and session store share home precedence including CodeBuddy fallback", t => {
  const keys = ["RABI_WORKBUDDY_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR"] as const;
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
  for (const key of keys) delete process.env[key];
  assert.equal(workbuddyHomeDir(), storeHome());
  for (const key of [...keys].reverse()) {
    process.env[key] = path.join(os.tmpdir(), `synthetic-${key}`);
    assert.equal(workbuddyHomeDir(), path.resolve(process.env[key]!));
    assert.equal(storeHome(), workbuddyHomeDir());
  }
});
