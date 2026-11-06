import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareWindowsRuntime } from "../lib/windows-runtime.mjs";
import { launcherLeaseTarget } from "../lib/cold-release-adoption.mjs";
import { collectReleaseAssetPaths, readReleaseAsset } from "../lib/release-assets.mjs";
import { pathToFileURL } from "node:url";
import { buildWindowsAgentBundle } from "../../../scripts/build-agent-windows-runtime.mjs";

const execute = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function waitFor(check, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(40); }
  throw new Error(`Windows runtime acceptance timed out: ${label}`);
}

test("private runtime preparation is atomic and rejects damaged candidates without changing the original", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-private-runtime-"));
  try {
    const bundleRoot = path.join(root, "bundle"), configPath = path.join(root, "state/config.json"), source = path.join(bundleRoot, "windows-runtime");
    fs.mkdirSync(path.join(source, "node_modules/npm/bin"), { recursive: true });
    fs.writeFileSync(path.join(source, "RabiAgent.Runtime.exe"), "fixture-runtime");
    fs.copyFileSync(path.join(source, "RabiAgent.Runtime.exe"), path.join(source, "node.exe"));
    fs.writeFileSync(path.join(source, "node_modules/npm/bin/npm-cli.js"), "fixture-npm");
    const files = ["RabiAgent.Runtime.exe", "node.exe", "node_modules/npm/bin/npm-cli.js"].map(relative => {
      const bytes = fs.readFileSync(path.join(source, relative)); return { path: relative, size: bytes.length, sha256: sha(bytes) };
    });
    const profile = { schemaVersion: 1, platform: "win32", architecture: process.arch, nodeVersion: "22.17.1", files };
    fs.writeFileSync(path.join(bundleRoot, "windows-runtime.json"), JSON.stringify(profile));
    const first = await prepareWindowsRuntime({ bundleRoot, configPath });
    assert.equal(first.reused, false);
    assert.equal((await prepareWindowsRuntime({ bundleRoot, configPath })).reused, true);
    const alias = path.join(path.dirname(first.executable), "node.exe");
    fs.unlinkSync(alias); fs.writeFileSync(alias, "damaged-alias");
    assert.equal((await prepareWindowsRuntime({ bundleRoot, configPath })).reused, false);
    assert.deepEqual(fs.readFileSync(alias), fs.readFileSync(first.executable));
    const before = fs.readFileSync(first.executable), receipt = fs.readFileSync(path.join(path.dirname(first.executable), "runtime-profile.json"));
    fs.appendFileSync(path.join(source, "RabiAgent.Runtime.exe"), "damaged");
    fs.writeFileSync(path.join(bundleRoot, "windows-runtime.json"), JSON.stringify({ ...profile, npmVersion: "new-candidate" }));
    await assert.rejects(prepareWindowsRuntime({ bundleRoot, configPath }), /asset does not match/);
    assert.deepEqual(fs.readFileSync(first.executable), before);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(first.executable), "runtime-profile.json")), receipt);
    assert.equal(fs.readdirSync(path.dirname(path.dirname(first.executable))).some(name => name.startsWith(".windows-")), false);
  } finally { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

async function privateRuntimeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-private-runtime-"));
  t.after(async () => {
    assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.match(path.basename(root), /^rabi-private-runtime-/);
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const bundleRoot = path.join(root, "bundle"), configPath = path.join(root, "state/config.json");
  const source = path.join(bundleRoot, "windows-runtime");
  const contents = {
    "RabiAgent.Runtime.exe": "fixture-image-never-executed",
    "node.exe": "fixture-image-never-executed",
    "node_modules/npm/bin/npm-cli.js": "fixture-npm-cli",
    "node_modules/npm/lib/cli.js": "fixture-npm-dependency"
  };
  const files = Object.entries(contents).map(([relative, content]) => {
    const filename = path.join(source, relative); fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content); const bytes = Buffer.from(content);
    return { path: relative, size: bytes.length, sha256: sha(bytes) };
  });
  fs.mkdirSync(path.dirname(configPath)); fs.writeFileSync(configPath, '{"nodeId":"private-runtime-fixture"}');
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, platform: "win32", architecture: process.arch, nodeVersion: "22.17.1", files }));
  fs.writeFileSync(path.join(bundleRoot, "windows-runtime.json"), receipt);
  const prepared = await prepareWindowsRuntime({ bundleRoot, configPath });
  assert.equal(prepared.reused, false);
  return { root, bundleRoot, configPath, source, runtime: path.dirname(prepared.executable), files, receipt };
}
function runtimeBytes(root, files) {
  return Object.fromEntries([...files.map(file => file.path), "runtime-profile.json"].map(relative => [relative, sha(fs.readFileSync(path.join(root, relative)))]));
}

