import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIsolatedWebUpdate, removeIsolatedWebWorkspace, captureAutomaticWebInputs } from "./lib/automatic-web-build.mjs";

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-web-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ["src/shared", "dist/manager", "dist/plugins/packages", "docs", "assets", "ribiwebgui", "node_modules", "scripts"]) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(root, "docs/index.md"), "Fixture documentation");
  await fs.writeFile(path.join(root, "ribiwebgui/index.html"), '<html>source</html>');
  await fs.writeFile(path.join(root, "scripts/sync-plugin-web-bundles.mjs"), "");
  await fs.writeFile(path.join(root, "dist/manager/webPatchCatalog.js"), `export * from ${JSON.stringify(new URL('../src/manager/webPatchCatalog.ts', import.meta.url).href)};`);
  const run = async destination => {
    await fs.mkdir(path.join(destination, "ribiwebgui/dist/assets"), { recursive: true });
    await fs.writeFile(path.join(destination, "ribiwebgui/dist/index.html"), '<html><script src="./assets/app.js"></script></html>');
    await fs.writeFile(path.join(destination, "ribiwebgui/dist/assets/app.js"), "export const built=true;");
  };
  return { sourceRoot: root, packageRoot: root, workRoot: path.join(root, "work"), run };
}

test("isolated Web candidates never write source dist and keep the installed backend fingerprint", async context => {
  const options = await fixture(context);
  const result = await buildIsolatedWebUpdate(options);
  assert.equal(result.state, "prepared");
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(await fs.stat(path.join(options.sourceRoot, "ribiwebgui/dist")).catch(() => undefined), undefined);
  const { webPatchBackend, verifyWebPatch } = await import("../src/manager/webPatchCatalog.ts");
  assert.equal((await verifyWebPatch(result.directory, result.revision)).backend, await webPatchBackend(options.packageRoot));
  await removeIsolatedWebWorkspace(options.workRoot, result.workspace);
  assert.deepEqual(await fs.readdir(options.workRoot), []);
  assert.ok((await fs.stat(path.join(options.sourceRoot, "node_modules"))).isDirectory());
});

test("concurrent edits discard an obsolete isolated Web build and clean its workspace", async context => {
  const options = await fixture(context);
  const run = options.run;
  let edited = false;
  options.run = async (...arguments_) => {
    await run(...arguments_);
    if (!edited) {
      edited = true;
      await fs.writeFile(path.join(options.sourceRoot, "ribiwebgui/added.vue"), "<template>new</template>");
    }
  };
  const result = await buildIsolatedWebUpdate(options);
  assert.equal(result.state, "superseded");
  assert.deepEqual(await fs.readdir(options.workRoot), []);
});

test("failed and cancelled builds produce no completion marker or persistent temporary directory", async context => {
  const options = await fixture(context);
  options.run = async () => { throw new Error("fixture compilation error"); };
  await assert.rejects(buildIsolatedWebUpdate(options), /fixture compilation error/);
  assert.deepEqual(await fs.readdir(options.workRoot), []);
  const controller = new AbortController();
  controller.abort(new Error("fixture abort"));
  await assert.rejects(buildIsolatedWebUpdate({ ...options, signal: controller.signal }), /fixture abort/);
  await assert.rejects(removeIsolatedWebWorkspace(options.workRoot, options.sourceRoot), /outside/);
});

test("Web dependency discovery includes both Vue script blocks after line comments", async context => {
  const options = await fixture(context);
  await fs.mkdir(path.join(options.sourceRoot, "ribiwebgui/src"));
  await fs.writeFile(path.join(options.sourceRoot, "ribiwebgui/src/app.vue"), '<script>export default {}; // trailing comment</script>\n<script setup>import {value} from "../../src/dependency.js";</script>');
  await fs.writeFile(path.join(options.sourceRoot, "src/dependency.ts"), 'export const value=1;');
  const baseline = await captureAutomaticWebInputs(options.sourceRoot);
  await fs.writeFile(path.join(options.sourceRoot, "src/dependency.ts"), 'export const value=2;');
  assert.notEqual((await captureAutomaticWebInputs(options.sourceRoot)).webDigest, baseline.webDigest);
});

test("Web dependency discovery follows imports without rebuilding for unrelated backend bodies", async context => {
  const options = await fixture(context);
  await fs.mkdir(path.join(options.sourceRoot, "ribiwebgui/src"));
  await fs.writeFile(path.join(options.sourceRoot, "ribiwebgui/tsconfig.json"), JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", module: "ESNext" }, include: ["src/**/*.ts"] }));
  await fs.writeFile(path.join(options.sourceRoot, "ribiwebgui/src/app.ts"), 'import {value} from "../../src/dependency.js"; console.log(value);');
  await fs.writeFile(path.join(options.sourceRoot, "src/dependency.ts"), 'export const value=1;');
  await fs.writeFile(path.join(options.sourceRoot, "src/unrelated.ts"), 'export const value=1;');
  const baseline = await captureAutomaticWebInputs(options.sourceRoot);
  await fs.writeFile(path.join(options.sourceRoot, "src/unrelated.ts"), 'export const value=2;');
  assert.equal((await captureAutomaticWebInputs(options.sourceRoot)).webDigest, baseline.webDigest);
  await fs.writeFile(path.join(options.sourceRoot, "src/dependency.ts"), 'export const value=2;');
  assert.notEqual((await captureAutomaticWebInputs(options.sourceRoot)).webDigest, baseline.webDigest);
});
