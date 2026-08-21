import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  autoLoginNapcatInstancesOnRabiStart,
  ensureNapcatInstanceReady,
  launchNapcatInstance,
  napcatStatusHasUsableConnection,
  resolveNapcatLaunchPlan,
  restartNapcatInstance
} from "./napcatManager.js";

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

test("NapCat scan does not treat a configured bot id as a live OneBot connection", () => {
  assert.equal(napcatStatusHasUsableConnection({
    napcatInstances: {
      qq: { connected: false, botUserId: "10000" }
    }
  }), false);
  assert.equal(napcatStatusHasUsableConnection({
    napcatInstances: {
      qq: { connected: true, online: true, good: true, botUserId: "10000" }
    }
  }), true);
  assert.equal(napcatStatusHasUsableConnection({
    napcat: { connected: true, online: false, botUserId: "10000" }
  }), false);
});

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-quick-login-"));
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
      rootDir: root,
      getRuntimes: () => [runtime],
      normalizeNapCatInstances: () => [instance],
      appendLog: () => undefined,
      checkHttpEndpoint: async (url) => url === instance.webuiUrl
    }, { gatewayId: "route", instanceId: "bot" });

    assert.equal(result.ok, true);
    assert.equal(result.state, "ready");
    assert.equal(quickLoginCount, 1);
    assert.match(String(result.openUrl), /token=secret/);
    const openUrl = new URL(String(result.openUrl));
    assert.equal(openUrl.pathname, "/webui/");
    assert.equal(openUrl.searchParams.get("token"), "secret");
  } finally {
    await Promise.all([close(onebot), close(webui)]);
  }
});

test("ensure ready returns an already healthy OneBot without probing WebUI login", async () => {
  let webuiAuthCount = 0;
  const onebot = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request body */ }
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("connection", "close");
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
    if (request.url === "/api/auth/login") webuiAuthCount += 1;
    response.end(JSON.stringify({ code: 0, data: { Credential: "credential" } }));
  });
  const onebotPort = await listen(onebot);
  const webuiPort = await listen(webui);
  const instance = {
    id: "bot",
    name: "QQ bot",
    gatewayPort: 8789,
    httpUrl: `http://127.0.0.1:${onebotPort}`,
    webuiUrl: `http://127.0.0.1:${webuiPort}/custom-console?theme=dark`,
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
    assert.equal(webuiAuthCount, 0);
    const openUrl = new URL(String(result.openUrl));
    assert.equal(openUrl.pathname, "/custom-console");
    assert.equal(openUrl.searchParams.get("theme"), "dark");
    assert.equal(openUrl.searchParams.get("token"), "secret");
  } finally {
    await Promise.all([close(onebot), close(webui)]);
  }
});

