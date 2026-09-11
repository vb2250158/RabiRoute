import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { instrumentAutomaticCode } from "./instrument-automatic-code.mjs";
import { prepareAutomaticCodeUpdate } from "./automatic-update-worker.mjs";

async function baseline(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-worker-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ["src", "dist", "source-patches"]) await fs.mkdir(path.join(root, directory));
  await fs.writeFile(path.join(root, "source-patches/modules.json"), '{"modules":[]}');
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, types: [], rootDir: "src", outDir: "dist"
  }, include: ["src/**/*.ts"] }));
  const source = 'export function read(value: number) { return value+1; }';
  await fs.writeFile(path.join(root, "src/module.ts"), source);
  await fs.writeFile(path.join(root, "dist/module.js"), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText);
  await instrumentAutomaticCode(root);
  return { sourceRoot: root, packageRoot: root };
}

test("worker emits compatible source changes from a frozen compiler inventory", async context => {
  const roots = await baseline(context);
  const original = await prepareAutomaticCodeUpdate(roots);
  assert.equal(original.state, "prepared");
  await fs.writeFile(path.join(roots.sourceRoot, "src/module.ts"), 'export function read(value: number) { return value+2; }');
  const candidate = await prepareAutomaticCodeUpdate(roots);
  assert.equal(candidate.state, "prepared", JSON.stringify(candidate));
  assert.deepEqual(candidate.changedFiles, ["src/module.ts"]);
  assert.notEqual(candidate.digest, original.digest);
  assert.match(candidate.definitions[0].implementations.read, /value \+ 2/);
});

test("compiler metadata uses the frozen catalog even when source and package share a directory", async context => {
  const roots = await baseline(context);
  await fs.writeFile(path.join(roots.sourceRoot, "package.json"), '{"type":"module","version":"2.0.0"}');
  const candidate = await prepareAutomaticCodeUpdate(roots);
  assert.equal(candidate.state, "requires_switch");
  assert.equal(candidate.reasons[0].file, "package.json");
});

test("new and removed executable files cannot be silently ignored", async context => {
  const roots = await baseline(context);
  await fs.writeFile(path.join(roots.sourceRoot, "src/new.ts"), "export const added=1;");
  const added = await prepareAutomaticCodeUpdate(roots);
  assert.equal(added.state, "requires_switch");
  assert.equal(added.reasons[0].file, "src/new.ts");
  await fs.unlink(path.join(roots.sourceRoot, "src/new.ts"));
  await fs.unlink(path.join(roots.sourceRoot, "src/module.ts"));
  const removed = await prepareAutomaticCodeUpdate(roots);
  assert.equal(removed.state, "requires_switch");
  assert.match(removed.reasons[0].reason, /removed/);
});

test("compiler errors cannot produce a partial candidate", async context => {
  const roots = await baseline(context);
  await fs.writeFile(path.join(roots.sourceRoot, "src/module.ts"), 'export function read(value: number) { return missing(value); }');
  await assert.rejects(prepareAutomaticCodeUpdate(roots), /missing/);
});
