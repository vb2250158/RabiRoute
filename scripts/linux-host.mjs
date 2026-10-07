#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { LinuxHost, HOST_NAMESPACE, descriptorPath, sendHostCommand } from "./lib/linux-host-runtime.mjs";

const script = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(script), "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseArguments(args) {
  const options = { command: "start", packageRoot: defaultRoot, stateRoot: "", readOnly: false, autostart: true, json: false, foreground: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--read-only") { options.readOnly = true; options.autostart = false; }
    else if (arg === "--no-autostart") options.autostart = false;
    else if (arg === "--foreground") options.foreground = true;
    else if (arg === "--help" || arg === "-h") options.command = "help";
    else if (["--command", "--state-root", "--package-root"].includes(arg)) {
      const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      options[arg === "--command" ? "command" : arg === "--state-root" ? "stateRoot" : "packageRoot"] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.command === "stop") options.command = "quit";
  if (!["start", "status", "open", "restart", "quit", "help"].includes(options.command)) throw new Error("Unknown Linux Host command.");
  for (const name of ["packageRoot", "stateRoot"]) if (options[name] && !path.isAbsolute(options[name])) throw new Error(`${name} must be absolute.`);
  options.packageRoot = fs.realpathSync(options.packageRoot);
  options.stateRoot ||= options.packageRoot;
  options.stateRoot = fs.existsSync(options.stateRoot) ? fs.realpathSync(options.stateRoot) : path.resolve(options.stateRoot);
  return options;
}

function print(value, json) {
  if (json) console.log(JSON.stringify(value));
  else {
    console.log(`RabiRoute Linux Host: ${value.state}`);
    if (value.managerBaseUrl) console.log(`WebGUI: ${value.managerBaseUrl}`);
    if (value.readOnly) console.log("Read-only mode; configuration writes and automatic integrations are disabled.");
    if (value.message) console.log(value.message);
    if (value.logs) console.log(`Log: ${value.logs}`);
  }
}

function assertRequestedMode(status, options) {
  if (options.readOnly && status.readOnly !== true) throw new Error("A writable Host is already running. Stop it before requesting read-only mode.");
  if (!options.autostart && status.autostart !== false) throw new Error("Automatic integrations are enabled on the existing Host. Stop it before requesting --no-autostart.");
  if (status.stateRoot !== options.stateRoot || status.packageRoot !== options.packageRoot) {
    throw new Error("A Host for another package/state root is already running. Stop that Host before switching roots.");
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    console.log("Usage: node scripts/linux-host.mjs [--command start|status|open|restart|quit] [--json] [--foreground] [--read-only] [--no-autostart] [--state-root /absolute/path]"); return;
  }
  if (process.platform !== "linux") throw new Error("This Host requires Linux. Windows startup is unchanged.");
  const leaseModule = path.join(options.packageRoot, "dist", "linuxProcessLease.js");
  if (!fs.existsSync(leaseModule)) throw new Error("Linux Host build is missing. Run npm ci and npm run build first.");
  const { acquireLinuxProcessLease, linuxProcessLeasePaths } = await import(pathToFileURL(leaseModule).href);
  const file = descriptorPath(linuxProcessLeasePaths(HOST_NAMESPACE).leasePath);
  if (options.command !== "start") {
    const status = await sendHostCommand(file, "status");
    if (options.command === "status") { print(status, options.json); if (!status.ok) process.exitCode = 1; return; }
    if (options.command === "open") {
      if (!status.ok || !["healthy", "degraded"].includes(status.state) || !status.managerBaseUrl) throw new Error("Manager is not ready to open.");
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { print(status, options.json); return; }
      await new Promise((resolve, reject) => { const child = spawn("xdg-open", [status.managerBaseUrl], { stdio: "ignore" }); child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("xdg-open failed; open the printed WebGUI URL manually."))); });
      print(status, options.json); return;
    }
    const result = await sendHostCommand(file, options.command, status.applicationGenerationId);
    print(result, options.json); if (!result.ok) process.exitCode = 1; return;
  }
  try {
    const status = await sendHostCommand(file, "status");
    assertRequestedMode(status, options);
    print(status, options.json); if (!status.ok) process.exitCode = 1; return;
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code)) throw error;
  }
  fs.mkdirSync(options.stateRoot, { recursive: true });
  options.stateRoot = fs.realpathSync(options.stateRoot);
  const logs = path.join(options.stateRoot, "logs", "linux-host");
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const logPath = path.join(logs, "host.log");
  if (!options.foreground) {
    const fd = fs.openSync(logPath, "a", 0o600);
    const args = [script, "--foreground", "--package-root", options.packageRoot, "--state-root", options.stateRoot];
    if (options.readOnly) args.push("--read-only");
    else if (!options.autostart) args.push("--no-autostart");
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    fs.closeSync(fd); child.unref();
    let failure;
    const deadline = Date.now() + 125000;
    while (Date.now() < deadline) {
      try {
        const status = await sendHostCommand(file, "status");
        if (["healthy", "degraded", "faulted"].includes(status.state)) { assertRequestedMode(status, options); print(status, options.json); if (!status.ok) process.exitCode = 1; return; }
      } catch (error) { failure = error; }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Linux Host exited; see ${logPath}`);
      await delay(200);
    }
    throw new Error(`Linux Host startup timed out; see ${logPath}. ${failure?.code ?? ""}`);
  }
  const lease = await acquireLinuxProcessLease({ namespace: HOST_NAMESPACE,
    owner: { pid: process.pid, ownerId: randomUUID(), startedAt: new Date().toISOString(), projectRoot: options.packageRoot } });
  const host = new LinuxHost({ ...options, descriptorFile: descriptorPath(lease.leasePath), logPath, lease });
  const stop = () => void host.close().catch(error => { console.error(error.message); process.exitCode = 1; });
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  process.once("uncaughtException", error => { process.exitCode = 1; console.error(error.message); stop(); });
  try { print(await host.start(), options.json); }
  catch (error) { await host.close(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  main().catch(error => { console.error(`RabiRoute Linux Host: ${error.message}`); process.exitCode = 1; });
}
