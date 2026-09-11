import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureAutomaticInputs, automaticInputsUnchanged, writeAutomaticSnapshot } from "./lib/automatic-update-inputs.mjs";

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-inputs-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/module.ts"), "export const value=1;");
  return root;
}

test("snapshot detects additions, deletions and byte changes rather than timestamps", async context => {
  const root = await fixture(context);
  const snapshot = await captureAutomaticInputs(root, ["src", "package.json"]);
  assert.equal(await automaticInputsUnchanged(root, snapshot), true);
  await fs.writeFile(path.join(root, "src/fresh.ts"), "export const fresh=2;");
  assert.equal(await automaticInputsUnchanged(root, snapshot), false);
  await fs.unlink(path.join(root, "src/fresh.ts"));
  assert.equal(await automaticInputsUnchanged(root, snapshot), true);
  await fs.writeFile(path.join(root, "src/module.ts"), "export const value=2;");
  assert.equal(await automaticInputsUnchanged(root, snapshot), false);
  await fs.unlink(path.join(root, "src/module.ts"));
  assert.equal(await automaticInputsUnchanged(root, snapshot), false);
});

test("build output never changes a source snapshot and frozen bytes do not alias source", async context => {
  const root = await fixture(context);
  const snapshot = await captureAutomaticInputs(root, ["src"]);
  const output = path.join(root, "isolated");
  await writeAutomaticSnapshot(output, snapshot);
  await fs.mkdir(path.join(root, "src/dist"));
  await fs.writeFile(path.join(root, "src/dist/generated.js"), "output");
  assert.equal(await automaticInputsUnchanged(root, snapshot), true);
  await fs.writeFile(path.join(root, "src/module.ts"), "new source");
  assert.equal(await fs.readFile(path.join(output, "src/module.ts"), "utf8"), "export const value=1;");
  await assert.rejects(writeAutomaticSnapshot(output, snapshot), { code: "EEXIST" });
});

test("snapshots reject escaping paths, symlinks and unbounded inputs", async context => {
  const root = await fixture(context);
  await assert.rejects(captureAutomaticInputs(root, ["../outside"]), /Invalid/);
  await assert.rejects(captureAutomaticInputs(root, ["src"], { maximumBytes: 1 }), /budget/);
  await assert.rejects(captureAutomaticInputs(root, ["src"], { maximumFiles: 0 }), /budget/);
  await fs.symlink(path.join(root, "src"), path.join(root, "linked"), "junction");
  await assert.rejects(captureAutomaticInputs(root, ["linked"]), /symbolic link/);
});