test("ensure ready preserves an already-online QQ owner instead of quick-logging a duplicate instance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-owner-"));
  let quickLoginCount = 0;
  const ownerOneBot = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request body */ }
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("connection", "close");
    if (request.url === "/get_status") {
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { online: true, good: true } }));
      return;
    }
    response.end(JSON.stringify({
      status: "ok",
      retcode: 0,
      data: { user_id: 10000, nickname: "Online Bot" }
    }));
  });
  const targetOneBot = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request body */ }
    response.statusCode = 502;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("connection", "close");
    response.end(JSON.stringify({ status: "failed", retcode: 1400 }));
  });
  const targetWebui = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request body */ }
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("connection", "close");
    if (request.url === "/api/auth/login") {
      response.end(JSON.stringify({ code: 0, data: { Credential: "credential" } }));
      return;
    }
    if (request.url === "/api/QQLogin/GetQQLoginInfo") {
      response.end(JSON.stringify({ code: 0, data: {} }));
      return;
    }
    if (request.url === "/api/QQLogin/CheckLoginStatus") {
      response.end(JSON.stringify({ code: 0, data: { isLogin: false, loginError: "" } }));
      return;
    }
    if (request.url === "/api/QQLogin/GetQuickLoginListNew") {
      response.end(JSON.stringify({
        code: 0,
        data: [{ uin: "10000", nickName: "Bot", isQuickLogin: true }]
      }));
      return;
    }
    if (request.url === "/api/QQLogin/SetQuickLogin") {
      quickLoginCount += 1;
      response.end(JSON.stringify({ code: 0, data: null }));
      return;
    }
    response.end("{}");
  });
  const ownerPort = await listen(ownerOneBot);
  const targetOneBotPort = await listen(targetOneBot);
  const targetWebuiPort = await listen(targetWebui);
  const ownerConfigDir = path.join(root, "data", "napcat", "legacy", "NapCat.Shell", "napcat", "config");
  fs.mkdirSync(ownerConfigDir, { recursive: true });
  fs.writeFileSync(path.join(ownerConfigDir, "webui.json"), JSON.stringify({
    host: "::",
    port: 6100,
    token: "owner-secret"
  }), "utf8");
  fs.writeFileSync(path.join(ownerConfigDir, "onebot11_10000.json"), JSON.stringify({
    network: {
      httpServers: [{
        enable: true,
        host: "127.0.0.1",
        port: ownerPort,
        token: ""
      }],
      websocketClients: [{
        enable: true,
        url: "ws://127.0.0.1:8789"
      }]
    }
  }), "utf8");
  const targetConfigDir = path.join(root, "target", "napcat", "config");
  fs.mkdirSync(targetConfigDir, { recursive: true });
  fs.writeFileSync(path.join(targetConfigDir, "webui.json"), JSON.stringify({
    host: "::",
    port: targetWebuiPort,
    token: "target-secret"
  }), "utf8");
  const instance = {
    id: "target",
    name: "Target Bot",
    gatewayPort: 8789,
    httpUrl: `http://127.0.0.1:${targetOneBotPort}`,
    webuiUrl: `http://127.0.0.1:${targetWebuiPort}/webui`,
    webuiToken: "target-secret",
    launchCommand: "unused.exe",
    workingDir: path.join(root, "target"),
    botUserId: "10000"
  };
  const runtime = { definition: { id: "route", gatewayPort: 8789, napcatInstances: [instance] } };
  try {
    const result = await ensureNapcatInstanceReady({
      rootDir: root,
      getRuntimes: () => [runtime],
      normalizeNapCatInstances: () => [instance],
      appendLog: () => undefined,
      checkHttpEndpoint: async (url) => url === instance.webuiUrl
    }, { gatewayId: "route", instanceId: "target" });

    assert.equal(result.ok, false);
    assert.equal(result.state, "account-online-elsewhere");
    assert.equal(result.needsUserAction, true);
    assert.equal(quickLoginCount, 0);
    assert.equal((result.accountOwner as { userId?: string }).userId, "10000");
    assert.equal((result.accountOwner as { httpUrl?: string }).httpUrl, `http://127.0.0.1:${ownerPort}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await Promise.all([close(ownerOneBot), close(targetOneBot), close(targetWebui)]);
  }
});

test("direct launch also refuses to start a duplicate account owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-launch-owner-"));
  const ownerOneBot = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request body */ }
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("connection", "close");
    if (request.url === "/get_status") {
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { online: true, good: true } }));
      return;
    }
    response.end(JSON.stringify({
      status: "ok",
      retcode: 0,
      data: { user_id: 10000, nickname: "Online Bot" }
    }));
  });
  const ownerPort = await listen(ownerOneBot);
  const ownerConfigDir = path.join(root, "data", "napcat", "legacy", "NapCat.Shell", "napcat", "config");
  fs.mkdirSync(ownerConfigDir, { recursive: true });
  fs.writeFileSync(path.join(ownerConfigDir, "webui.json"), JSON.stringify({
    host: "::",
    port: 6100,
    token: "owner-secret"
  }), "utf8");
  fs.writeFileSync(path.join(ownerConfigDir, "onebot11_10000.json"), JSON.stringify({
    network: {
      httpServers: [{ enable: true, host: "127.0.0.1", port: ownerPort, token: "" }],
      websocketClients: [{ enable: true, url: "ws://127.0.0.1:8789" }]
    }
  }), "utf8");
  const instance = {
    id: "target",
    name: "Target Bot",
    gatewayPort: 8789,
    httpUrl: "http://127.0.0.1:39991",
    webuiUrl: "http://127.0.0.1:39992/webui",
    launchCommand: "this-command-must-never-run.exe",
    workingDir: path.join(root, "target"),
    botUserId: "10000"
  };
  const runtime = { definition: { id: "route", gatewayPort: 8789, napcatInstances: [instance] } };
  try {
    const result = await launchNapcatInstance({
      rootDir: root,
      getRuntimes: () => [runtime],
      normalizeNapCatInstances: () => [instance],
      appendLog: () => undefined,
      checkHttpEndpoint: async () => false
    }, { gatewayId: "route", instanceId: "target" });

    assert.equal(result.ok, false);
    assert.equal(result.state, "account-online-elsewhere");
    assert.match(String(result.message), /没有启动重复实例/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await close(ownerOneBot);
  }
});

test("concurrent direct launches for one QQ execute one process launch and reuse the ready instance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-single-launch-"));
  let ready = false;
  let launchCount = 0;
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
  const onebotPort = await listen(onebot);
  const instance = {
    id: "bot",
    name: "QQ bot",
    gatewayPort: 8789,
    httpUrl: `http://127.0.0.1:${onebotPort}`,
    launchCommand: "unused.exe",
    botUserId: "10000"
  };
  const runtime = { definition: { id: "route", gatewayPort: 8789, napcatInstances: [instance] } };
  const context = {
    rootDir: root,
    getRuntimes: () => [runtime],
    normalizeNapCatInstances: () => [instance],
    appendLog: () => undefined,
    checkHttpEndpoint: async () => false,
    // The fixture's HTTP listener stands in for the future NapCat process, so
    // do not let the Windows port preflight mistake it for a live process tree.
    findNapcatInstanceProcessPids: async () => ready ? ["4242"] : [],
    launchNapcatProcess: () => {
      launchCount += 1;
      ready = true;
    }
  };
  try {
    const [first, second] = await Promise.all([
      launchNapcatInstance(context, { gatewayId: "route", instanceId: "bot" }),
      launchNapcatInstance(context, { gatewayId: "route", instanceId: "bot" })
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(launchCount, 1);
    assert.ok([first.state, second.state].includes("already-running"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await close(onebot);
  }
});

test("launch suppresses a duplicate process tree when both configured endpoints are unreachable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-existing-process-"));
  let launchCount = 0;
  const instance = {
    id: "bot",
    name: "QQ bot",
    gatewayPort: 8789,
    httpUrl: "http://127.0.0.1:39991",
    webuiUrl: "http://127.0.0.1:39992/webui",
    launchCommand: "must-not-run.exe",
    workingDir: path.join(root, "NapCat.Shell"),
    botUserId: "10000"
  };
  const runtime = { definition: { id: "route", gatewayPort: 8789, napcatInstances: [instance] } };
  try {
    const result = await launchNapcatInstance({
      rootDir: root,
      getRuntimes: () => [runtime],
      normalizeNapCatInstances: () => [instance],
      appendLog: () => undefined,
      checkHttpEndpoint: async () => false,
      findNapcatInstanceProcessPids: async () => ["4242"],
      launchNapcatProcess: () => { launchCount += 1; }
    }, { gatewayId: "route", instanceId: "bot" });

    assert.equal(result.ok, false);
    assert.equal(result.state, "process-or-port-already-present");
    assert.equal(launchCount, 0);
    assert.match(String(result.message), /避免重复启动/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launch reports WebUI-only readiness as onebot-not-ready instead of success", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-webui-only-"));
  let launchCount = 0;
  const instance = {
    id: "bot",
    name: "QQ bot",
    gatewayPort: 8789,
    httpUrl: "http://127.0.0.1:39991",
    webuiUrl: "http://127.0.0.1:39992/webui",
    launchCommand: "unused.exe",
    botUserId: "10000"
  };
  const runtime = { definition: { id: "route", gatewayPort: 8789, napcatInstances: [instance] } };
  try {
    const result = await launchNapcatInstance({
      rootDir: root,
      getRuntimes: () => [runtime],
      normalizeNapCatInstances: () => [instance],
      appendLog: () => undefined,
      checkHttpEndpoint: async (url) => url === instance.webuiUrl,
      findNapcatInstanceProcessPids: async () => [],
      launchNapcatProcess: () => { launchCount += 1; }
    }, { gatewayId: "route", instanceId: "bot" });

    assert.equal(result.ok, false);
    assert.equal(result.state, "onebot-not-ready");
    assert.equal(result.needsUserAction, true);
    assert.equal(launchCount, 1);
    assert.match(String(result.message), /OneBot 尚未就绪/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restart falls back to launchCommand when the NapCat WebUI connection is refused", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-webui-refused-"));
  let ready = false;
  let launchCount = 0;
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
  const onebotPort = await listen(onebot);
  const instance = {
    id: "bot",
    name: "QQ bot",
    gatewayPort: 8789,
    httpUrl: `http://127.0.0.1:${onebotPort}`,
    webuiUrl: "http://127.0.0.1:39992/webui",
    launchCommand: "unused.exe",
    botUserId: "10000"
  };
  const runtime = { definition: { id: "route", gatewayPort: 8789, napcatInstances: [instance] } };
  try {
    const result = await restartNapcatInstance({
      rootDir: root,
      getRuntimes: () => [runtime],
      normalizeNapCatInstances: () => [instance],
      appendLog: () => undefined,
      checkHttpEndpoint: async () => false,
      findNapcatInstanceProcessPids: async () => [],
      launchNapcatProcess: () => {
        launchCount += 1;
        ready = true;
      }
    }, { gatewayId: "route", instanceId: "bot" });

    assert.equal(result.ok, true);
    assert.equal(launchCount, 1);
    assert.match((result.steps as string[]).join("\n"), /改用进程级恢复/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await close(onebot);
  }
});

test("ensure ready reports an expired quick-login identity as a distinct quick-login state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-expired-"));
  const onebot = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request body */ }
    response.statusCode = 502;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("connection", "close");
    response.end(JSON.stringify({ status: "failed", retcode: 1400 }));
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
      response.end(JSON.stringify({ code: 0, data: {} }));
      return;
    }
    if (request.url === "/api/QQLogin/CheckLoginStatus") {
      response.end(JSON.stringify({ code: 0, data: { isLogin: false, loginError: "" } }));
      return;
    }
    if (request.url === "/api/QQLogin/GetQuickLoginListNew") {
      response.end(JSON.stringify({
        code: 0,
        data: [{ uin: "10000", nickName: "Bot", isQuickLogin: true }]
      }));
      return;
    }
    if (request.url === "/api/QQLogin/SetQuickLogin") {
      response.end(JSON.stringify({ code: 1, message: "登录态已失效，请重新登录。" }));
      return;
    }
    response.end("{}");
  });
  const onebotPort = await listen(onebot);
  const webuiPort = await listen(webui);
  const configDir = path.join(root, "target", "napcat", "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "webui.json"), JSON.stringify({
    host: "::",
    port: webuiPort,
    token: "secret"
  }), "utf8");
  const instance = {
    id: "bot",
    name: "QQ bot",
    gatewayPort: 8789,
    httpUrl: `http://127.0.0.1:${onebotPort}`,
    webuiUrl: `http://127.0.0.1:${webuiPort}/webui`,
    webuiToken: "secret",
    launchCommand: "unused.exe",
    workingDir: path.join(root, "target"),
    botUserId: "10000"
  };
  const runtime = { definition: { id: "route", gatewayPort: 8789, napcatInstances: [instance] } };
  try {
    const result = await ensureNapcatInstanceReady({
      rootDir: root,
      getRuntimes: () => [runtime],
      normalizeNapCatInstances: () => [instance],
      appendLog: () => undefined,
      checkHttpEndpoint: async (url) => url === instance.webuiUrl
    }, { gatewayId: "route", instanceId: "bot" });

    assert.equal(result.ok, false);
    assert.equal(result.state, "quick-login-invalid");
    assert.equal(result.needsUserAction, true);
    assert.match(String(result.message), /扫码/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await Promise.all([close(onebot), close(webui)]);
  }
});

