import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadManagerPluginProfile } from "./managerPluginPackageLoader.js";
import { parseRabiPluginProfile } from "./pluginProfile.js";

async function writePackage(root: string, body: string): Promise<void> {
  const directory = path.join(root, encodeURIComponent("example.echo"), "1.0.0");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 1, id: "example.echo", version: "1.0.0", hosts: ["manager"], entry: "./index.mjs" }), "utf8");
  await fs.writeFile(path.join(directory, "index.mjs"), body, "utf8");
}

const entryModule = `
export function createPlugin(context) {
  return {
    instanceId: context.instanceId,
    manifest: { id: context.bundle.id, name: 'Echo', version: context.bundle.version, kind: 'package', hosts: ['manager'] },
    scope: 'global',
    provides: ['example.echo'],
    apply(ctx) { context.services.applied.push(context.config.message); ctx.effect(() => () => context.services.disposed.push(context.config.message)); }
  };
}`;

test("profile package loader returns a revisioned Manager plugin definition", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-package-"));
  const packageRoot = path.join(root, "packages");
  await writePackage(packageRoot, entryModule);
  const services = { applied: [] as string[], disposed: [] as string[] };
  const loaded = await loadManagerPluginProfile({
    packageRoot,
    runtimeRoot: path.join(root, "runtime"),
    profile: parseRabiPluginProfile({ schemaVersion: 1, plugins: [{ id: "manager:echo", package: "example.echo", version: "1.0.0", config: { message: "hello" } }] }),
    createServices: () => services
  });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].definition.instanceId, "manager:echo");
  assert.equal(loaded[0].definition.manifest.kind, "package");
  assert.equal(loaded[0].desired.enabled, true);
  assert.match(loaded[0].desired.revision, /^[a-f0-9]{64}$/);
});

test("profile package loader rejects an entry returning a different package identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-package-"));
  const packageRoot = path.join(root, "packages");
  await writePackage(packageRoot, entryModule.replace("id: context.bundle.id", "id: 'other'"));
  await assert.rejects(() => loadManagerPluginProfile({
    packageRoot,
    runtimeRoot: path.join(root, "runtime"),
    profile: parseRabiPluginProfile({ schemaVersion: 1, plugins: [{ id: "manager:echo", package: "example.echo", version: "1.0.0" }] }),
    createServices: () => ({ applied: [], disposed: [] })
  }), /manifest mismatch/);
});