test("private runtime reuse verifies complete npm contents and repairs damaged or missing files", { skip: process.platform !== "win32" }, async t => {
  const f = await privateRuntimeFixture(t);
  for (const relative of ["node_modules/npm/bin/npm-cli.js", "node_modules/npm/lib/cli.js"]) {
    const filename = path.join(f.runtime, relative), original = fs.readFileSync(filename);
    // Equal size forces the content hash, rather than just the size, to matter.
    fs.writeFileSync(filename, Buffer.alloc(original.length, 120));
    assert.equal((await prepareWindowsRuntime(f)).reused, false);
    assert.deepEqual(fs.readFileSync(filename), original);
    fs.unlinkSync(filename);
    assert.equal((await prepareWindowsRuntime(f)).reused, false);
    assert.deepEqual(fs.readFileSync(filename), original);
  }
  assert.equal((await prepareWindowsRuntime(f)).reused, true);
  assert.deepEqual(fs.readFileSync(path.join(f.runtime, "runtime-profile.json")), f.receipt);
});

test("private runtime reuse does not gate an intact active owner and damaged repair preserves busy owner bytes", { skip: process.platform !== "win32" }, async t => {
  const f = await privateRuntimeFixture(t), lease = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { lease.once("error", reject); lease.listen(launcherLeaseTarget(f.configPath), resolve); });
  try {
    assert.equal((await prepareWindowsRuntime(f)).reused, true, "intact launch reuses runtime without acquiring the active owner's lease");
    fs.writeFileSync(path.join(f.runtime, "node_modules/npm/bin/npm-cli.js"), "damaged-installed-npm");
    const before = runtimeBytes(f.runtime, f.files), config = fs.readFileSync(f.configPath);
    await assert.rejects(prepareWindowsRuntime(f), error => error.code === "RABI_AGENT_RUNTIME_BUSY");
    assert.deepEqual(runtimeBytes(f.runtime, f.files), before);
    assert.deepEqual(fs.readFileSync(f.configPath), config);
    assert.deepEqual(fs.readdirSync(path.dirname(f.runtime)).filter(name => name.startsWith(".windows-")), []);
  } finally { await new Promise(resolve => lease.close(resolve)); }
});

test("private runtime damaged source leaves the installed runtime and original receipts unchanged", { skip: process.platform !== "win32" }, async t => {
  const f = await privateRuntimeFixture(t);
  fs.writeFileSync(path.join(f.runtime, "node_modules/npm/bin/npm-cli.js"), "damaged-installed-npm");
  fs.writeFileSync(path.join(f.source, "node_modules/npm/lib/cli.js"), "damaged-source-npm");
  const installed = runtimeBytes(f.runtime, f.files), source = fs.readFileSync(path.join(f.source, "node_modules/npm/lib/cli.js"));
  await assert.rejects(prepareWindowsRuntime(f), /asset does not match its bundle/);
  assert.deepEqual(runtimeBytes(f.runtime, f.files), installed);
  assert.deepEqual(fs.readFileSync(path.join(f.source, "node_modules/npm/lib/cli.js")), source);
  assert.deepEqual(fs.readFileSync(path.join(f.bundleRoot, "windows-runtime.json")), f.receipt);
  assert.deepEqual(fs.readdirSync(path.dirname(f.runtime)).filter(name => name.startsWith(".windows-")), []);
});

