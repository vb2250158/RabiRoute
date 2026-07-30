import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bridgeEnvironment,
  createDefaultConfig,
  defaultConfigPath,
  readConfig,
  writeConfig
} from "./launcher-config.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.RABIROUTE_REMOTE_AGENT_PACKAGE_ROOT
  ? path.resolve(process.env.RABIROUTE_REMOTE_AGENT_PACKAGE_ROOT)
  : path.resolve(appDir, "..");
const bridgeEntrypoint = path.join(appDir, "index.mjs");
const codexEntrypoint = path.join(appDir, "node_modules", "@openai", "codex", "bin", "codex.js");
const configPath = process.env.RABIROUTE_REMOTE_AGENT_CONFIG || defaultConfigPath();

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  verifyPackagedRuntime();
  let config;
  if (options.configure || !fs.existsSync(configPath)) {
    if (options.nonInteractive) {
      throw new Error(`配置不存在：${configPath}。请先运行 RabiRoute-Remote-Agent.exe --configure。`);
    }
    config = await configureInteractively(configPath);
  } else {
    config = readConfig(configPath);
  }

  if (options.showConfig) {
    printConfig(config, options.printPassword);
    return 0;
  }

  if (options.check) {
    checkCodexRuntime(config);
    console.log("远端 Agent 发布包检查通过。");
    return 0;
  }

  if (!options.skipLoginCheck) {
    await ensureCodexLogin(config, options.nonInteractive);
  }

  printConfig(config, true);
  if (options.smokeTest) {
    return runBridgeSmokeTest(config);
  }
  return runBridge(config);
}

function parseArgs(argv) {
  const known = new Set([
    "--configure",
    "--show-config",
    "--print-password",
    "--check",
    "--smoke-test",
    "--non-interactive",
    "--skip-login-check",
    "--help",
    "-h"
  ]);
  for (const arg of argv) {
    if (!known.has(arg)) throw new Error(`未知参数：${arg}`);
  }
  return {
    configure: argv.includes("--configure"),
    showConfig: argv.includes("--show-config") || argv.includes("--print-password"),
    printPassword: argv.includes("--print-password"),
    check: argv.includes("--check"),
    smokeTest: argv.includes("--smoke-test"),
    nonInteractive: argv.includes("--non-interactive"),
    skipLoginCheck: argv.includes("--skip-login-check"),
    help: argv.includes("--help") || argv.includes("-h")
  };
}

function verifyPackagedRuntime() {
  for (const required of [process.execPath, bridgeEntrypoint, codexEntrypoint]) {
    if (!fs.existsSync(required)) throw new Error(`发布包文件缺失：${required}`);
  }
}

