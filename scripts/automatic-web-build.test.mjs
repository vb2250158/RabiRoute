import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { buildIsolatedWebUpdate, removeIsolatedWebWorkspace, captureAutomaticWebInputs } from "./lib/automatic-web-build.mjs";

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-web-"));
  const cleanup = [];
  context.after(async () => { for (const retire of cleanup.toReversed()) await retire(); await fs.rm(root, { recursive: true, force: true }); });
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
  return { sourceRoot: root, packageRoot: root, workRoot: path.join(root, "work"), run, cleanup };
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

async function nativeWebFixture(context) {
  const options = await fixture(context);
  await fs.mkdir(path.join(options.packageRoot, "dist/runtime"), { recursive: true });
  // Copy the real production launch/admission/Job closure, never a fake helper.
  for (const name of ["protectedProcessLauncher.mjs", "protectedProcessBootstrap.mjs", "windowsJobObject.mjs"]) {
    await fs.copyFile(new URL(`../src/runtime/${name}`, import.meta.url), path.join(options.packageRoot, "dist/runtime", name));
  }
  if (process.platform === "win32") {
    const require = createRequire(import.meta.url);
    for (const name of ["koffi", `@koromix/koffi-win32-${process.arch}`]) {
      const directory = path.dirname(require.resolve(name));
      assert.equal(JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8")).name, name);
      // The controller loads the real native binding too. Keep its mapped DLL
      // in the test dependency owner, outside this disposable source fixture.
      const link = path.join(options.sourceRoot, "node_modules", name);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(directory, link, "junction");
      options.cleanup.push(async () => { assert.equal((await fs.lstat(link)).isSymbolicLink(), true); await fs.unlink(link); });
    }
  }
  return options;
}
function originalWebProcess() {
  const koffi = createRequire(import.meta.url)("koffi"), kernel = koffi.load("kernel32.dll");
  const open = kernel.func("void* __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(void* handle, uint32_t milliseconds)");
  const terminate = kernel.func("int __stdcall TerminateProcess(void* handle, uint32_t code)");
  const close = kernel.func("int __stdcall CloseHandle(void* handle)");
  let handle;
  return { capture(pid) { handle = open(0x100001, 0, pid); assert.ok(handle); },
    wait: () => wait(handle, 0), dispose() { if (handle) { if (wait(handle, 0) === 258) { terminate(handle, 1); assert.equal(wait(handle, 5000), 0); } close(handle); } } };
}
async function startNativeWebFixture(options, context) {
  const ready = path.join(options.sourceRoot, "leaf-ready");
  const program = path.join(options.sourceRoot, "node_modules/vue-tsc/bin/vue-tsc.js");
  await fs.mkdir(path.dirname(program), { recursive: true });
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
  await fs.writeFile(program, `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{windowsHide:true,stdio:'ignore',detached:true});
    child.unref();setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const built = buildIsolatedWebUpdate({ ...options, run: undefined, signal: controller.signal });
  // Observe rejection immediately while the actual child starts.
  void built.catch(() => {});
  options.cleanup.push(async () => {
    context.mock.restoreAll(); controller.abort();
    try { await built; } catch (error) { if (error.retryCleanup) await error.retryCleanup(); }
  });
  const deadline = Date.now() + 5000;
  while (!await fs.access(ready).then(() => true, () => false)) {
    if (Date.now() > deadline) throw new Error("Fixture Web compiler did not start");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const original = originalWebProcess(); original.capture(Number(await fs.readFile(ready, "utf8")));
  options.cleanup.push(() => original.dispose());
  return { built, controller, original };
}

test("aborted native Web builds join original stdio-independent descendant HANDLE exit before deleting the workspace", { skip: process.platform !== "win32", timeout: 15_000 }, async context => {
  const options = await nativeWebFixture(context);
  const { built, controller, original } = await startNativeWebFixture(options, context);
  // The old natural 'done after1.5s' marker only proved inherited stream
  // closure. The owned Job must retire even a child with independent stdio.
  controller.abort();
  await assert.rejects(built, /abort/i);
  assert.equal(original.wait(), 0, "the held original descendant HANDLE must be signalled at return");
  assert.deepEqual(await fs.readdir(options.workRoot), []);
});

test("unconfirmed native Web retirement preserves its workspace and retries only the original owner cleanup", { skip: process.platform !== "win32", timeout: 15_000 }, async context => {
  const options = await nativeWebFixture(context);
  let fail = true, unconfirmed;
  // Fault-inject the real Job method before the production launcher binds it.
  // This intercepts only the fixture's existing workspace setup boundary.
  const symlink = fs.symlink.bind(fs);
  context.mock.method(fs, "symlink", async (...args) => {
    const result = await symlink(...args);
    const { WindowsJobTree } = await import(pathToFileURL(path.join(path.dirname(args[1]), "dist/runtime/windowsJobObject.mjs")));
    const terminate = WindowsJobTree.prototype.terminate;
    context.mock.method(WindowsJobTree.prototype, "terminate", function() {
      if (fail) { fail = false; throw new Error("fixture original Job termination failed"); }
      return terminate.call(this);
    });
    return result;
  });
  const { built, controller, original } = await startNativeWebFixture(options, context);
  const workspace = path.join(options.workRoot, (await fs.readdir(options.workRoot))[0]);
  const snapshot = await fs.readFile(path.join(workspace, "package/package.json"));
  controller.abort();
  await assert.rejects(built, error => { unconfirmed = error; return error.code === "RABI_WEB_BUILD_RETIREMENT_UNCONFIRMED"; });
  assert.equal(original.wait(), 258);
  assert.equal(unconfirmed.workspace, workspace);
  assert.deepEqual(await fs.readFile(path.join(workspace, "package/package.json")), snapshot);
  context.mock.restoreAll();
  await unconfirmed.retryCleanup();
  assert.equal(original.wait(), 0);
  assert.deepEqual(await fs.readdir(options.workRoot), []);
  await unconfirmed.retryCleanup();
});

test("normal native Web commands still produce a verified isolated candidate", { skip: process.platform !== "win32", timeout: 20_000 }, async context => {
  const options = await nativeWebFixture(context);
  for (const [relative, program] of [
    ["vue-tsc/bin/vue-tsc.js", "process.exitCode=0;"],
    ["vite/bin/vite.js", "const fs=require('node:fs');fs.mkdirSync('ribiwebgui/dist/assets',{recursive:true});fs.writeFileSync('ribiwebgui/dist/index.html','<html><script src=\"./assets/app.js\"></script></html>');fs.writeFileSync('ribiwebgui/dist/assets/app.js','export const built=true;');"]
  ]) {
    const destination = path.join(options.sourceRoot, "node_modules", relative);
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, program);
  }
  const result = await buildIsolatedWebUpdate({ ...options, run: undefined });
  assert.equal(result.state, "prepared");
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  await removeIsolatedWebWorkspace(options.workRoot, result.workspace);
  assert.deepEqual(await fs.readdir(options.workRoot), []);
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

test("isolated Web builds snapshot the full Manager discovery dependency", async context => {
  const options = await fixture(context);
  await fs.mkdir(path.join(options.sourceRoot, "scripts/lib"), { recursive: true });
  const relative = "scripts/lib/windows-host-discovery.mjs";
  await fs.writeFile(path.join(options.sourceRoot, relative), "export const revision=1;");
  const baseline = await captureAutomaticWebInputs(options.sourceRoot);
  assert.equal(baseline.files.get(relative).toString(), "export const revision=1;");
  await fs.writeFile(path.join(options.sourceRoot, relative), "export const revision=2;");
  assert.notEqual((await captureAutomaticWebInputs(options.sourceRoot)).webDigest, baseline.webDigest);
  const run = options.run;
  options.run = async (...args) => {
    assert.equal(await fs.readFile(path.join(args[0], relative), "utf8"), "export const revision=2;");
    await run(...args);
  };
  const result = await buildIsolatedWebUpdate(options);
  assert.equal(result.state, "prepared");
  await removeIsolatedWebWorkspace(options.workRoot, result.workspace);
});


test("isolated Web discovery imports its actual frozen timeout dependency", async context => {
  const options = await fixture(context);
  await fs.mkdir(path.join(options.sourceRoot, "scripts/lib"), { recursive: true });
  for (const name of ["discover-manager-url.mjs", "windows-host-discovery.mjs", "timeout-settings.mjs"]) {
    await fs.copyFile(new URL("./lib/" + name, import.meta.url), path.join(options.sourceRoot, "scripts/lib", name));
  }
  const baseline = await captureAutomaticWebInputs(options.sourceRoot);
  const relative = "scripts/lib/timeout-settings.mjs";
  await fs.appendFile(path.join(options.sourceRoot, relative), "\n// changed timeout implementation\n");
  const changed = await captureAutomaticWebInputs(options.sourceRoot);
  assert.notEqual(changed.webDigest, baseline.webDigest);
  const run = options.run;
  options.run = async (...args) => {
    const root = args[0];
    assert.equal(await fs.readFile(path.join(root, relative), "utf8"), changed.files.get(relative).toString());
    const actual = await import(pathToFileURL(path.join(root, "scripts/lib/discover-manager-url.mjs")).href);
    assert.equal(typeof actual.discoverManagerIdentity, "function");
    await run(...args);
  };
  const result = await buildIsolatedWebUpdate(options);
  assert.equal(result.state, "prepared");
  await removeIsolatedWebWorkspace(options.workRoot, result.workspace);
});
