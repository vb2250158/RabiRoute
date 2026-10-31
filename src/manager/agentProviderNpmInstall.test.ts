import assert from "node:assert/strict";
import { ChildProcess, execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentProviderProcessScope, CopilotControlService, resolveCopilotInstallNpmCli } from "./agentProviderControlService.js";
import { createCopilotControlOperations } from "./agentProviderControlRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

class ObservedScope extends AgentProviderProcessScope {
  readonly launched: ChildProcess[] = [];
  readonly closed = new Set<ChildProcess>();
  constructor(private readonly onTrack: (child: ChildProcess) => void = () => {}) { super(); }
  override track(child: ChildProcess) {
    this.launched.push(child); child.once("close", () => { this.closed.add(child); });
    const tracked = super.track(child); this.onTrack(child); return tracked;
  }
}

async function fakeNpm(t: test.TestContext, script: string) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "copilot-npm-node-fixture-"));
  const directory = path.join(root, "space & literal ^ %FIXTURE% ! $() ; [npm]", "node_modules", "npm", "bin");
  await fsp.mkdir(directory, { recursive: true });
  const filename = path.join(directory, "npm-cli.js"); await fsp.writeFile(filename, script);
  const previous = process.env.npm_execpath;
  process.env.npm_execpath = filename;
  t.after(async () => {
    if (previous === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, filename };
}

test("packaged Windows Node resolves system npm.cmd to the SDK's real adjacent CLI layout", () => {
  const npmCli = "D:\\System ; Node & npm\\node_modules\\npm\\bin\\npm-cli.js";
  const files = new Set(["D:\\System ; Node & npm\\npm.cmd", npmCli]);
  assert.equal(resolveCopilotInstallNpmCli({ execPath: "C:\\Standalone Package\\RabiRoute.Node.exe", platform: "win32",
    env: { Path: '"D:\\System ; Node & npm";E:\\Other' }, isFile: name => files.has(name), realpath: name => name }), npmCli);
});

test("POSIX PATH symlink resolves to the actual npm-cli.js without running its wrapper", () => {
  const actual = "/opt/npm tree/lib/node_modules/npm/bin/npm-cli.js";
  const files = new Set(["/usr/local/bin/npm", actual]);
  assert.equal(resolveCopilotInstallNpmCli({ execPath: "/opt/standalone/RabiRoute.Node", platform: "linux", env: { PATH: "/usr/local/bin:/usr/bin" },
    isFile: name => files.has(name), realpath: name => { assert.equal(name, "/usr/local/bin/npm"); return actual; } }), actual);
});

test("SDK Node-adjacent and explicit npm resolution stay authoritative ahead of PATH", () => {
  const adjacent = "C:\\Node\\node_modules\\npm\\bin\\npm-cli.js";
  assert.equal(resolveCopilotInstallNpmCli({ execPath: "C:\\Node\\node.exe", platform: "win32", env: { PATH: "D:\\Other" }, isFile: name => name === adjacent }), adjacent);
  assert.throws(() => resolveCopilotInstallNpmCli({ execPath: "C:\\Node\\node.exe", platform: "win32", env: { npm_execpath: "relative-npm.js", PATH: "D:\\Other" }, isFile: () => true }), /absolute file/);
  assert.throws(() => resolveCopilotInstallNpmCli({ execPath: "C:\\Standalone\\RabiRoute.Node.exe", platform: "win32", env: { PATH: "D:\\No npm" }, isFile: () => false }), /Repair the local Node\/npm/);
});

test("default install uses a real Node child and literal argv despite spaces and shell metacharacters", { timeout: 10000 }, async t => {
  const fixture = await fakeNpm(t, "process.stdout.write(JSON.stringify({executable:process.execPath,script:process.argv[1],args:process.argv.slice(2)}));process.stderr.write('fixture detail');");
  const scope = new ObservedScope(), service = new CopilotControlService({ scope }); t.after(() => service.stop());
  const reply = await service.install();
  assert.deepEqual(JSON.parse(reply.stdout!), { executable: process.execPath, script: fixture.filename, args: ["install", "-g", "@github/copilot"] });
  assert.equal(reply.stderr, "fixture detail"); assert.equal(scope.launched.length, 1); assert.equal(scope.closed.has(scope.launched[0]!), true);
  assert.equal(scope.launched[0]!.spawnfile, process.execPath);
});

test("default install preserves failed Node output and waits for the actual close", { timeout: 10000 }, async t => {
  await fakeNpm(t, "process.stdout.write('before failure');process.stderr.write('controlled npm failure');process.exit(7);");
  const scope = new ObservedScope(), service = new CopilotControlService({ scope }); t.after(() => service.stop());
  await assert.rejects(service.install(), error => {
    assert.equal((error as { code: number }).code, 7); assert.equal((error as { stdout: string }).stdout, "before failure");
    assert.equal((error as { stderr: string }).stderr, "controlled npm failure"); assert.equal(scope.closed.has(scope.launched[0]!), true); return true;
  });
});

test("real standalone RabiRoute.Node.exe installs through a PATH npm.cmd's CLI without invoking the shim", { skip: process.platform !== "win32", timeout: 15000 }, async t => {
  const fixture = await fakeNpm(t, "process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write('packaged Node fixture');");
  const runtime = path.join(fixture.root, "runtime"), prefix = path.join(fixture.root, "system npm & spaces");
  const executable = path.join(runtime, "RabiRoute.Node.exe"), script = path.join(prefix, "node_modules/npm/bin/npm-cli.js");
  await fsp.mkdir(runtime); await fsp.mkdir(path.dirname(script), { recursive: true });
  await fsp.copyFile(fixture.filename, script);
  await fsp.writeFile(path.join(prefix, "npm.cmd"), "@echo off\r\nexit /b 99\r\n");
  try { await fsp.link(process.execPath, executable); } catch { await fsp.copyFile(process.execPath, executable); }
  const originalExecutable = Object.getOwnPropertyDescriptor(process, "execPath")!;
  const pathKey = Object.keys(process.env).find(name => name.toLowerCase() === "path") ?? "PATH", oldPath = process.env[pathKey];
  Object.defineProperty(process, "execPath", { ...originalExecutable, value: executable });
  process.env[pathKey] = prefix; delete process.env.npm_execpath;
  t.after(() => { Object.defineProperty(process, "execPath", originalExecutable); if (oldPath === undefined) delete process.env[pathKey]; else process.env[pathKey] = oldPath; });
  const scope = new ObservedScope(), service = new CopilotControlService({ scope }); t.after(() => service.stop());
  const reply = await service.install(); assert.deepEqual(JSON.parse(reply.stdout!), ["install", "-g", "@github/copilot"]);
  assert.equal(reply.stderr, "packaged Node fixture"); assert.equal(scope.launched[0]!.spawnfile, executable); assert.equal(scope.closed.has(scope.launched[0]!), true);
});

test("stopping during npm discovery prevents a late child from being created", async t => {
  const fixture = await fakeNpm(t, "throw new Error('This controlled CLI must never start');");
  const scope = new ObservedScope(), service = new CopilotControlService({ scope }); t.after(() => service.stop());
  const original = fs.statSync;
  t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
    const value = Reflect.apply(original, fs, args);
    if (String(args[0]) === fixture.filename) void scope.stop();
    return value;
  });
  await assert.rejects(service.install(), /stopping/); assert.equal(scope.launched.length, 0);
});

