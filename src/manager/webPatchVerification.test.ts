import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyWebPatch, webPatchHash, type WebPatchManifest } from "./webPatchCatalog.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-web-verify-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest: WebPatchManifest = { schemaVersion: 1, backend: "a".repeat(64), modules: [], files: [] };
  for (const name of ["web/index.html", "docs/readme.md", ...Array.from({ length: 18 }, (_, index) => `web/assets/${index}.js`)]) {
    const content = name === "web/index.html" ? '<head><script src="./assets/0.js"></script></head>' : `fixture ${name}`;
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
    manifest.files.push({ path: name, size: Buffer.byteLength(content), sha256: webPatchHash(content) });
  }
  const save = async () => { const raw = JSON.stringify(manifest); await fs.writeFile(path.join(root, "manifest.json"), raw); return webPatchHash(raw); };
  return { root, manifest, save };
}

test("Web verification keeps eight active files at most and verifies all content", async t => {
  const f = await fixture(t), expected = await f.save();
  const original = fs.realpath.bind(fs);
  let active = 0, maximum = 0, files = 0;
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0], ...args: unknown[]) => {
    if (String(file) === f.root) return original(file);
    active++; files++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await Reflect.apply(original, fs, [file, ...args]); }
    finally { active--; }
  });
  assert.deepEqual(await verifyWebPatch(f.root, expected), f.manifest);
  assert.equal(files, f.manifest.files.length);
  assert.equal(maximum, 8);
  assert.equal(active, 0);
});

for (const mode of ["failure", "abort"] as const) test(`Web verification ${mode} stops claiming files and joins every started worker`, { timeout: 10_000 }, async t => {
  const f = await fixture(t), expected = await f.save(), controller = new AbortController();
  const original = fs.realpath.bind(fs), gates: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  let entered!: () => void;
  let releasing = false;
  const full = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
    if (String(file) === f.root) return original(file);
    if (!releasing) await new Promise<void>((resolve, reject) => { gates.push({ resolve, reject }); if (gates.length === 8) entered(); });
    return original(file);
  });
  const cause = new Error(`fixture verification ${mode}`);
  let finished = false;
  const checking = verifyWebPatch(f.root, expected, controller.signal).finally(() => { finished = true; });
  const outcome = checking.then(() => ({ status: "fulfilled" as const }), error => ({ status: "rejected" as const, error: error as unknown }));
  let fullTimer: ReturnType<typeof setTimeout> | undefined;
  let outcomeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([full, new Promise<never>((_, reject) => {
      fullTimer = setTimeout(() => reject(new Error("Eight verifier workers did not reach the fixture barrier within 3 seconds.")), 3_000);
    })]);
    clearTimeout(fullTimer);
    if (mode === "abort") { controller.abort(cause); gates[0]!.resolve(); }
    else gates[0]!.reject(cause);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, "The first failure cannot abandon other active workers.");
    assert.equal(gates.length, 8);
    for (const gate of gates.slice(1)) gate.resolve();
    const result = await Promise.race([outcome, new Promise<never>((_, reject) => {
      outcomeTimer = setTimeout(() => reject(new Error("Verification did not reject and join workers within 3 seconds.")), 3_000);
    })]);
    clearTimeout(outcomeTimer);
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.ok(result.error === cause || mode === "abort"
      && result.error instanceof Error && result.error.name === "AbortError" && result.error.cause === cause,
    "Cancellation must reject from its supplied AbortSignal reason.");
    assert.equal(gates.length, 8, "No file can be claimed after failure or cancellation.");
  } finally {
    clearTimeout(fullTimer);
    clearTimeout(outcomeTimer);
    releasing = true;
    controller.abort(cause);
    for (const gate of gates) gate.resolve();
    await outcome;
  }
});

for (const mode of ["duplicate", "budget", "module"] as const) test(`Web manifest ${mode} fails before per-file work starts`, async t => {
  const f = await fixture(t);
  if (mode === "duplicate") f.manifest.files.push({ ...f.manifest.files[2]!, path: f.manifest.files[2]!.path.toUpperCase().replace("WEB/", "web/") });
  if (mode === "budget") f.manifest.files[2]!.size = 17 * 1024 * 1024;
  if (mode === "module") f.manifest.modules.push({ pluginId: "io.fixture", version: "1", entry: "web/assets/missing.js" });
  const expected = await f.save();
  let reads = 0;
  t.mock.method(fs, "realpath", async () => { reads++; throw new Error("Unexpected per-file verification"); });
  await assert.rejects(verifyWebPatch(f.root, expected), /Invalid Web patch file record|byte budget|Invalid Web Bundle entry/);
  assert.equal(reads, 0);
});

for (const mode of ["hash", "size", "ancestor", "containment", "html"] as const) test(`parallel Web verification preserves ${mode} rejection`, async t => {
  const f = await fixture(t);
  if (mode === "hash") f.manifest.files[2]!.sha256 = "b".repeat(64);
  if (mode === "size") f.manifest.files[2]!.size++;
  if (mode === "html") {
    const html = '<script src="./assets/missing.js"></script>';
    await fs.writeFile(path.join(f.root, "web/index.html"), html);
    Object.assign(f.manifest.files[0]!, { size: Buffer.byteLength(html), sha256: webPatchHash(html) });
  }
  const expected = await f.save();
  if (mode === "ancestor") {
    const original = fs.lstat.bind(fs);
    t.mock.method(fs, "lstat", async (file: Parameters<typeof fs.lstat>[0]) => String(file) === path.join(f.root, "web/assets")
      ? { isSymbolicLink: (): boolean => true } : original(file));
  }
  if (mode === "containment") {
    const original = fs.realpath.bind(fs);
    t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => String(file) === path.join(f.root, f.manifest.files[2]!.path)
      ? path.join(path.dirname(f.root), "outside.js") : original(file));
  }
  await assert.rejects(verifyWebPatch(f.root, expected), /verification failed|symbolic links|missing asset/);
});
