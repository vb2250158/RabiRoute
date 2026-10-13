import assert from "node:assert/strict";
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