test("ensure ready ignores other QQ quick-login entries and requests a QR login for the bound account", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-qr-required-"));
  let quickLoginCount = 0;
  const onebot = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request body */ }
    response.statusCode = 502;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("connection", "close");
    response.end(JSON.stringify({ status: "failed", retcode: 1400 }));
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
      response.end(JSON.stringify({ code: 0, data: {} }));
      return;
    }
    if (request.url === "/api/QQLogin/CheckLoginStatus") {
      response.end(JSON.stringify({
        code: 0,
        data: { isLogin: false, loginError: "二维码已过期，请刷新" }
      }));
      return;
    }
    if (request.url === "/api/QQLogin/GetQuickLoginListNew") {
      response.end(JSON.stringify({
        code: 0,
        data: [{ uin: "20000", nickName: "Other Bot", isQuickLogin: true }]
      }));
      return;
    }
    if (request.url === "/api/QQLogin/SetQuickLogin") {
      quickLoginCount += 1;
      response.end(JSON.stringify({ code: 0, data: null }));
      return;
    }
    response.end("{}");
  });
  const onebotPort = await listen(onebot);
  const webuiPort = await listen(webui);
  const configDir = path.join(root, "target", "napcat", "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "webui.json"), JSON.stringify({
    host: "::",
    port: webuiPort,
    token: "secret"
  }), "utf8");
  const instance = {
    id: "bot",
    name: "QQ bot",
    gatewayPort: 8789,
    httpUrl: `http://127.0.0.1:${onebotPort}`,
    webuiUrl: `http://127.0.0.1:${webuiPort}/webui`,
    webuiToken: "secret",
    launchCommand: "unused.exe",
    workingDir: path.join(root, "target"),
    botUserId: "10000"
  };
  const runtime = { definition: { id: "route", gatewayPort: 8789, napcatInstances: [instance] } };
  try {
    const result = await ensureNapcatInstanceReady({
      rootDir: root,
      getRuntimes: () => [runtime],
      normalizeNapCatInstances: () => [instance],
      appendLog: () => undefined,
      checkHttpEndpoint: async (url) => url === instance.webuiUrl
    }, { gatewayId: "route", instanceId: "bot" });

    assert.equal(result.ok, false);
    assert.equal(result.state, "qr-login-required");
    assert.equal(result.needsUserAction, true);
    const health = result.health as Record<string, unknown>;
    assert.equal(health.state, "qr-login-required");
    assert.equal(health.needsUserAction, true);
    assert.equal(quickLoginCount, 0);
    assert.match(String(result.message), /扫码/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await Promise.all([close(onebot), close(webui)]);
  }
});

