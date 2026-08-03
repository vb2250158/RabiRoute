import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock manager did not bind a TCP port");
  return address.port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function runPowerShell(scriptPath, args) {
  const executable = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const child = spawn(executable, [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    ...args
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, stdout, stderr };
}

test("watchdog reports an isolated NapCat failure as degraded, not a system error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-watchdog-"));
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  const source = fileURLToPath(new URL("./watch-rabiroute-health.ps1", import.meta.url));
  const script = path.join(scriptsDir, "watch-rabiroute-health.ps1");
  fs.copyFileSync(source, script);
  const routeDir = path.join(root, "data", "route", "route");
  const adapterConfigPath = path.join(routeDir, "adapterConfig.json");
  fs.mkdirSync(routeDir, { recursive: true });
  const adapterConfig = `${JSON.stringify({
    ignoredNapcatInstanceIds: ["id:qq", "unrelated-entry"]
  }, null, 2)}\n`;
  fs.writeFileSync(adapterConfigPath, adapterConfig, "utf8");

  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/meta") {
      response.end(JSON.stringify({ version: "watchdog-test" }));
      return;
    }
    if (request.url === "/gateways") {
      response.end(JSON.stringify({
        data: {
          manager: [{
            id: "route",
            enabled: true,
            running: true,
            messageAdapters: ["napcat"],
            napcatInstances: [{
              id: "qq",
              enabled: true,
              gatewayPort: 8789,
              httpUrl: "http://127.0.0.1:3001",
              webuiUrl: "http://127.0.0.1:6099/webui"
            }],
            agentAdapters: [],
            gatewayStatus: {}
          }]
        }
      }));
      return;
    }
    if (request.url === "/api/message/napcat-health") {
      response.end(JSON.stringify({
        ok: false,
        state: "manual-login",
        message: "mock QQ login is absent",
        http: { ok: false, message: "mock OneBot unavailable" },
        webui: { reachable: true, loginInfo: null }
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });

  const port = await listen(server);
  try {
    const result = await runPowerShell(script, [
      "-ManagerUrl", `http://127.0.0.1:${port}`,
      "-DefaultRouteName", "watchdog-test",
      "-Once",
      "-NoRepair",
      "-NoTrayRepair"
    ]);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);

    const jsonl = path.join(root, "data", "route", "watchdog-test", "logs", "rabiroute-health-watch.jsonl");
    const records = fs.readFileSync(jsonl, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const latest = records.at(-1);
    assert.equal(latest.status, "degraded");
    assert.equal(latest.systemErrorCount, 0);
    assert.ok(latest.adapterErrorCount >= 1);
    const napcatIssues = latest.issues.filter((issue) => issue.adapter === "napcat");
    assert.ok(napcatIssues.length >= 1);
    assert.ok(napcatIssues.every((issue) => issue.impact === "adapter"));
    assert.equal(fs.readFileSync(adapterConfigPath, "utf8"), adapterConfig);
    assert.deepEqual(
      fs.readdirSync(routeDir).filter((name) => name.includes(".bak-")),
      []
    );
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("watchdog retries a transient Manager probe failure before considering recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-watchdog-manager-"));
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  const source = fileURLToPath(new URL("./watch-rabiroute-health.ps1", import.meta.url));
  const script = path.join(scriptsDir, "watch-rabiroute-health.ps1");
  fs.copyFileSync(source, script);
  let metaRequests = 0;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/meta") {
      metaRequests += 1;
      if (metaRequests === 1) {
        response.statusCode = 503;
        response.end(JSON.stringify({ message: "temporary probe failure" }));
      } else {
        response.end(JSON.stringify({ version: "watchdog-test" }));
      }
      return;
    }
    if (request.url === "/gateways") {
      response.end(JSON.stringify({ data: { manager: [] } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });

  const port = await listen(server);
  try {
    const result = await runPowerShell(script, [
      "-ManagerUrl", `http://127.0.0.1:${port}`,
      "-DefaultRouteName", "watchdog-test",
      "-ManagerProbeAttempts", "2",
      "-ManagerProbeRetryDelayMilliseconds", "10",
      "-Once",
      "-NoTrayRepair"
    ]);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(metaRequests >= 2, true);
    const jsonl = path.join(root, "data", "route", "watchdog-test", "logs", "rabiroute-health-watch.jsonl");
    const latest = JSON.parse(fs.readFileSync(jsonl, "utf8").trim().split(/\r?\n/).at(-1));
    assert.equal(["ok", "warning"].includes(latest.status), true);
    assert.equal(latest.systemErrorCount, 0);
    assert.deepEqual(latest.issues.filter((issue) => issue.scope === "manager"), []);
    assert.equal(latest.managerProbe.attempts, 2);
    assert.equal(latest.managerProbe.transientFailure, true);
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
