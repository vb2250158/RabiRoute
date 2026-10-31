import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWebPatch, verifyWebPatch, webPatchBackend, webPatchHash, type WebPatchManifest } from "./webPatchCatalog.js";

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within 3 seconds.`)), 3_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-web-build-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package"), output = path.join(root, "candidates");
  const contents = new Map<string, string>();
  const write = async (name: string, content: string) => {
    contents.set(name, content);
    await fs.mkdir(path.dirname(path.join(packageRoot, name)), { recursive: true });
    await fs.writeFile(path.join(packageRoot, name), content);
  };
  for (let index = 0; index < 20; index++) await write(`dist/backend/${String(index).padStart(2, "0")}.js`, `backend ${index}`);
  await write("dist/ignored.test.js", "excluded test");
  await write("dist/web-patches/ignored.js", "excluded patch");
  await write("dist/agent-hooks/ignored.js", "excluded hook");
  await write("dist/plugins/packages/io.fixture/1/rabi.plugin.json", JSON.stringify({ id: "io.fixture", version: "1", entries: { web: { module: "web/module.js" } } }));
  await write("dist/plugins/packages/io.fixture/1/web/module.js", 'export { activate } from "/assets/0.js";');
  await write("package.json", '{"name":"fixture"}');
  await write("package-lock.json", '{"lockfileVersion":3}');
  await write("ribiwebgui/dist/index.html", '<script src="./assets/0.js"></script>');
  for (let index = 0; index < 20; index++) await write(`ribiwebgui/dist/assets/${index}.js`, `web ${index}`);
  await write("assets/0.js", "lower precedence duplicate");
  await write("assets/unique.js", "shared asset");
  await write("docs/readme.md", "versioned documentation");
  return { root, packageRoot, output, contents, write };
}

function referenceBackend(contents: Map<string, string>): string {
  const files = [...contents.keys()].filter(file => file.startsWith("dist/")).map(file => file.slice(5)).sort()
    .filter(file => /\.(js|mjs|json)$/.test(file) && !file.endsWith(".test.js") && !file.includes("/web/")
      && !file.startsWith("agent-hooks/") && !file.startsWith("web-patches/"));
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file}\0${webPatchHash(contents.get(`dist/${file}`)!)}\n`);
  for (const name of ["package.json", "package-lock.json"]) hash.update(`${name}\0${contents.has(name) ? webPatchHash(contents.get(name)!) : "absent"}\n`);
  return hash.digest("hex");
}