test("private runtime rejects root and nested junctions without changing their external targets", { skip: process.platform !== "win32" }, async t => {
  const f = await privateRuntimeFixture(t), external = path.join(f.root, "external-runtime");
  const original = runtimeBytes(f.runtime, f.files);
  fs.renameSync(f.runtime, external); fs.symlinkSync(external, f.runtime, "junction");
  await assert.rejects(prepareWindowsRuntime(f), /must not redirect/);
  assert.equal(fs.lstatSync(f.runtime).isSymbolicLink(), true);
  assert.deepEqual(runtimeBytes(external, f.files), original);
  fs.unlinkSync(f.runtime); fs.renameSync(external, f.runtime);
  const nested = path.join(f.runtime, "node_modules/npm"), externalNpm = path.join(f.root, "external-npm");
  fs.renameSync(nested, externalNpm); fs.symlinkSync(externalNpm, nested, "junction");
  const cli = fs.readFileSync(path.join(externalNpm, "bin/npm-cli.js")), dependency = fs.readFileSync(path.join(externalNpm, "lib/cli.js"));
  await assert.rejects(prepareWindowsRuntime(f), /must not redirect/);
  assert.equal(fs.lstatSync(nested).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(path.join(externalNpm, "bin/npm-cli.js")), cli);
  assert.deepEqual(fs.readFileSync(path.join(externalNpm, "lib/cli.js")), dependency);
  assert.deepEqual(fs.readFileSync(path.join(f.runtime, "runtime-profile.json")), f.receipt);
});

test("private runtime repair retains an explicitly selected source bundle alias", { skip: process.platform !== "win32" }, async t => {
  const f = await privateRuntimeFixture(t), alias = path.join(f.root, "explicit-bundle-alias");
  fs.symlinkSync(f.bundleRoot, alias, "junction");
  const source = runtimeBytes(f.runtime, f.files);
  fs.writeFileSync(path.join(f.runtime, "node_modules/npm/bin/npm-cli.js"), "damaged-installed-npm");
  assert.equal((await prepareWindowsRuntime({ bundleRoot: alias, configPath: f.configPath })).reused, false);
  assert.deepEqual(runtimeBytes(f.runtime, f.files), source);
  assert.deepEqual(fs.readFileSync(path.join(alias, "windows-runtime.json")), f.receipt);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
});

