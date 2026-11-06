import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("the real standalone video supervisor bundles without host code and retires its native child using the parent timeout DTO", { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-video-worker-"));
  const output = path.join(root, "worker.mjs"), config = path.join(root, "native-config.json");
  await fs.writeFile(config, "fixture-only");
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const result = await build({ entryPoints: [fileURLToPath(new URL("./vacuumVideoWorker.ts", import.meta.url))],
    outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", metafile: true,
    plugins: [{ name: "no-host-source-or-ports", setup(builder) {
      builder.onResolve({ filter: /^@rabiroute\/host-api\// }, () => { throw new Error("Standalone video workers cannot import host ports."); });
    } }] });
  assert.ok(Object.keys(result.metafile!.inputs).every(input => /vacuum(?:VideoWorker|Cs2Relay)[.]ts$/.test(input)));
  // Node is a controlled short-lived native executable. No camera or network is contacted.
  const child = fork(output, [process.execPath, config, JSON.stringify({ closeMs: 17, localConnectMs: 23, relayConnectMs: 29 })], {
    execArgv: [], silent: true, env: { ...process.env, RABI_VIDEO_SOURCE: "rtsp://fixture.invalid/unused", RABI_VIDEO_PASSWORD: "fixture-only" }
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const messages: unknown[] = []; child.on("message", value => messages.push(value));
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.ok(messages.some(value => (value as { event?: string }).event === "ready"));
  assert.ok(messages.some(value => (value as { event?: string }).event === "exit"));
  await assert.rejects(fs.access(config), { code: "ENOENT" });
});