// Hold real OS reads, rather than replacing a hash with a precomputed result.
function heldStreams(t: test.TestContext, root: string) {
  const originalStream = nodeFs.createReadStream, originalRead = nodeFs.read;
  const gates: Array<{ release(error?: Error): void }> = [];
  let releaseFuture = false, active = 0, peak = 0, closed = 0, started = 0;
  let entered!: () => void;
  const full = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(nodeFs, "createReadStream", (filename: Parameters<typeof nodeFs.createReadStream>[0], options?: Parameters<typeof nodeFs.createReadStream>[1]) => {
    if (!String(filename).startsWith(root + path.sep)) return originalStream(filename, options);
    let held = false;
    const stream = originalStream(filename, { ...(typeof options === "object" ? options : {}), fs: {
      open: nodeFs.open, close: nodeFs.close,
      read: (...args: unknown[]) => {
        if (held || releaseFuture) { Reflect.apply(originalRead, nodeFs, args); return; }
        held = true;
        const callback = args.at(-1) as (error: Error) => void;
        let released = false;
        gates.push({ release: error => {
          if (released) return;
          released = true;
          if (error) callback(error); else Reflect.apply(originalRead, nodeFs, args);
        } });
        if (gates.length === 8) entered();
      }
    } });
    active++; started++; peak = Math.max(peak, active);
    stream.once("close", () => { active--; closed++; });
    return stream;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { gates, full, releaseAll() { releaseFuture = true; for (const gate of gates) gate.release(); },
    stats: () => ({ active, peak, closed, started }) };
}

test("backend digest keeps original sorted bytes despite out-of-order bounded OS hash reads", { timeout: 10_000 }, async t => {
  const f = await fixture(t), reads = heldStreams(t, path.join(f.packageRoot, "dist"));
  const work = webPatchBackend(f.packageRoot), outcome = work.then(value => ({ value }), error => ({ error }));
  try {
    await bounded(reads.full, "backend pool barrier");
    for (const gate of [...reads.gates].reverse()) gate.release();
    reads.gates.length = 0;
    reads.releaseAll();
    const result = await bounded(outcome, "backend hashing");
    assert.ok("value" in result);
    assert.equal(result.value, referenceBackend(f.contents));
    assert.deepEqual(reads.stats(), { active: 0, peak: 8, closed: 21, started: 21 });
  } finally { reads.releaseAll(); await outcome; }
});

for (const mode of ["failure", "abort"] as const) test(`backend ${mode} stops claims and waits for every real read stream close`, { timeout: 10_000 }, async t => {
  const f = await fixture(t), reads = heldStreams(t, path.join(f.packageRoot, "dist")), controller = new AbortController();
  const cause = new Error(`backend ${mode}`);
  let finished = false;
  const work = webPatchBackend(f.packageRoot, controller.signal).finally(() => { finished = true; });
  const outcome = work.then(() => ({ status: "fulfilled" as const }), error => ({ status: "rejected" as const, error: error as unknown }));
  try {
    await bounded(reads.full, "backend pool barrier");
    if (mode === "abort") { controller.abort(cause); reads.gates[0]!.release(); }
    else reads.gates[0]!.release(cause);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(reads.stats().started, 8);
    const remaining = reads.gates.splice(1); reads.gates.length = 0;
    for (const gate of remaining) gate.release();
    const result = await bounded(outcome, "backend retirement");
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.ok(result.error === cause || mode === "abort" && result.error instanceof Error && result.error.name === "AbortError" && result.error.cause === cause);
    assert.deepEqual(reads.stats(), { active: 0, peak: 8, closed: 8, started: 8 });
  } finally { reads.releaseAll(); await outcome; }
});

test("parallel Web build keeps duplicate precedence, complete hashes and the serial manifest contract", async t => {
  const f = await fixture(t), original = fs.copyFile.bind(fs);
  let active = 0, peak = 0, copies = 0;
  t.mock.method(fs, "copyFile", async (...args: Parameters<typeof fs.copyFile>) => {
    active++; copies++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setImmediate(resolve)); await original(...args); }
    finally { active--; }
  });
  const revision = await buildWebPatch(f.packageRoot, f.output);
  const manifest = await verifyWebPatch(path.join(f.output, revision), revision);
  const files: WebPatchManifest["files"] = [];
  const names = new Set<string>();
  for (const [source, target] of [["ribiwebgui/dist/", "web/"], ["assets/", "web/assets/"], ["docs/", "docs/"]]) {
    for (const [name, content] of [...f.contents.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      if (!name.startsWith(source!)) continue;
      const destination = target + name.slice(source!.length);
      if (names.has(destination)) continue;
      names.add(destination);
      files.push({ path: destination, size: Buffer.byteLength(content), sha256: webPatchHash(content) });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const expected: WebPatchManifest = { schemaVersion: 1, backend: referenceBackend(f.contents), files,
    modules: [{ pluginId: "io.fixture", version: "1", entry: "web/assets/0.js" }] };
  assert.deepEqual(manifest, expected);
  assert.equal(revision, webPatchHash(JSON.stringify(expected)));
  assert.equal(await fs.readFile(path.join(f.output, revision, "web/assets/0.js"), "utf8"), "web 0");
  assert.equal(copies, expected.files.length);
  assert.ok(peak > 0 && peak <= 8); assert.equal(active, 0);
});

for (const mode of ["file-budget", "total-budget"] as const) test(`Web build ${mode} rejects before any copy`, async t => {
  const f = await fixture(t), original = fs.stat.bind(fs);
  let copies = 0;
  t.mock.method(fs, "stat", async (filename: Parameters<typeof fs.stat>[0]) => {
    const value = await original(filename);
    if (String(filename).startsWith(path.join(f.packageRoot, "ribiwebgui"))) value.size = mode === "file-budget" ? 129 * 1024 * 1024 : 7 * 1024 * 1024;
    return value;
  });
  t.mock.method(fs, "copyFile", async () => { copies++; });
  await assert.rejects(buildWebPatch(f.packageRoot, f.output), /byte budget/);
  assert.equal(copies, 0);
  assert.deepEqual(await fs.readdir(f.output), []);
});

test("Web metadata failure preserves a null cause and joins all size reads before cleanup", { timeout: 10_000 }, async t => {
  const f = await fixture(t), original = fs.stat.bind(fs);
  const gates: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  let releaseFuture = false, finished = false, copies = 0;
  let entered!: () => void;
  const full = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(fs, "stat", async (filename: Parameters<typeof fs.stat>[0]) => {
    if (!releaseFuture) await new Promise<void>((resolve, reject) => { gates.push({ resolve, reject }); if (gates.length === 8) entered(); });
    return original(filename);
  });
  t.mock.method(fs, "copyFile", async () => { copies++; });
  const checking = buildWebPatch(f.packageRoot, f.output).finally(() => { finished = true; });
  const outcome = checking.then(() => ({ status: "fulfilled" as const }), error => ({ status: "rejected" as const, error: error as unknown }));
  try {
    await bounded(full, "metadata pool barrier");
    gates[0]!.reject(null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false); assert.equal(gates.length, 8); assert.equal(copies, 0);
    assert.ok((await fs.readdir(f.output)).some(name => name.startsWith(".staging-")));
    for (const gate of gates.slice(1)) gate.resolve();
    const result = await bounded(outcome, "metadata retirement");
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.error, null);
    assert.equal(gates.length, 8); assert.equal(copies, 0);
    assert.deepEqual(await fs.readdir(f.output), []);
  } finally { releaseFuture = true; for (const gate of gates) gate.resolve(); await outcome; }
});

for (const mode of ["failure", "abort", "falsy"] as const) test(`Web copy ${mode} joins claimed file I/O before removing staging`, { timeout: 10_000 }, async t => {
  const f = await fixture(t), original = fs.copyFile.bind(fs), controller = new AbortController();
  const cause = mode === "falsy" ? undefined : new Error(`copy ${mode}`);
  const gates: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  let releaseFuture = false, finished = false, active = 0, peak = 0;
  let entered!: () => void;
  const full = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(fs, "copyFile", async (...args: Parameters<typeof fs.copyFile>) => {
    active++; peak = Math.max(peak, active);
    try {
      if (!releaseFuture) await new Promise<void>((resolve, reject) => { gates.push({ resolve, reject }); if (gates.length === 8) entered(); });
      await original(...args);
    } finally { active--; }
  });
  const checking = buildWebPatch(f.packageRoot, f.output, controller.signal).finally(() => { finished = true; });
  const outcome = checking.then(() => ({ status: "fulfilled" as const }), error => ({ status: "rejected" as const, error: error as unknown }));
  try {
    await bounded(full, "copy pool barrier");
    if (mode === "abort") { controller.abort(cause); gates[0]!.resolve(); }
    else gates[0]!.reject(cause);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(gates.length, 8);
    assert.ok((await fs.readdir(f.output)).some(name => name.startsWith(".staging-")));
    for (const gate of gates.slice(1)) gate.resolve();
    const result = await bounded(outcome, "copy retirement");
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.error, cause);
    assert.equal(gates.length, 8); assert.equal(peak, 8); assert.equal(active, 0);
    assert.deepEqual(await fs.readdir(f.output), []);
  } finally {
    releaseFuture = true; controller.abort(); for (const gate of gates) gate.resolve(); await outcome;
  }
});
