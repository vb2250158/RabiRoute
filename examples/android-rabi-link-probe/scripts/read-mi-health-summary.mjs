#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const modulePath = join(scriptDir, "MiHealthProbe.psm1");
const schemaPath = join(scriptDir, "..", "schemas", "mi-health-summary.schema.json");

function parseArgs(argv) {
  const options = {
    serial: "",
    includeHealthConnect: false,
    includeSleepHistorySearch: false,
    includeProviderCategoryScan: false,
    depth: 8,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--serial") {
      options.serial = argv[++index] ?? options.serial;
    } else if (arg === "--include-health-connect") {
      options.includeHealthConnect = true;
    } else if (arg === "--include-sleep-history") {
      options.includeSleepHistorySearch = true;
    } else if (arg === "--include-provider-categories") {
      options.includeProviderCategoryScan = true;
    } else if (arg === "--depth") {
      options.depth = Number.parseInt(argv[++index] ?? `${options.depth}`, 10);
    } else if (arg === "--schema") {
      options.schema = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/read-mi-health-summary.mjs [options]

Options:
  --serial <adb-serial>                 ADB 设备序列号，默认自动选择唯一已连接设备
  --include-health-connect              触发 Health Connect 后台读取
  --include-sleep-history               扫描 sleep/report 和 sleep/record 历史
  --include-provider-categories         扫描常见 Provider 分类
  --depth <number>                      PowerShell ConvertTo-Json 深度，默认 8
  --schema                              输出摘要 JSON Schema 路径
`);
}

function quotePowerShellString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildPowerShellCommand(options) {
  const args = [
    `-Serial ${quotePowerShellString(options.serial)}`,
    options.includeHealthConnect ? "" : "-SkipHealthConnect",
    options.includeSleepHistorySearch ? "-IncludeSleepHistorySearch" : "",
    options.includeProviderCategoryScan ? "-IncludeProviderCategoryScan" : "",
  ].filter(Boolean);

  return [
    "$ErrorActionPreference = 'Stop'",
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
    `Import-Module ${quotePowerShellString(modulePath)} -Force`,
    `Get-MiHealthSummary ${args.join(" ")} | ConvertTo-Json -Depth ${options.depth}`,
  ].join("; ");
}

function runPowerShell(command) {
  const executable = process.env.PWSH_PATH || "pwsh";
  const child = spawn(executable, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`PowerShell 退出码 ${code}\n${stderr || stdout}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

if (options.schema) {
  console.log(schemaPath);
  process.exit(0);
}

const output = await runPowerShell(buildPowerShellCommand(options));
JSON.parse(output);
console.log(output);