test("Rabi startup auto login runs enabled NapCat instances by default and skips opted-out instances", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  let releaseChecks!: () => void;
  const checksReleased = new Promise<void>((resolve) => { releaseChecks = resolve; });
  const enabledInstances = [{
    id: "default-on",
    enabled: true,
    gatewayPort: 8789,
    httpUrl: "http://127.0.0.1:3000"
  }, {
    id: "explicit-on",
    enabled: true,
    autoLoginOnRabiStart: true,
    gatewayPort: 8791,
    httpUrl: "http://127.0.0.1:3001"
  }, {
    id: "explicit-off",
    enabled: true,
    autoLoginOnRabiStart: false,
    gatewayPort: 8792,
    httpUrl: "http://127.0.0.1:3002"
  }, {
    id: "disabled-instance",
    enabled: false,
    gatewayPort: 8793,
    httpUrl: "http://127.0.0.1:3003"
  }];
  const runtimes = [{
    definition: {
      id: "enabled-route",
      enabled: true,
      messageAdapters: ["napcat"],
      gatewayPort: 8789,
      napcatInstances: enabledInstances
    }
  }, {
    definition: {
      id: "disabled-route",
      enabled: false,
      messageAdapters: ["napcat"],
      gatewayPort: 8800,
      napcatInstances: [{
        id: "disabled-route-instance",
        gatewayPort: 8800,
        httpUrl: "http://127.0.0.1:3010"
      }]
    }
  }];

  const pendingResults = autoLoginNapcatInstancesOnRabiStart({
    rootDir: process.cwd(),
    getRuntimes: () => runtimes,
    normalizeNapCatInstances: (definition) => definition.napcatInstances ?? [],
    appendLog: (_runtime, line) => logs.push(line),
    checkHttpEndpoint: async () => false
  }, async (_ctx, request) => {
    calls.push(`${request.gatewayId}/${request.instanceId}`);
    await checksReleased;
    return { ok: true, state: "ready" };
  });

  while (calls.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    "enabled-route/default-on",
    "enabled-route/explicit-on"
  ]);
  releaseChecks();
  const results = await pendingResults;
  assert.equal(results.length, 2);
  assert.equal(logs.length, 2);
  assert.match(logs[0] ?? "", /startup auto login.*default-on.*ready/i);
});

