import { spawn } from "node:child_process";
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
      "src/plugins/rabi-speech/scripts/start.ps1",
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

if (checkOnly) {
  console.log("Hot reload configuration accepted; services report their listening addresses at startup.");
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
  console.log(`${service.name} hot reload starting; its process will report the listening address.`);
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
