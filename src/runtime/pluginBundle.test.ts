import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hashRabiPluginBundle,
  importRabiPluginModule,
  loadRabiPluginBundle,
  parseRabiPluginManifest
} from "./pluginBundle.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-plugin-bundle-"));
  await Promise.all(Object.entries(files).map(async ([relative, content]) => {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }));
  return root;
}

test("plugin bundle validates its manifest and hashes all source files", async () => {
  const root = await fixture({
    "rabi.plugin.json": JSON.stringify({ schemaVersion: 1, id: "example.echo", version: "1.0.0", hosts: ["manager"], entry: "./index.mjs" }),
    "index.mjs": "export const createPlugin = () => ({ value: 'first' })"
  });
  const first = await loadRabiPluginBundle(root);
  await fs.writeFile(path.join(root, "index.mjs"), "export const createPlugin = () => ({ value: 'second' })", "utf8");
  const second = await loadRabiPluginBundle(root);
  assert.equal(first.manifest.id, "example.echo");
  assert.notEqual(first.revision, second.revision);
  assert.equal(second.revision, await hashRabiPluginBundle(root));
});

test("plugin revision imports a fresh dependency graph after source replacement", async () => {
  const root = await fixture({
    "rabi.plugin.json": JSON.stringify({ schemaVersion: 1, id: "example.graph", version: "1.0.0", hosts: ["manager"], entry: "./index.mjs" }),
    "index.mjs": "import { value } from './value.mjs'; export const createPlugin = () => ({ value });",
    "value.mjs": "export const value = 'old';"
  });
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-plugin-runtime-"));
  const oldModule = await importRabiPluginModule(await loadRabiPluginBundle(root), runtimeRoot);
  assert.equal((oldModule.createPlugin as () => { value: string })().value, "old");
  await fs.writeFile(path.join(root, "value.mjs"), "export const value = 'new';", "utf8");
  const newModule = await importRabiPluginModule(await loadRabiPluginBundle(root), runtimeRoot);
  assert.equal((newModule.createPlugin as () => { value: string })().value, "new");
});

test("plugin manifest rejects traversal and undeclared fields", () => {
  assert.throws(() => parseRabiPluginManifest({ schemaVersion: 1, id: "example", version: "1", hosts: ["manager"], entry: "../index.mjs" }));
  assert.throws(() => parseRabiPluginManifest({ schemaVersion: 1, id: "example", version: "1", hosts: ["manager"], entry: "./index.mjs", command: "node anything" }));
});


test("concurrent loads of one revision share the completed copy without staging collisions", async () => {
  const root = await fixture({
    "rabi.plugin.json": JSON.stringify({ schemaVersion: 1, id: "example.concurrent", version: "1.0.0", hosts: ["manager"], entry: "./index.mjs" }),
    "index.mjs": "export const createPlugin = () => ({ value: 'ready' })"
  });
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-plugin-runtime-"));
  const bundle = await loadRabiPluginBundle(root);
  const modules = await Promise.all(Array.from({ length: 12 }, () => importRabiPluginModule(bundle, runtimeRoot)));
  assert.equal(modules.every(module => typeof module.createPlugin === "function"), true);
});
