import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPluginPackages } from "./build-plugin-packages.mjs";

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, null, 2) + "\n", "utf8");
}

test("plugin package builds preserve watched roots and remove stale packages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-plugin-build-"));
  try {
    const packageRoot = path.join(root, "plugins", "builtin", "io.test.plugin", "1.0.0");
    await writeJson(path.join(root, "plugins", "profiles", "desktop.json"), {
      schemaVersion: 1,
      instances: [{ id: "manager:test", package: "io.test.plugin", version: "1.0.0", enabled: true, config: {}, grants: [] }]
    });
    await writeJson(path.join(packageRoot, "rabi.plugin.json"), {
      schemaVersion: 1,
      id: "io.test.plugin",
      version: "1.0.0",
      entries: { manager: "./manager.mjs" },
      provides: ["test.plugin@1"],
      requires: [],
      optional: [],
      permissions: []
    });
    await fs.writeFile(path.join(packageRoot, "manager.mjs"), "export const activate = () => {};\n", "utf8");
    await fs.writeFile(path.join(packageRoot, "README.md"), "test\n", "utf8");
    await fs.writeFile(path.join(packageRoot, "README_en.md"), "test\n", "utf8");
    await fs.mkdir(path.join(root, "plugins", "contracts", "plugin-sdk"), { recursive: true });
    await fs.writeFile(path.join(root, "plugins", "contracts", "plugin-sdk", "index.mjs"), "export {};\n", "utf8");

    const watchedRoot = path.join(root, "dist", "plugins", "packages");
    await fs.mkdir(path.join(watchedRoot, "stale.plugin", "1.0.0"), { recursive: true });
    await fs.writeFile(path.join(watchedRoot, "watcher-marker.txt"), "keep", "utf8");
    const before = await fs.stat(watchedRoot);

    await buildPluginPackages(root);
    const after = await fs.stat(watchedRoot);
    assert.equal(after.ino, before.ino);
    assert.equal(await fs.readFile(path.join(watchedRoot, "watcher-marker.txt"), "utf8"), "keep");
    await assert.rejects(fs.access(path.join(watchedRoot, "stale.plugin")));
    assert.match(await fs.readFile(path.join(watchedRoot, "io.test.plugin", "1.0.0", "manager.mjs"), "utf8"), /activate/);

    await fs.writeFile(path.join(packageRoot, "manager.mjs"), "export const activate = () => 'updated';\n", "utf8");
    await buildPluginPackages(root);
    assert.equal((await fs.stat(watchedRoot)).ino, before.ino);
    assert.match(await fs.readFile(path.join(watchedRoot, "io.test.plugin", "1.0.0", "manager.mjs"), "utf8"), /updated/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
