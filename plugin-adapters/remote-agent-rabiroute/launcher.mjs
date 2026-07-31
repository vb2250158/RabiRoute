import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.RABIROUTE_REMOTE_AGENT_PACKAGE_ROOT
  ? path.resolve(process.env.RABIROUTE_REMOTE_AGENT_PACKAGE_ROOT)
  : path.resolve(appDir, "..");
const hostEntrypoint = path.join(appDir, "dist", "remoteAgentHost.js");
const userDataDir = path.join(process.env.LOCALAPPDATA || os.homedir(), "RabiRoute", "RemoteAgent");
const configPath = process.env.RABIROUTE_REMOTE_AGENT_HOST_CONFIG
  ? path.resolve(process.env.RABIROUTE_REMOTE_AGENT_HOST_CONFIG)
  : path.join(userDataDir, "config.json");
const logDir = path.join(userDataDir, "logs");

function readPort() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const port = Number(config.port);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  } catch {
    // First launch uses the Host's stable default.
  }
  return 8797;
}

function parseArgs(argv) {
  const known = new Set(["--check", "--smoke-test", "--no-browser", "--configure", "--help", "-h"]);
  for (const arg of argv) {
    if (!known.has(arg)) throw new Error(`未知参数：${arg}`);
  }
  return {
    check: argv.includes("--check"),
    smokeTest: argv.includes("--smoke-test"),
    noBrowser: argv.includes("--no-browser") || argv.includes("--smoke-test"),
    help: argv.includes("--help") || argv.includes("-h")
  };
}

function verifyRuntime() {
  for (const required of [process.execPath, hostEntrypoint, path.join(appDir, "ribiwebgui", "dist", "index.html")]) {
    if (!fs.existsSync(required)) throw new Error(`发布包文件缺失：${required}`);
  }
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(port, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await health(port)) return;
    if (child.exitCode != null) throw new Error(`Remote Agent Host 提前退出，exitCode=${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Remote Agent Host 启动超时，请查看 ${logDir}`);
}

function openBrowser(port) {
  const url = `http://127.0.0.1:${port}/#/remote-agent`;
  const child = spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function startHost() {
  fs.mkdirSync(logDir, { recursive: true });
  const stdout = fs.openSync(path.join(logDir, "host.log"), "a");
  const stderr = fs.openSync(path.join(logDir, "host-error.log"), "a");
  return spawn(process.execPath, [hostEntrypoint], {
    cwd: appDir,
    env: {
      ...process.env,
      RABIROUTE_REMOTE_AGENT_HOST_CONFIG: configPath
    },
    stdio: ["ignore", stdout, stderr],
    windowsHide: true
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("RabiRoute Remote Agent\n\n双击直接启动；配置只在 WebGUI 中完成。\n--check 检查发布包；--smoke-test 执行监听烟测；--no-browser 不自动打开浏览器。");
    return 0;
  }
  verifyRuntime();
  if (options.check) return 0;

  const port = readPort();
  if (await health(port)) {
    if (!options.noBrowser) openBrowser(port);
    return 0;
  }

  const child = startHost();
  await waitForHealth(port, child);
  if (!options.noBrowser) openBrowser(port);
  if (options.smokeTest) {
    child.kill();
    return 0;
  }
  return await new Promise(resolve => {
    child.once("exit", code => resolve(code ?? 1));
  });
}

const isEntrypoint = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  main()
    .then(code => { process.exitCode = Number.isInteger(code) ? code : 0; })
    .catch(error => {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, "launcher-error.log"), `${new Date().toISOString()} ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
