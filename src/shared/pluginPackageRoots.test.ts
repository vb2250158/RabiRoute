import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GenerationRuntime, loadPluginProfile, parsePluginProfile, PluginPackageCatalog } from "../plugin-kernel/index.js";
import { resolvePluginPackageRoots } from "./pluginPackageRoots.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-managed-packages-"));
  const layout = { packageRoot: path.join(root, "program"), stateRoot: path.join(root, "state") };
  const builtin = path.join(layout.packageRoot, "dist", "plugins", "packages");
  const managed = path.join(layout.stateRoot, "data", "plugins", "packages");
  const catalogs: PluginPackageCatalog[] = [], runtimes: GenerationRuntime[] = [];
  t.after(async () => {
    await Promise.all(runtimes.map(runtime => runtime.dispose()));
    await Promise.all(catalogs.map(catalog => catalog.dispose()));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function writePackage(packages: string, id: string, version: string) {
    const directory = path.join(packages, id, version);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "rabi.plugin.json"), JSON.stringify({
      schemaVersion: 2, id, version,
      entries: { gateway: { execution: "in_process", module: "./gateway.mjs" } },
      provides: ["endpoint.fixture@1"], requires: [], optional: [], permissions: []
    }));
    await fs.writeFile(path.join(directory, "gateway.mjs"),
      "export function activate(ctx) { ctx.services.provide('endpoint.fixture@1', { installed: true }); }\n");
    return directory;
  }
  return { root, layout, builtin, managed, writePackage,
    catalog(roots: readonly string[]) { const catalog = new PluginPackageCatalog(roots); catalogs.push(catalog); return catalog; },
    runtime() { const runtime = new GenerationRuntime({ host: "gateway" }); runtimes.push(runtime); return runtime; }
  };
}

test("a Gateway activates the selected version available only in the native installed package store", async t => {
  const f = await fixture(t), id = "io.test.managed-endpoint";
  await f.writePackage(f.builtin, id, "0.1.1");
  const installed = await f.writePackage(f.managed, id, "0.1.2");
  await assert.rejects(f.catalog([f.builtin]).resolve(id, "0.1.2"), /not installed/);
  const profile = parsePluginProfile({ schemaVersion: 2, readyRequires: ["endpoint.fixture@1"],
    instances: [{ id: "endpoint:fixture", package: id, version: "0.1.2", enabled: true, config: {}, grants: [] }] });
  const loaded = await loadPluginProfile({ profilePath: path.join(f.root, "profile.json"), profile,
    packageCatalog: f.catalog(resolvePluginPackageRoots(f.layout, {})), runtimeRoot: path.join(f.root, "runtime"), host: "gateway" });
  assert.deepEqual(loaded.loadFailures, []);
  assert.equal(loaded.packages[0]?.package.sourceRoot, await fs.realpath(installed));
  const switched = await f.runtime().switch(loaded.candidates, { readyRequires: profile.readyRequires });
  assert.equal(switched.generation.records[0]?.status, "active");
  assert.equal(switched.generation.services.services.has("endpoint.fixture@1"), true);
});

test("additional roots retain built-in and installed packages without changing their precedence", async t => {
  const f = await fixture(t), extra = path.join(f.root, "additional");
  const builtin = await f.writePackage(f.builtin, "io.test.shared", "1.0.0");
  await f.writePackage(f.managed, "io.test.shared", "1.0.0");
  const managed = await f.writePackage(f.managed, "io.test.installed", "1.0.0");
  const custom = await f.writePackage(extra, "io.test.custom", "1.0.0");
  const roots = resolvePluginPackageRoots(f.layout, {
    RABIROUTE_PLUGIN_PACKAGE_ROOTS: ` ${extra} ${path.delimiter}${f.builtin}${path.delimiter}${extra}`
  });
  const catalog = f.catalog(roots);
  assert.equal((await catalog.resolve("io.test.shared", "1.0.0")).sourceRoot, await fs.realpath(builtin));
  assert.equal((await catalog.resolve("io.test.installed", "1.0.0")).sourceRoot, await fs.realpath(managed));
  assert.equal((await catalog.resolve("io.test.custom", "1.0.0")).sourceRoot, await fs.realpath(custom));
  assert.equal(roots.length, 3);
});

test("an empty additional-root setting keeps the original installed package store available", async t => {
  const f = await fixture(t), directory = await f.writePackage(f.managed, "io.test.installed", "1.0.0");
  const catalog = f.catalog(resolvePluginPackageRoots(f.layout, {
    RABIROUTE_PLUGIN_PACKAGE_ROOTS: ` ${path.delimiter} ${path.delimiter} `
  }));
  assert.equal((await catalog.resolve("io.test.installed", "1.0.0")).sourceRoot, await fs.realpath(directory));
});