test("Rabi startup auto login keeps the same QQ serialized while other accounts run concurrently", async () => {
  const calls: string[] = [];
  let releaseFirstAccount!: () => void;
  const firstAccountReleased = new Promise<void>((resolve) => { releaseFirstAccount = resolve; });
  const instances = [{
    id: "same-qq-first",
    botUserId: "10000",
    gatewayPort: 8789,
    httpUrl: "http://127.0.0.1:3000"
  }, {
    id: "same-qq-second",
    botUserId: "10000",
    gatewayPort: 8791,
    httpUrl: "http://127.0.0.1:3001"
  }, {
    id: "other-qq",
    botUserId: "20000",
    gatewayPort: 8792,
    httpUrl: "http://127.0.0.1:3002"
  }];
  const runtime = {
    definition: {
      id: "route",
      enabled: true,
      messageAdapters: ["napcat"],
      gatewayPort: 8789,
      napcatInstances: instances
    }
  };

  const pending = autoLoginNapcatInstancesOnRabiStart({
    rootDir: process.cwd(),
    getRuntimes: () => [runtime],
    normalizeNapCatInstances: () => instances,
    appendLog: () => undefined,
    checkHttpEndpoint: async () => false
  }, async (_ctx, request) => {
    calls.push(String(request.instanceId));
    if (request.instanceId === "same-qq-first") await firstAccountReleased;
    return { ok: true, state: "ready" };
  });

  while (calls.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["same-qq-first", "other-qq"]);
  releaseFirstAccount();
  await pending;
  assert.deepEqual(calls, ["same-qq-first", "other-qq", "same-qq-second"]);
});