const bundle = process.env.RABI_AGENT_WINDOWS_TEST_BUNDLE;
test("explicit Windows bundle runs and autostarts the branded private Node with its own npm; active or mapped runtimes stay intact", {
  skip: process.platform !== "win32" || !bundle, timeout: 120_000
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-windows-entry-")), configPath = path.join(root, "state/config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const manager = http.createServer((_request, response) => { response.writeHead(503, { "content-type": "application/json" }); response.end('{"code":-1,"error":"isolated fixture"}'); });
  await new Promise(resolve => manager.listen(0, "127.0.0.1", resolve));
  const config = { schemaVersion: 1, nodeId: "fixture-windows-node", nodeCredential: "fixture-only", managerUrl: `http://127.0.0.1:${manager.address().port}`,
    managerGuid: "fixture-manager", releasePublicKeySha256: "a".repeat(64), defaultWorkspace: root, allowedWorkspaces: [root], agents: [] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const env = { ...process.env, APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"), USERPROFILE: root };
  const executable = path.join(root, "state/runtime/windows-" + process.arch, "RabiAgent.Runtime.exe"), launcher = path.join(root, "state/rabi-agent-launcher.mjs");
  const koffi = (await import("koffi")).default, kernel = koffi.load("kernel32.dll");
  const open = kernel.func("void* __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(void* handle, uint32_t milliseconds)");
  const exitCode = kernel.func("int __stdcall GetExitCodeProcess(void* handle, _Out_ uint32_t* exitCode)");
  const terminate = kernel.func("int __stdcall TerminateProcess(void* handle, uint32_t exitCode)");
  const close = kernel.func("int __stdcall CloseHandle(void* handle)");
  const handles = [];
  const capture = pid => { const handle = open(0x100001, 0, pid); assert.ok(handle, "capture the fixture's original process handle"); handles.push(handle); return handle; };
  const allExited = () => handles.every(handle => wait(handle, 0) === 0);
  const phase = message => console.error("# Windows runtime phase:", message);
  let state, mapped, mappedClosed, started;
  const command = async (...args) => execute(fs.realpathSync.native(executable), [fs.realpathSync.native(launcher), "--config", fs.realpathSync.native(configPath), ...args], { env, windowsHide: true, timeout: 15_000 });
  t.after(async () => {
    try {
      if (mapped && mapped.exitCode === null && mapped.signalCode === null) mapped.kill("SIGKILL");
      await mappedClosed;
      if (fs.existsSync(launcher)) await command("--stop").catch(() => undefined);
      // Held handles prevent PID reuse from targeting an unrelated later process.
      for (const handle of handles) if (wait(handle, 0) !== 0) terminate(handle, 1);
      await waitFor(allExited, "all original fixture process handles signalled");
    } finally {
      for (const handle of handles) close(handle);
      manager.closeAllConnections(); await new Promise(resolve => manager.close(resolve));
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
  const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  started = JSON.parse((await execute(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(bundle, "desktop/start-windows.ps1"), "-Config", configPath], { env, windowsHide: true, timeout: 60_000 })).stdout);
  capture(started.pid); phase("main process handed over");
  assert.equal(fs.realpathSync.native(started.executable).toLowerCase(), fs.realpathSync.native(executable).toLowerCase());
  let lastStatusError;
  await waitFor(async () => {
    if (wait(handles[0], 0) === 0) { const code = [0]; exitCode(handles[0], code); throw new Error(`The original main program exited before ready: ${code[0]}`); }
    try { state = JSON.parse((await command("--command", "status")).stdout); return state.workerPid && state.trayPid; }
    catch (error) { if (lastStatusError !== error.message) phase("status query: " + error.message); lastStatusError = error.message; return false; }
  }, "original main owner and native tray ready");
  capture(state.workerPid); capture(state.trayPid); phase("main, worker and tray ready");
  assert.equal(state.pid, started.pid);
  assert.equal(JSON.parse((await execute(executable, ["-p", "JSON.stringify({version:process.versions.node,architecture:process.arch,executable:process.execPath})"], { env, windowsHide: true })).stdout).version, "22.17.1");
  const npmCli = path.join(path.dirname(executable), "node_modules/npm/bin/npm-cli.js");
  assert.match((await execute(executable, [npmCli, "--version"], { env, windowsHide: true })).stdout.trim(), /^\d+\.\d+\.\d+$/);
  const scriptRoot = path.join(root, "npm-script"); fs.mkdirSync(scriptRoot);
  fs.writeFileSync(path.join(scriptRoot, "package.json"), JSON.stringify({ scripts: { probe: "node -p \"JSON.stringify({version:process.versions.node,executable:process.execPath})\"" } }));
  const probe = JSON.parse((await execute(executable, [npmCli, "--silent", "run", "probe"], { cwd: scriptRoot,
    env: { ...env, PATH: path.dirname(executable) + path.delimiter + (env.PATH || "") }, windowsHide: true })).stdout.trim());
  assert.equal(probe.version, "22.17.1");
  assert.equal(path.dirname(fs.realpathSync.native(probe.executable)).toLowerCase(), path.dirname(fs.realpathSync.native(executable)).toLowerCase(), "npm scripts never fall back to a different system Node");
  phase("private interpreter and npm verified");
  await command("--command", "enable-startup");
  const startup = fs.readFileSync(path.join(env.APPDATA, "Microsoft/Windows/Start Menu/Programs/Startup/RabiAgent.vbs"), "utf16le");
  assert.equal(startup.toLowerCase().includes(fs.realpathSync.native(executable).toLowerCase()), true, "login startup uses the same stable branded interpreter");
  phase("login startup verified");
  const beforeNode = sha(fs.readFileSync(executable)), beforeProfile = fs.readFileSync(path.join(path.dirname(executable), "runtime-profile.json"));
  const changed = path.join(root, "candidate"); fs.mkdirSync(changed);
  fs.writeFileSync(path.join(changed, "windows-runtime.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(bundle, "windows-runtime.json"))), npmVersion: "changed-candidate" }));
  await assert.rejects(prepareWindowsRuntime({ bundleRoot: changed, configPath }), error => error.code === "RABI_AGENT_RUNTIME_BUSY");
  phase("active owner preserved");
  assert.equal(sha(fs.readFileSync(executable)), beforeNode);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(executable), "runtime-profile.json")), beforeProfile);
  const repeated = JSON.parse((await execute(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(bundle, "desktop/start-windows.ps1"), "-Config", configPath], { env, windowsHide: true, timeout: 20_000 })).stdout);
  assert.equal(repeated.status, "already_running"); assert.equal(repeated.pid, state.pid);
  phase("repeated entry reuses owner");
  await command("--stop");
  await waitFor(allExited, "normal complete application exit"); phase("all original processes closed");
  const cscript = path.join(process.env.SystemRoot, "System32/cscript.exe");
  await execute(cscript, ["//B", "//NoLogo", path.join(env.APPDATA, "Microsoft/Windows/Start Menu/Programs/Startup/RabiAgent.vbs")],
    { env, windowsHide: true, timeout: 15_000 });
  await waitFor(async () => {
    try { state = JSON.parse((await command("--command", "status")).stdout); return state.workerPid && state.trayPid; }
    catch { return false; }
  }, "generated login script starts the original branded owner entry");
  capture(state.pid); capture(state.workerPid); capture(state.trayPid);
  assert.notEqual(state.pid, started.pid);
  phase("generated login script starts branded main, worker and tray");
  await command("--stop");
  await waitFor(allExited, "login-script application exit"); phase("login-script processes closed");
  mapped = spawn(executable, ["-e", "console.log('mapped');setInterval(()=>{},1000)"], { env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  mappedClosed = new Promise(resolve => mapped.once("close", resolve));
  await new Promise((resolve, reject) => { mapped.stdout.once("data", resolve); mapped.once("error", reject); });
  await assert.rejects(prepareWindowsRuntime({ bundleRoot: changed, configPath }), error => ["EBUSY", "EPERM", "EACCES"].includes(error.code));
  phase("mapped image preserved");
  assert.equal(sha(fs.readFileSync(executable)), beforeNode);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(executable), "runtime-profile.json")), beforeProfile);
  t.diagnostic(JSON.stringify({ runtime: path.basename(executable), version: "22.17.1", startupUsesPrivateRuntime: true, npmBesideRuntime: true,
    startupScriptExecuted: true, ownerExitConfirmed: true, activeOwnerPreserved: true, mappedImagePreserved: true }));
});

test("Windows runtime bundle requires the explicitly expected Node identity", { skip: process.platform !== "win32" || !process.env.RABI_AGENT_WINDOWS_TEST_NODE_ROOT }, async () => {
  await assert.rejects(buildWindowsAgentBundle({ nodeRoot: process.env.RABI_AGENT_WINDOWS_TEST_NODE_ROOT, expectedNodeVersion: "0.0.0",
    expectedNodeArchitecture: process.arch, outputRoot: path.join(os.tmpdir(), "rabi-wrong-node-" + Date.now()) }), /does not match/);
});


test("source release projection keeps the plugin owner unique and materialized imports independent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-agent-owned-release-"));
  try {
    const sourceRoot = path.join(root, "source"), agent = path.join(sourceRoot, "apps/rabi-agent"), output = path.join(root, "outside");
    const owner = "io.rabiroute.agent.dsh", sourcePath = `src/plugins/${owner}/apps/rabi-agent/lib/dsh.mjs`;
    const artifact = `lib/plugin-owners/${owner}/dsh.mjs`;
    fs.mkdirSync(path.join(agent, "lib"), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(sourceRoot, sourcePath)), { recursive: true });
    const original = `import { normalizeDshBinding } from "../../${sourcePath}";
export { normalizeDshBinding };
export const text = "../../${sourcePath}";
`;
    fs.writeFileSync(path.join(agent, "rabi-agent.mjs"), original);
    fs.writeFileSync(path.join(agent, "lib/instance-agents.mjs"), `import { normalizeDshBinding } from "../../../${sourcePath}";
export { normalizeDshBinding };
`);
    const ownerBytes = Buffer.from("export function normalizeDshBinding(value) { return value; }\n");
    fs.writeFileSync(path.join(sourceRoot, sourcePath), ownerBytes);
    const options = { pluginSourceRoot: sourceRoot };
    const files = collectReleaseAssetPaths(agent, "", options);
    assert.equal(files.filter(file => file === artifact).length, 1);
    for (const file of files) {
      const destination = path.join(output, file); fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, readReleaseAsset(agent, file, options));
    }
    assert.equal(fs.readFileSync(path.join(agent, "rabi-agent.mjs"), "utf8"), original);
    assert.equal(readReleaseAsset(agent, "rabi-agent.mjs").toString(), original);
    assert.deepEqual(fs.readFileSync(path.join(output, artifact)), ownerBytes);
    if (process.platform === "win32") {
      const alias = path.join(root, "agent-source-junction"); fs.symlinkSync(agent, alias, "junction");
      assert.deepEqual(readReleaseAsset(alias, "lib/instance-agents.mjs", { pluginSourceRoot: sourceRoot.toUpperCase() }),
        readReleaseAsset(agent, "lib/instance-agents.mjs", options));
    }
    const otherSource = path.join(root, "other-source");
    fs.mkdirSync(path.dirname(path.join(otherSource, sourcePath)), { recursive: true }); fs.writeFileSync(path.join(otherSource, sourcePath), ownerBytes);
    assert.throws(() => readReleaseAsset(agent, "lib/instance-agents.mjs", { pluginSourceRoot: otherSource }), /does not match/);
    fs.renameSync(sourceRoot, path.join(root, "source-retired"));
    const entry = await import(pathToFileURL(path.join(output, "rabi-agent.mjs")).href);
    const instance = await import(pathToFileURL(path.join(output, "lib/instance-agents.mjs")).href);
    assert.equal(entry.normalizeDshBinding, instance.normalizeDshBinding);
    assert.equal(entry.text, `../../${sourcePath}`);
    assert.deepEqual(readReleaseAsset(output, artifact), ownerBytes);
    assert.deepEqual(collectReleaseAssetPaths(output).sort(), files.sort());
    assert.throws(() => readReleaseAsset(output, "../outside.mjs"), /Invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("a materialized legacy asset inventory and bytes never require the current plugin source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-legacy-agent-assets-"));
  try {
    fs.mkdirSync(path.join(root, "lib"));
    const bytes = Buffer.from('import { normalizeDshBinding } from "../../../src/plugins/io.rabiroute.agent.dsh/apps/rabi-agent/lib/dsh.mjs";\n');
    fs.writeFileSync(path.join(root, "lib/instance-agents.mjs"), bytes);
    assert.deepEqual(collectReleaseAssetPaths(root), ["lib/instance-agents.mjs"]);
    assert.deepEqual(readReleaseAsset(root, "lib/instance-agents.mjs"), bytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