async function configureInteractively(targetPath) {
  console.log("RabiRoute Remote Agent 首次设置");
  console.log("请选择这台远端机器上允许 Agent 工作的项目目录。");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    let config;
    while (!config) {
      const cwdInput = (await rl.question("项目目录（必填）: ")).trim().replace(/^"(.*)"$/, "$1");
      try {
        const deviceInput = (await rl.question(`设备名称 [${os.hostname()}]: `)).trim();
        config = createDefaultConfig({
          defaultCwd: cwdInput,
          deviceName: deviceInput || os.hostname()
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
    const saved = writeConfig(targetPath, config);
    console.log(`配置已保存到：${targetPath}`);
    console.log("该文件包含设备密码，只保存在当前 Windows 用户的本机配置目录，不会进入发布包。");
    return saved;
  } finally {
    rl.close();
  }
}

function checkCodexRuntime(config) {
  const result = spawnSync(process.execPath, [codexEntrypoint, "--version"], {
    cwd: config.defaultCwd,
    env: codexCommandEnvironment(config),
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`内置 Codex Runtime 无法运行：${(result.stderr || result.stdout || "").trim()}`);
  }
  console.log((result.stdout || result.stderr || "").trim());
}

async function ensureCodexLogin(config, nonInteractive) {
  const status = spawnSync(process.execPath, [codexEntrypoint, "login", "status"], {
    cwd: config.defaultCwd,
    env: codexCommandEnvironment(config),
    encoding: "utf8",
    windowsHide: true
  });
  if (status.status === 0) {
    console.log((status.stdout || status.stderr || "Codex 已登录。").trim());
    return;
  }
  const detail = (status.stderr || status.stdout || "Codex 尚未登录。").trim();
  if (nonInteractive) throw new Error(detail);
  console.warn(detail);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("现在启动 Codex 登录？[Y/n]: ")).trim().toLowerCase();
    if (answer && answer !== "y" && answer !== "yes") {
      throw new Error("Codex 未登录，远端 Agent 未启动。");
    }
  } finally {
    rl.close();
  }
  const login = spawnSync(process.execPath, [codexEntrypoint, "login"], {
    cwd: config.defaultCwd,
    env: codexCommandEnvironment(config),
    stdio: "inherit",
    windowsHide: false
  });
  if (login.status !== 0) throw new Error("Codex 登录未完成，远端 Agent 未启动。");
}

function codexCommandEnvironment(config) {
  const env = bridgeEnvironment(config);
  delete env.REMOTE_AGENT_PASSWORD;
  delete env.RABIROUTE_REMOTE_AGENT_CONFIG;
  return env;
}

function printConfig(config, includePassword) {
  console.log("");
  console.log(`设备名称：${config.deviceName}`);
  console.log(`项目目录：${config.defaultCwd}`);
  console.log(`网络权限：${config.allowNetwork ? "已开启" : "关闭（默认）"}`);
  console.log(`设备密码：${includePassword ? config.password : "（使用 --print-password 查看）"}`);
  console.log("在主控电脑 RabiGUI 中扫描远端 Agent，并输入上面的设备密码。");
  console.log("");
}

function runBridge(config) {
  const child = spawn(process.execPath, [bridgeEntrypoint], {
    cwd: config.defaultCwd,
    env: bridgeEnvironment(config),
    stdio: "inherit",
    windowsHide: false
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) resolve(1);
      else resolve(code ?? 1);
    });
  });
}

function runBridgeSmokeTest(config) {
  const env = bridgeEnvironment(config, {
    ...process.env,
    REMOTE_AGENT_CONTROL_HOST: "127.0.0.1",
    REMOTE_AGENT_CONTROL_PORT: process.env.REMOTE_AGENT_CONTROL_PORT || "19797",
    REMOTE_AGENT_DISCOVERY_PORT_START: process.env.REMOTE_AGENT_DISCOVERY_PORT_START || "19798",
    REMOTE_AGENT_DISCOVERY_PORT_END: process.env.REMOTE_AGENT_DISCOVERY_PORT_END || "19818"
  });
  const child = spawn(process.execPath, [bridgeEntrypoint], {
    cwd: config.defaultCwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`bridge 启动超时：${output.trim()}`)), 15_000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      if (error) reject(error);
      else {
        console.log("远端 Agent bridge 监听烟测通过。");
        resolve(0);
      }
    };
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("Remote Agent control listening on ")) finish();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", finish);
    child.once("exit", (code) => {
      if (!output.includes("Remote Agent control listening on ")) {
        finish(new Error(`bridge 提前退出（code=${String(code)}）：${output.trim()}`));
      }
    });
  });
}

function printHelp() {
  console.log(`RabiRoute Remote Agent

用法：
  RabiRoute-Remote-Agent.exe
  RabiRoute-Remote-Agent.exe --configure
  RabiRoute-Remote-Agent.exe --show-config
  RabiRoute-Remote-Agent.exe --print-password
  RabiRoute-Remote-Agent.exe --check

选项：
  --configure          重新选择项目目录并生成新的设备密码
  --show-config        显示配置（隐藏密码）
  --print-password     显示设备密码
  --check              检查内置 Node/Codex Runtime，不启动 bridge
  --non-interactive    缺配置或登录态时直接失败
  --skip-login-check   跳过 Codex 登录检查（仅限受控自动化）
`);
}

const isEntrypoint = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  main()
    .then((code) => {
      process.exitCode = Number.isInteger(code) ? code : 0;
    })
    .catch((error) => {
      console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
