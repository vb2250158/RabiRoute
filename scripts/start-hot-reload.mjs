import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const describeOnly = process.argv.includes("--describe");
if (process.argv.includes("--manager")) {
  console.error(
    "Safe hot reload does not restart Manager. Manager owns Route child processes, "
    + "so watching it would bounce NapCat, RabiLink and personal Weixin sessions. "
    + "Use manager:dev:isolated only in an isolated test data directory."
  );
  process.exit(2);
}

const services = [
  {
    name: "WebGUI",
    port: 8793,
    command: process.execPath,
    args: [
      "node_modules/vite/bin/vite.js",
      "--config",
      "ribiwebgui/vite.config.ts",
      "--host",
      "127.0.0.1"
    ]
  }
];

if (process.argv.includes("--speech")) {
  services.push({
    name: "RabiSpeech",
    port: 8781,
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "plugin-adapters/rabi-speech/scripts/start.ps1",
      "-Reload"
    ]
  });
}

if (describeOnly) {
  console.log(JSON.stringify({
    services: services.map(({ name, port }) => ({ name, port })),
    managerHotReload: false,
    managerReason: "Manager owns long-lived Route adapters and is isolated from the safe hot-reload loop."
  }));
  process.exit(0);
}

function portInUse(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error?.code === "ECONNREFUSED") {
        resolve(false);
        return;
      }
      reject(error);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const occupied = [];
for (const service of services) {
  if (await portInUse(service.port)) {
    occupied.push(`${service.name}:${service.port}`);
  }
}

if (occupied.length > 0) {
  console.error(
    `Cannot start hot reload because these ports are already in use: ${occupied.join(", ")}. `
    + "Stop only the corresponding installed services, then run this command again."
  );
  process.exit(2);
}

if (checkOnly) {
  console.log(`Hot reload preflight passed: ${services.map(({ port }) => port).join(", ")} available.`);
  process.exit(0);
}

const children = services.map((service) => {
  const child = spawn(service.command, service.args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${service.name} stopped unexpectedly (code=${code}, signal=${signal || "none"}).`);
      stopAll(code || 1);
    }
  });
  console.log(`${service.name} hot reload started on http://127.0.0.1:${service.port}`);
  return child;
});

let stopping = false;
function stopAll(exitCode = 0) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  setTimeout(() => process.exit(exitCode), 250);
}

process.once("SIGINT", () => stopAll(0));
process.once("SIGTERM", () => stopAll(0));
