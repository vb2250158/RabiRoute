import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildInstanceAgentRuntime } from "./build-native-agent-runtime.mjs";

async function fixture(t, entry) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-agent-module-urls-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, contents) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  };
  await write("package.json", { name: "native-runtime-fixture", version: "0.7.0", type: "module" });
  await write("apps/rabi-agent/package.json", { name: "fixture-agent", dependencies: {} });
  await write("plugins/contracts/plugin-sdk/index.mjs", "export const fixture = true;\n");
  await write("plugins/profiles/package-migrations.json", { schemaVersion: 1, packages: [] });
  await write("dist/agent-hooks/fixture.mjs", "export const hook = true;\n");
  const plugin = "dist/plugins/packages/io.test.agent/1.0.0/";
  await write(plugin + "rabi.plugin.json", { schemaVersion: 2, id: "io.test.agent", version: "1.0.0",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: ["agent.adapter.fixture@1"] });
  await write(plugin + "agent-adapter.json", { type: "fixture", capability: "agent.adapter.fixture@1", manifest: { type: "fixture" } });
  await write(plugin + "runtime.mjs", "export const hostModules = [];\n");
  await write("dist/plugins/profiles/desktop.json", { schemaVersion: 2, readyRequires: [], instances: [
    { id: "fixture:agent", package: "io.test.agent", version: "1.0.0", enabled: true, config: {}, grants: [] }
  ] });
  for (const [module, names] of [
    ["agentAdapters/remoteAgentManager", ["mountRemoteAgentManager"]],
    ["runtime/agentPluginRuntime", ["mountAgentPluginRuntime"]],
    ["runtime/agentAdapterHostPorts", ["createAgentAdapterHostPorts"]],
    ["manager/agentManagerProviders", ["resolvePublishedAgentManagerProviders", "invokeAgentManagerOperation"]],
    ["manager/agentAdapterCatalogWorker", ["executeAgentAdapterCatalogWorkerTask"]]
  ]) await write("src/" + module + ".ts", names.map(name => `export function ${name}() {}`).join("\n"));
  await write("src/agentAdapters/instanceManagement.ts", entry);
  return { root, write, output: path.join(root, "apps/rabi-agent/runtime") };
}

test("directory module URLs remain locators while actual module imports and resource bytes are copied", async t => {
  const f = await fixture(t, 'export { value } from "./fixture-helper.js"; export const packageUrl = new URL("../../", import.meta.url).href; export const assetsUrl = new URL("../../assets/", import.meta.url).href; export const resourceUrl = new URL("../../resources/value.txt", import.meta.url);');
  await f.write("src/agentAdapters/fixture-helper.ts", 'export const value = { original: "shared module" };\n');
  await f.write("assets/unreferenced.txt", "Directory locators do not copy a whole tree.");
  await f.write("resources/value.txt", Buffer.from("original resource bytes\r\n").toString());
  await buildInstanceAgentRuntime(f.root);
  const owner = await import(pathToFileURL(path.join(f.output, "management.mjs")).href);
  const helper = await import(pathToFileURL(path.join(f.output, "backend/src/agentAdapters/fixture-helper.js")).href);
  assert.equal(owner.value, helper.value, "native module boundaries preserve the original shared object");
  assert.equal(owner.packageUrl, pathToFileURL(path.join(f.output, "backend") + path.sep).href);
  assert.equal(await fs.readFile(owner.resourceUrl, "utf8"), "original resource bytes\r\n");
  await assert.rejects(fs.access(path.join(f.output, "backend/assets/unreferenced.txt")), { code: "ENOENT" });
  const evidence = JSON.parse(await fs.readFile(path.join(f.output, "native-runtime-build.json"), "utf8"));
  assert.ok(evidence.modules.includes("src/agentAdapters/fixture-helper.ts"));
  assert.ok(!evidence.modules.includes("") && !evidence.modules.includes("assets"));
});

test("a directory used by both import and URL remains an invalid real module dependency", async t => {
  const f = await fixture(t, 'import "./directory"; export const locator = new URL("./directory", import.meta.url);');
  await f.write("src/agentAdapters/directory/index.ts", "export const value = 1;\n");
  await assert.rejects(buildInstanceAgentRuntime(f.root), /Remote module dependency is a directory/);
  await assert.rejects(fs.access(f.output), { code: "ENOENT" });
});

test("a missing real import is not hidden by a matching optional resource URL", async t => {
  const f = await fixture(t, 'import "./missing.js"; export const locator = new URL("./missing.js", import.meta.url);');
  await assert.rejects(buildInstanceAgentRuntime(f.root), /Missing remote dependency/);
});

test("outside-workspace directory and missing resource URLs remain rejected", async t => {
  const f = await fixture(t, 'export const locator = new URL("../../../", import.meta.url);');
  await assert.rejects(buildInstanceAgentRuntime(f.root), /Remote source escapes workspace/);
  await f.write("src/agentAdapters/instanceManagement.ts", 'export const locator = new URL("../../../not-a-local-resource.json", import.meta.url);');
  await assert.rejects(buildInstanceAgentRuntime(f.root), /Remote source escapes workspace/);
});

test("embedded SDK runtime copies omit development tests and preserve Host API manifests and types", async t => {
  const f = await fixture(t, "export const ready = true;\n");
  await f.write("plugins/contracts/plugin-sdk/builder.test.mjs", "development SDK test");
  await f.write("plugins/contracts/plugin-sdk/src/auth/authorize.ts", "public SDK implementation");
  await f.write("plugins/contracts/host-api/modules.json", { schemaVersion: 1, modules: {} });
  await f.write("plugins/contracts/host-api/types/public.d.ts", "export type Public = string;\n");
  await buildInstanceAgentRuntime(f.root);
  for (const relative of ["backend/node_modules/@rabiroute/plugin-sdk", "plugins/contracts/plugin-sdk"]) {
    await assert.rejects(fs.access(path.join(f.output, relative, "builder.test.mjs")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(f.output, relative, "index.mjs"), "utf8"), "export const fixture = true;\n");
    assert.equal(await fs.readFile(path.join(f.output, relative, "src/auth/authorize.ts"), "utf8"), "public SDK implementation");
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.output, "plugins/contracts/host-api/modules.json"), "utf8")), { schemaVersion: 1, modules: {} });
  assert.equal(await fs.readFile(path.join(f.output, "plugins/contracts/host-api/types/public.d.ts"), "utf8"), "export type Public = string;\n");
  assert.equal((await import(pathToFileURL(path.join(f.output, "management.mjs")).href)).ready, true);
});