test("stop joins a default real npm child and prevents subsequent install creation", { timeout: 10000 }, async t => {
  await fakeNpm(t, "setInterval(()=>{},1000);");
  let tracked!: (child: ChildProcess) => void;
  const started = new Promise<ChildProcess>(resolve => { tracked = resolve; });
  const scope = new ObservedScope(tracked), service = new CopilotControlService({ scope }); t.after(() => service.stop());
  const pending = service.install().catch(error => error), child = await started;
  await service.stop(); assert.equal(scope.closed.has(child), true); await pending;
  await assert.rejects(service.install(), /stopping/); assert.equal(scope.launched.length, 1);
});

test("an injected launch rejected during retirement still joins its original real child close", { timeout: 10000 }, async t => {
  let closed = false;
  const scope = new AgentProviderProcessScope(), service = new CopilotControlService({ scope, execInstall: callback => {
    void scope.stop();
    const child = execFile(process.execPath, ["-e", "setInterval(()=>{},1000)"], { shell: false, windowsHide: true }, callback);
    child.once("close", () => { closed = true; }); return child;
  } }); t.after(() => service.stop());
  await assert.rejects(service.install(), /stopping/); assert.equal(closed, true);
});

test("an authenticated remote HTTP request retains default install success through the real fake CLI", { timeout: 10000 }, async t => {
  await fakeNpm(t, "process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write('http fixture');");
  const scope = new ObservedScope(), service = new CopilotControlService({ scope }), registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("controlled-copilot", createCopilotControlOperations({ installCopilot: () => service.install(),
    startCopilotLogin: async () => ({ kind: "failed", error: "not invoked" }), getCopilotStatus: async () => ({}), publishEvent: () => {} }));
  const server = http.createServer((request, response) => {
    Object.defineProperty(request.socket, "remoteAddress", { value: "192.0.2.25", configurable: true });
    markAuthenticatedConnectionRequest(request, () => {});
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await service.stop(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/agent/copilot-install`, { method: "POST" });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.ok, true);
  assert.deepEqual(JSON.parse(body.stdout), ["install", "-g", "@github/copilot"]); assert.equal(body.stderr, "http fixture");
  assert.equal(scope.closed.has(scope.launched[0]!), true);
});
