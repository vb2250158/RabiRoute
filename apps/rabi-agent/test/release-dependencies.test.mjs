import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { dependencyEnvironment, installReleaseDependencies, ensureNativeTerminalDependencies, restoreNativeTerminalExecutable } from "../lib/release-dependencies.mjs";

test("dependency scripts inherit current Node on PATH without modifying owner environment", () => {
  const env = { Path: "C:\\Windows", OTHER: "preserved" };
  assert.deepEqual(dependencyEnvironment(env, "C:\\Node\\node.exe", "win32"), { Path: "C:\\Node;C:\\Windows", OTHER: "preserved" });
  assert.deepEqual(env, { Path: "C:\\Windows", OTHER: "preserved" });
  assert.equal(dependencyEnvironment({ PATH: "/usr/bin" }, "/node/bin/node", "darwin").PATH, "/node/bin:/usr/bin");
});

function installer(onSpawn) {
  return (...args) => {
    onSpawn?.(...args);
    const child = new EventEmitter(); child.kill = () => undefined;
    queueMicrotask(() => child.emit("exit", 0)); return child;
  };
}
const nativePty = () => ({ spawn: () => ({ onData() {}, onExit(callback) { queueMicrotask(() => callback({ exitCode: 0 })); }, kill() {} }) });
const options = { platform: "darwin", execPath: "/node/bin/node", npmCli: "/node/lib/node_modules/npm/bin/npm-cli.js", env: { PATH: "/usr/bin" } };

test("successful npm cannot commit a candidate with a silently omitted POSIX dependency", async () => {
  await assert.rejects(installReleaseDependencies("/candidate/rabi-agent.mjs", { ...options, spawnChild: installer((exe, args, spawnOptions) => {
    assert.ok(args.includes("--include=optional"));
    assert.equal(spawnOptions.env.PATH, "/node/bin:/usr/bin");
  }), requireModule() { throw new Error("MODULE_NOT_FOUND"); } }), /node-pty did not load/);
});

test("candidate from an older updater repairs missing native dependency before becoming ready", async () => {
  let installed = false;
  await ensureNativeTerminalDependencies("/candidate/rabi-agent.mjs", { ...options, spawnChild: installer(() => { installed = true; }), requireModule() { if (!installed) throw new Error("missing"); return nativePty(); } });
  assert.equal(installed, true);
});

test("existing working native terminal and Windows startup do not reinstall dependencies", async () => {
  const spawnChild = () => { throw new Error("Unexpected install"); };
  await ensureNativeTerminalDependencies("/candidate/rabi-agent.mjs", { ...options, spawnChild, requireModule: nativePty });
  await ensureNativeTerminalDependencies("/candidate/rabi-agent.mjs", { platform: "win32", spawnChild });
});

test("POSIX preparation restores only the packaged helper owner execute bit", () => {
  const packageRoot = path.join("fixture", "node_modules", "node-pty");
  const helper = path.join(packageRoot, "prebuilds", "darwin-arm64", "spawn-helper");
  const requireModule = Object.assign(() => undefined, { resolve: () => path.join(packageRoot, "package.json") });
  let mode = 0o644; const changed = [];
  const fsApi = {
    existsSync: target => { assert.equal(target, helper); return true; },
    lstatSync: () => ({ isFile: () => true, mode }),
    chmodSync: (target, next) => { changed.push({ target, next }); mode = next; }
  };
  const options = { platform: "darwin", arch: "arm64", requireModule, fsApi };
  restoreNativeTerminalExecutable("/candidate/rabi-agent.mjs", options);
  assert.deepEqual(changed, [{ target: helper, next: 0o744 }]);
  restoreNativeTerminalExecutable("/candidate/rabi-agent.mjs", options);
  assert.equal(changed.length, 1);
  restoreNativeTerminalExecutable("/candidate/rabi-agent.mjs", { ...options, platform: "win32" });
  restoreNativeTerminalExecutable("/candidate/rabi-agent.mjs", { ...options, fsApi: { ...fsApi, lstatSync: () => ({ isFile: () => false, mode: 0o644 }) } });
  assert.equal(changed.length, 1);
});
