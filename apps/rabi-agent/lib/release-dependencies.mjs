import { createTimeoutSettings } from "./timeout-settings.mjs";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolveNpmCli } from "./npm-cli.mjs";

export function dependencyEnvironment(env = process.env, execPath = process.execPath, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const key = Object.keys(env).find(key => key.toLowerCase() === "path") || "PATH";
  return { ...env, [key]: paths.dirname(execPath) + paths.delimiter + (env[key] || "") };
}

export async function verifyNativeTerminal(entrypoint, requireModule = createRequire(entrypoint), timeoutMs = 5000) {
  const pty = requireModule("node-pty");
  await new Promise((resolve, reject) => {
    const terminal = pty.spawn("/bin/sh", ["-c", "exit 0"], { cwd: path.dirname(entrypoint), cols: 80, rows: 24, env: {} });
    const timer = setTimeout(() => { terminal.kill(); reject(new Error("Native terminal readiness timed out.")); }, timeoutMs);
    terminal.onData(() => undefined);
    terminal.onExit(event => { clearTimeout(timer); event.exitCode === 0 ? resolve() : reject(new Error("Native terminal readiness failed.")); });
  });
}

/** Some npm archives omit the executable bit on node-pty's packaged POSIX helper. */
export function restoreNativeTerminalExecutable(entrypoint, { platform = process.platform, arch = process.arch,
  requireModule = createRequire(entrypoint), fsApi = fs } = {}) {
  if (platform === "win32" || typeof requireModule.resolve !== "function") return;
  const packageRoot = path.dirname(requireModule.resolve("node-pty/package.json"));
  const helper = path.join(packageRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper");
  if (!fsApi.existsSync(helper)) return;
  const stat = fsApi.lstatSync(helper);
  if (stat.isFile() && !(stat.mode & 0o100)) fsApi.chmodSync(helper, (stat.mode & 0o777) | 0o100);
}

/** npm may exit successfully after skipping a failed optional native dependency. */
export async function installReleaseDependencies(entrypoint, { timeoutOverrides, timeoutMs, platform = process.platform, env = process.env, execPath = process.execPath, npmCli = resolveNpmCli({ execPath, env, platform }), spawnChild = spawn, requireModule = createRequire(entrypoint) } = {}) {
  const timeouts = createTimeoutSettings(timeoutOverrides);
  timeoutMs ??= timeouts.get("agent.dependencies.install",120000);
  await new Promise((resolve, reject) => {
    const installer = spawnChild(execPath, [npmCli, "install", "--omit=dev", "--include=optional", "--no-audit", "--no-fund"], {
      cwd: path.dirname(entrypoint), windowsHide: true, stdio: "ignore", env: dependencyEnvironment(env, execPath, platform)
    });
    const timer = setTimeout(() => { installer.kill(); reject(new Error("Instance dependency installation timed out; the current version remains active.")); }, timeoutMs);
    installer.once("error", error => { clearTimeout(timer); reject(error); });
    installer.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Instance dependency installation failed; the current version remains active.")); });
  });
  if (platform !== "win32") {
    try {
      restoreNativeTerminalExecutable(entrypoint, { platform, requireModule });
      await verifyNativeTerminal(entrypoint, requireModule, timeouts.get("agent.dependencies.verify",5000));
    }
    catch { throw new Error("POSIX terminal dependency node-pty did not load; the candidate cannot replace the current connector. Check Node and Xcode/build tools."); }
  }
}

/** Also repairs candidates downloaded by older updaters before acknowledging readiness. */
export async function ensureNativeTerminalDependencies(entrypoint, options = {}) {
  if ((options.platform || process.platform) === "win32") return;
  try {
    restoreNativeTerminalExecutable(entrypoint, options);
    await verifyNativeTerminal(entrypoint, options.requireModule, createTimeoutSettings(options.timeoutOverrides).get("agent.dependencies.verify",5000)); return;
  }
  catch { /* A prior updater may have silently omitted this optional dependency. */ }
  await installReleaseDependencies(entrypoint, { ...options, timeoutMs: options.timeoutMs ?? createTimeoutSettings(options.timeoutOverrides).get("agent.dependencies.repair",20000) });
}
