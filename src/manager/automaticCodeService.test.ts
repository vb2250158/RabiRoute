import assert from "node:assert/strict";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AutomaticCodeService } from "./automaticCodeService.js";
import type { WebPatchService } from "./webPatchService.js";

test("native discovery needs no opt-in and preserves explicit disable and unowned startup edits", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-native-default-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "dist/automatic-code"), { recursive: true });
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "tsconfig.json"), "{}");
  const publication = { registerCodePublication: () => {}, ready: Promise.resolve(), status: () => ({ state: "ready" }) } as unknown as WebPatchService;
  for (const [watch, dirty, state] of [[true, false, "ready"], [false, false, "disabled"], [true, true, "requires_review"]] as const) {
    await fs.writeFile(path.join(root, "dist/automatic-code/catalog.json"), JSON.stringify({ modules: [], webInputDigest: "a".repeat(64), inputHashes: dirty ? { "tsconfig.json": "b".repeat(64) } : {} }));
    const service = new AutomaticCodeService({ packageRoot: root, stateRoot: path.join(root, "state"), watch, publication, onError: () => {} });
    await service.start();
    assert.equal(service.snapshot().state, state);
    await service.stop();
  }
});

for (const state of ["prepared", "superseded", "requires_switch"]) {
  test(`automatic compiler returns ${state} receipt without treating normal worker exit as failure`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-service-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "dist/automatic-code"), { recursive: true });
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "dist/automatic-code/catalog.json"), JSON.stringify({ modules: [], webInputDigest: "a".repeat(64) }));
    await fs.writeFile(path.join(root, "scripts/automatic-update-worker.mjs"), `import { parentPort } from 'node:worker_threads'; parentPort.postMessage(${JSON.stringify({ state, reasons: [], definitions: [] })});`);
    const publication = { registerCodePublication: () => {}, ready: Promise.resolve(), status: () => ({ state: "ready" }) } as unknown as WebPatchService;
    const service = new AutomaticCodeService({ packageRoot: root, sourceRoot: root, stateRoot: path.join(root, "state"), watch: false, publication, onError: () => {} });
    t.after(() => service.stop());
    // Exercise the actual worker handshake, isolated from the publication timer and live service.
    const result = await (service as unknown as { compile(): Promise<{ state: string }> }).compile();
    assert.equal(result.state, state);
  });
}

for (const pauseAt of ["publication", "input"] as const) {
  test(`stopping during ${pauseAt} startup does not create a late source watcher`, { timeout: 30000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-start-stop-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "dist/automatic-code"), { recursive: true });
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "tsconfig.json"), "{}");
    await fs.writeFile(path.join(root, "dist/automatic-code/catalog.json"), JSON.stringify({
      modules: [], webInputDigest: "a".repeat(64), inputHashes: { "tsconfig.json": "b".repeat(64) }
    }));
    const sourceRoot = await fs.realpath(root);
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    t.after(resume);
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const readFile = fs.readFile;
    if (pauseAt === "input") {
      t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
        if (args[0] === path.join(sourceRoot, "tsconfig.json")) { enter(); await paused; }
        return readFile(...args);
      });
    }
    const watch = t.mock.method(nativeFs, "watch");
    const publication = {
      registerCodePublication: () => {},
      get ready() {
        if (pauseAt === "publication") { enter(); return paused; }
        return Promise.resolve();
      },
      status: () => ({ state: "ready" })
    } as unknown as WebPatchService;
    const service = new AutomaticCodeService({ packageRoot: root, stateRoot: path.join(root, "state"), watch: true, publication, onError: () => {} });
    t.after(() => service.stop());
    const startup = service.start();
    await entered;
    await service.stop();
    resume();
    await startup;
    assert.equal(watch.mock.callCount(), 0, "the stopped source owner must not acquire a watcher");
  });
}