test("Rabi startup auto login stops a same-QQ serial queue after abort", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const instances = [{
    id: "same-qq-first",
    botUserId: "10000",
    gatewayPort: 8789,
    httpUrl: "http://127.0.0.1:3000"
  }, {
    id: "same-qq-second",
    botUserId: "10000",
    gatewayPort: 8791,
    httpUrl: "http://127.0.0.1:3001"
  }];
  const runtime = {
    definition: {
      id: "route",
      enabled: true,
      messageAdapters: ["napcat"],
      gatewayPort: 8789,
      napcatInstances: instances
    }
  };

  const pending = autoLoginNapcatInstancesOnRabiStart({
    rootDir: process.cwd(),
    getRuntimes: () => [runtime],
    normalizeNapCatInstances: () => instances,
    appendLog: () => undefined,
    checkHttpEndpoint: async () => false
  }, async (_ctx, request) => {
    calls.push(String(request.instanceId));
    if (request.instanceId === "same-qq-first") {
      markFirstStarted();
      await firstReleased;
    }
    return { ok: true, state: "ready" };
  }, controller.signal);

  await firstStarted;
  controller.abort();
  releaseFirst();

  const results = await pending;
  assert.deepEqual(calls, ["same-qq-first"]);
  assert.deepEqual(results.map((result) => result.instanceId), ["same-qq-first"]);
});
