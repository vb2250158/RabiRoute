import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { packageModuleSourceReader } from "./check-plugin-platform-architecture.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-generated-check-"));
  t.after(async () => {
    assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const packageRoot = path.join(root, "plugins", "builtin", "io.test.generated", "1.0.0");
  const source = path.join(root, "src", "messageEndpoints", "example.ts");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'export function make() { return "generated implementation"; }\n');
  const descriptor = { exports: [{ name: "make", source: "src/messageEndpoints/example.ts" }] };
  const generated = path.join(packageRoot, "manager-runtime.mjs");
  const descriptorPath = path.join(packageRoot, "manager-runtime.build.json");
  const read = () => packageModuleSourceReader(packageRoot, root);
  return { root, packageRoot, source, descriptor, generated, descriptorPath, read };
}

test("a declared runtime is actually compiled in memory and its reads share one result", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.descriptorPath, JSON.stringify(f.descriptor));
  const read = f.read(), first = read(f.generated), second = read(f.generated);
  assert.equal(first, second);
  const source = await first;
  assert.match(source, /generated implementation/);
  assert.match(source, /export function createImplementation/);
  assert.deepEqual(await fs.readdir(f.packageRoot), ["manager-runtime.build.json"]);
  await assert.rejects(fs.stat(f.generated), { code: "ENOENT" });
});

test("a generated-looking filename without a matching consumed descriptor remains missing", async t => {
  const f = await fixture(t);
  assert.equal(await f.read()(f.generated), undefined);
  await fs.writeFile(path.join(f.packageRoot, "arbitrary.build.json"), JSON.stringify(f.descriptor));
  assert.equal(await f.read()(path.join(f.packageRoot, "arbitrary.mjs")), undefined);
});

test("invalid JSON, empty exports and a failed implementation compile cannot admit a runtime", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.descriptorPath, "{broken");
  await assert.rejects(f.read()(f.generated), SyntaxError);
  await fs.writeFile(f.descriptorPath, JSON.stringify({ exports: [] }));
  await assert.rejects(f.read()(f.generated), /Invalid generated runtime descriptor/);
  await fs.writeFile(f.descriptorPath, JSON.stringify(f.descriptor));
  await fs.writeFile(f.source, "export function make( {");
  await assert.rejects(f.read()(f.generated), /Expected|Unexpected/);
  await assert.rejects(fs.stat(f.generated), { code: "ENOENT" });
});

test("a missing owned dependency still fails the real compiler", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.descriptorPath, JSON.stringify(f.descriptor));
  await fs.writeFile(f.source, 'import { value } from "./missing.js"; export function make() { return value; }');
  await assert.rejects(f.read()(f.generated), /Could not resolve/);
});

test("existing source modules retain package boundaries and are not replaced by descriptors", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.generated, "export const existing = true;");
  await fs.writeFile(f.descriptorPath, "{broken");
  assert.equal(await f.read()(f.generated), "export const existing = true;");
  assert.equal(await f.read()(path.join(f.packageRoot, "..", "outside.mjs")), undefined);
});

test("linked module or descriptor paths cannot be satisfied by virtual generation", async t => {
  const f = await fixture(t);
  const foreign = path.join(f.root, "foreign");
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, "module.mjs"), "export const foreign = true;");
  await fs.writeFile(f.descriptorPath, JSON.stringify(f.descriptor));
  await fs.symlink(foreign, f.generated, "junction");
  assert.equal(await f.read()(f.generated), undefined);
  await fs.unlink(f.generated);
  await fs.unlink(f.descriptorPath);
  await fs.symlink(foreign, f.descriptorPath, "junction");
  assert.equal(await f.read()(f.generated), undefined);
  await fs.symlink(foreign, path.join(f.packageRoot, "linked"), "junction");
  assert.equal(await f.read()(path.join(f.packageRoot, "linked", "module.mjs")), undefined);
});
