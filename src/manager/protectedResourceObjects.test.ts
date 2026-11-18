import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAsyncLocalSecretProtector, createLocalSecretProtector, runDpapiChild } from "../shared/localSecretProtection.js";
import { ResourceCache } from "./resourceCache.js";
import { createProtectedResourceObjects } from "./protectedResourceObjects.js";

test("protected cache survives reconstruction and rejects owner, purpose and ciphertext substitution", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "protected-resource-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = new ResourceCache(root), protector = createAsyncLocalSecretProtector(root);
  const objects = createProtectedResourceObjects(cache, protector, "private-evidence");
  const secret = Buffer.from("private synthetic data \u0000\ufffd");
  const receipt = await objects.putProtected("one", secret);
  const raw = await cache.read("one", receipt.id);
  assert.equal(raw.includes(secret), false);
  assert.equal(createHash("sha256").update(raw).digest("hex"), receipt.id);
  const rebuilt = createProtectedResourceObjects(new ResourceCache(root), createAsyncLocalSecretProtector(root), "private-evidence");
  assert.deepEqual(await rebuilt.readProtected("one", receipt.id), secret);
  assert.equal((await rebuilt.findByOwner("one"))[0].id, receipt.id);
  await assert.rejects(createProtectedResourceObjects(cache, protector, "other").readProtected("one", receipt.id));
  const envelope = JSON.parse(raw.toString()); envelope.owner = "two";
  const moved = Buffer.from(JSON.stringify(envelope)), movedId = createHash("sha256").update(moved).digest("hex");
  await cache.put("two", movedId, moved);
  await assert.rejects(rebuilt.readProtected("two", movedId));
  envelope.owner = "one"; envelope.ciphertext = (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1);
  const corrupt = Buffer.from(JSON.stringify(envelope)), corruptId = createHash("sha256").update(corrupt).digest("hex");
  await cache.put("one", corruptId, corrupt);
  await assert.rejects(rebuilt.readProtected("one", corruptId));
});

test("async and original protectors interoperate under the current user", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-secret-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sync = createLocalSecretProtector(root), asyncOwner = createAsyncLocalSecretProtector(root);
  assert.equal(await asyncOwner.unprotect(sync.protect("fixture-secret")), "fixture-secret");
  assert.equal(sync.unprotect(await asyncOwner.protect("fixture-secret")), "fixture-secret");
});

test("async worker cancellation and oversized output join child close without leaking stderr", async () => {
  for (const mode of ["abort", "oversize"]) {
    const child = spawn(process.execPath, ["-e", mode === "abort" ? "process.stdin.resume();setInterval(()=>{},1000)" : "process.stderr.write('fixture-secret');process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] });
    let closed = false; child.once("close", () => { closed = true; });
    const controller = new AbortController();
    const result = runDpapiChild(child, "fixture-secret", controller.signal, 5000, 128);
    if (mode === "abort") setTimeout(() => controller.abort(), 100);
    await assert.rejects(result, error => { assert(!String(error).includes("fixture-secret")); return true; });
    assert.equal(closed, true);
  }
});

test("slow worker leaves the event loop responsive and cancellation fences publication", async t => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume();setTimeout(()=>process.stdout.write('ok'),250)"], { stdio: ["pipe", "pipe", "pipe"] });
  let ticks = 0; const timer = setInterval(() => ticks++, 10);
  try { assert.equal(await runDpapiChild(child, "fixture", undefined, 5000), "ok"); assert(ticks > 2); }
  finally { clearInterval(timer); }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "protected-fence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let release!: (value: string) => void;
  const pending = new Promise<string>(resolve => { release = resolve; });
  const cache = new ResourceCache(root), controller = new AbortController();
  const objects = createProtectedResourceObjects(cache, { scheme: "fixture", protect: () => pending, unprotect: async value => value }, "test");
  const write = objects.putProtected("owner", Buffer.from("fixture"), () => {}, controller.signal);
  controller.abort(); release("ciphertext");
  await assert.rejects(write); assert.deepEqual(await cache.findByOwner("owner"), []);
});
