import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readWebPluginModuleSource, readWebPluginModules } from "./webPluginModules.js";

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-web-modules-"));
  const pkg = path.join(root, "plugins", "packages", encodeURIComponent("example.web"), "1.0.0");
  await fs.mkdir(pkg, { recursive: true });
  await fs.mkdir(path.join(root, "data", "plugins", "manager"), { recursive: true });
  await fs.writeFile(path.join(root, "data", "plugins", "manager", "profile.json"), JSON.stringify({ schemaVersion: 1, plugins: [{ id: "manager:example-web", package: "example.web", version: "1.0.0", enabled: true }] }), "utf8");
  await fs.writeFile(path.join(pkg, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 1, id: "example.web", version: "1.0.0", hosts: ["manager", "web"], entry: "./index.mjs", webEntry: "./client.mjs" }), "utf8");
  await fs.writeFile(path.join(pkg, "index.mjs"), "export const createPlugin = () => ({})", "utf8");
  await fs.writeFile(path.join(pkg, "client.mjs"), "export function activate() {}", "utf8");
  return root;
}

test("Web plugin module catalog publishes immutable content revisions", async () => {
  const root = await fixture();
  const modules = await readWebPluginModules(root);
  assert.equal(modules.length, 1);
  assert.equal(modules[0].id, "manager:example-web");
  assert.match(modules[0].rev, /^[a-f0-9]{64}$/);
  const loaded = await readWebPluginModuleSource(root, modules[0].id, modules[0].rev);
  assert.match(loaded.source.toString("utf8"), /activate/);
  await assert.rejects(() => readWebPluginModuleSource(root, modules[0].id, "old"), { code: "ENOENT" });
});


test("Web module source retains the preceding immutable revision for a browser rollback", async () => {
  const root = await fixture();
  const first = (await readWebPluginModules(root))[0]!;
  const firstSource = await readWebPluginModuleSource(root, first.id, first.rev);
  const clientPath = path.join(root, "plugins", "packages", encodeURIComponent("example.web"), "1.0.0", "client.mjs");
  await fs.writeFile(clientPath, "export function activate() { throw new Error('new revision failed'); }", "utf8");
  const second = (await readWebPluginModules(root))[0]!;
  assert.notEqual(second.rev, first.rev);
  assert.match((await readWebPluginModuleSource(root, second.id, second.rev)).source.toString("utf8"), /new revision failed/);
  assert.equal((await readWebPluginModuleSource(root, first.id, first.rev)).source.toString("utf8"), firstSource.source.toString("utf8"));
});
