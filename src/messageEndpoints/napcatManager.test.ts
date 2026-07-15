import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureNapcatInstanceReady, resolveNapcatLaunchPlan } from "./napcatManager.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function createOuterShellFixture(): { root: string; shellDir: string; launcher: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-"));
  const shellDir = path.join(root, "NapCat.44498.Shell");
  const innerDir = path.join(shellDir, "versions", "9.9.26-44498", "resources", "app", "napcat");
  fs.mkdirSync(innerDir, { recursive: true });
  fs.writeFileSync(path.join(shellDir, "napcat.bat"), "@echo off\r\nNapCatWinBootMain.exe\r\n", "utf8");
  fs.writeFileSync(path.join(shellDir, "NapCatWinBootMain.exe"), "", "utf8");
  const launcher = path.join(innerDir, "launcher-user.bat");
  fs.writeFileSync(launcher, "@echo off\r\n", "utf8");
  return { root, shellDir, launcher };
}

test("NapCat launch plan redirects outer Shell to inner launcher with bot quick login", () => {
  const fixture = createOuterShellFixture();
  try {
    const plan = resolveNapcatLaunchPlan({
      id: "bot",
      name: "QQ bot",
      gatewayPort: 8789,
      httpUrl: "http://127.0.0.1:3001",
      webuiUrl: "http://127.0.0.1:6099/webui",
      launchCommand: "napcat.bat",
      workingDir: fixture.shellDir,
      botUserId: "10000"
    }, fixture.root);

    assert.equal(plan.redirectedFromOuterShell, true);
    assert.equal(plan.commandPath, fixture.launcher);
    assert.deepEqual(plan.args, ["-q", "10000"]);
    assert.match(plan.commandLine, /launcher-user\.bat/);
    assert.match(plan.commandLine, /10000/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("NapCat launch plan keeps existing quick login argument when redirecting", () => {
  const fixture = createOuterShellFixture();
  try {
    const plan = resolveNapcatLaunchPlan({
      id: "bot",
      gatewayPort: 8789,
      httpUrl: "http://127.0.0.1:3001",
      launchCommand: "napcat.bat -q 10000",
      workingDir: fixture.shellDir,
      botUserId: "10000"
    }, fixture.root);

    assert.equal(plan.commandPath, fixture.launcher);
    assert.deepEqual(plan.args, ["-q", "10000"]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ensure ready automatically quick-logs the bound QQ and waits for OneBot", async () => {
  let ready = false;
  let quickLoginCount = 0;
  const onebot = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request body */ }
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("connection", "close");
    if (!ready) {
      response.statusCode = 502;
      response.end(JSON.stringify({ status: "failed", retcode: 1400 }));
      return;
    }
    if (request.url === "/get_status") {
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { online: true, good: true } }));
      return;
    }
    response.end(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 10000, nickname: "Bot" } }));
  });
  const webui = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request body */ }
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("connection", "close");
    if (request.url === "/api/auth/login") {
      response.end(JSON.stringify({ code: 0, data: { Credential: "credential" } }));
      return;
    }
    if (request.url === "/api/QQLogin/GetQQLoginInfo") {
      response.end(JSON.stringify({ code: 0, data: ready ? { uin: "10000", nick: "Bot", online: true } : {} }));
      return;
    }
    if (request.url === "/api/QQLogin/CheckLoginStatus") {
      response.end(JSON.stringify({ code: 0, data: { isLogin: ready, loginError: "" } }));
      return;
    }
    if (request.url === "/api/QQLogin/GetQuickLoginListNew") {
      response.end(JSON.stringify({ code: 0, data: [{ uin: "10000", nickName: "Bot", isQuickLogin: true }] }));
      return;
    }
    if (request.url === "/api/QQLogin/SetQuickLogin") {
      quickLoginCount += 1;
      ready = true;
      response.end(JSON.stringify({ code: 0, data: null }));
      return;
    }
    response.end("{}");
  });
  const onebotPort = await listen(onebot);
  const webuiPort = await listen(webui);
  const instance = {
    id: "bot",
    name: "QQ bot",
    gatewayPort: 8789,
    httpUrl: `http://127.0.0.1:${onebotPort}`,
    webuiUrl: `http://127.0.0.1:${webuiPort}/webui`,
    webuiToken: "secret",
    launchCommand: "unused.exe",
    botUserId: "10000"
  };
  const runtime = { definition: { id: "route", gatewayPort: 8789, napcatInstances: [instance] } };
  try {
    const result = await ensureNapcatInstanceReady({
      rootDir: process.cwd(),
      getRuntimes: () => [runtime],
      normalizeNapCatInstances: () => [instance],
      appendLog: () => undefined,
      checkHttpEndpoint: async (url) => url === instance.webuiUrl
    }, { gatewayId: "route", instanceId: "bot" });

    assert.equal(result.ok, true);
    assert.equal(result.state, "ready");
    assert.equal(quickLoginCount, 1);
    assert.match(String(result.openUrl), /token=secret/);
  } finally {
    await Promise.all([close(onebot), close(webui)]);
  }
});
