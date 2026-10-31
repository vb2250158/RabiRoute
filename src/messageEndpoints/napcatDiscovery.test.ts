import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { launchNapcatInstance, testNapcatHealth } from "./napcatManager.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-napcat-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workingDir = path.join(root, "preferred");
  const config = path.join(workingDir, "napcat", "config", "webui.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const base = path.join(root, "data", "napcat");
  fs.mkdirSync(base, { recursive: true });
  const instance = { id: "bot", botUserId: "10000", gatewayPort: 8789, workingDir,
    httpUrl: "http://127.0.0.1:12345", webuiUrl: "http://127.0.0.1:6099/webui" };
  const ctx = { rootDir: root, getRuntimes: () => [{ definition: { id: "route", gatewayPort: 8789, napcatInstances: [instance] } }],
    normalizeNapCatInstances: () => [instance], appendLog: () => {}, checkHttpEndpoint: async () => true };
  const request = { gatewayId: "route", instanceId: "bot", inspectProcesses: false, readWebuiLoginInfo: false };
  const responses = { targetUnavailable: false };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const unavailable = responses.targetUnavailable && url.port === "12345";
    const data = url.pathname === "/api/auth/login" ? { Credential: "fixture-session" }
      : url.pathname === "/api/QQLogin/GetQQLoginInfo" ? { uin: "10000", online: true }
      : { user_id: "10000", online: true, good: true };
    return new Response(JSON.stringify({ status: unavailable ? "failed" : "ok", retcode: unavailable ? 1400 : 0, code: 0, data }),
      { status: unavailable ? 503 : 200, headers: { "content-type": "application/json" } });
  });
  for (const name of ["NAPCAT_WEBUI_CONFIG", "NAPCAT_CONFIG_DIR"]) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const access = fs.promises.access.bind(fs.promises);
  const readdir = fs.promises.readdir.bind(fs.promises);
  const exists = fs.existsSync.bind(fs);
  const readFile = fs.promises.readFile.bind(fs.promises);
  const discovery = { paths: [] as string[], files: [] as string[], beforeRead: async (_value: fs.PathLike) => {}, beforeFileRead: async (_value: fs.PathLike) => {} };
  const inside = (value: fs.PathLike) => String(value).startsWith(root + path.sep) || String(value) === root;
  t.mock.method(fs, "existsSync", (value: fs.PathLike) => inside(value) && exists(value));
  t.mock.method(fs.promises, "access", async (value: fs.PathLike) => {
    if (!inside(value)) throw Object.assign(new Error("isolated fixture"), { code: "ENOENT" });
    return access(value);
  });
  t.mock.method(fs.promises, "readdir", async (...args: Parameters<typeof readdir>) => {
    discovery.paths.push(String(args[0]));
    if (!inside(args[0])) throw Object.assign(new Error("isolated fixture"), { code: "ENOENT" });
    await discovery.beforeRead(args[0]);
    return readdir(...args);
  });
  t.mock.method(fs.promises, "readFile", async (...args: Parameters<typeof readFile>) => {
    discovery.files.push(String(args[0]));
    if (typeof args[0] === "string" || args[0] instanceof URL || Buffer.isBuffer(args[0])) await discovery.beforeFileRead(args[0]);
    return readFile(...args);
  });
  return { root, config, base, ctx, request, discovery, responses };
}

test("matching configured NapCat credentials avoid unrelated directory discovery", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.config, JSON.stringify({ port: 6099, token: "fixture-token" }));
  for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(f.base, `unrelated-${i}`));
  let scans = 0;
  const sync = fs.readdirSync.bind(fs);
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof sync>) => { scans++; return sync(...args); });
  const result = await testNapcatHealth(f.ctx, f.request);
  assert.equal(result.webui?.configPath, f.config);
  Object.assign(f.ctx.getRuntimes()[0].definition.napcatInstances[0], { webuiToken: "provided-token" });
  const provided = await testNapcatHealth(f.ctx, f.request);
  assert.equal(provided.webui?.source, "provided");
  assert.equal(provided.webui?.configPath, f.config);
  assert.equal(scans, 0, "an exact configured match must finish before fallback scanning");
  assert.equal(f.discovery.paths.length, 0);
});

test("NapCat discovery observes credential replacement, deletion and disabled WebUI", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.config, JSON.stringify({ port: 6099, token: "first-token" }));
  assert.equal((await testNapcatHealth(f.ctx, f.request)).webui?.tokenLength, 11);
  fs.writeFileSync(f.config, JSON.stringify({ port: 6099, token: "replacement-token" }));
  assert.equal((await testNapcatHealth(f.ctx, f.request)).webui?.tokenLength, 17);
  fs.writeFileSync(f.config, JSON.stringify({ port: 6099, token: "replacement-token", disableWebUI: true }));
  assert.equal((await testNapcatHealth(f.ctx, f.request)).webui?.found, false);
  fs.unlinkSync(f.config);
  assert.equal((await testNapcatHealth(f.ctx, f.request)).webui?.found, false);
});

test("slow fallback directory discovery yields to timers and still finds legacy config", async t => {
  const f = fixture(t);
  const legacy = path.join(f.base, "legacy", "resources", "app", "napcat", "config", "webui.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ port: 6099, token: "legacy-token" }));
  let timerRan = false;
  let slowRead = false;
  let synchronousScans = 0;
  t.mock.method(fs, "readdirSync", () => { synchronousScans++; throw new Error("discovery must use asynchronous reads"); });
  f.discovery.beforeRead = async value => {
    if (String(value) === f.base) {
      slowRead = true;
      await new Promise<void>(resolve => setTimeout(() => { timerRan = true; resolve(); }, 20));
    }
  };
  const result = await testNapcatHealth(f.ctx, f.request);
  assert.equal(result.webui?.configPath, legacy);
  assert.equal(slowRead, true);
  assert.equal(timerRan, true);
  assert.equal(synchronousScans, 0);
});

test("health reads slow OneBot files asynchronously and observes replacement and deletion", async t => {
  const f = fixture(t);
  f.responses.targetUnavailable = true;
  fs.writeFileSync(f.config, JSON.stringify({ port: 6099, token: "health-file-token" }));
  const onebot = path.join(path.dirname(f.config), "onebot11_10000.json");
  const network = (port: number) => ({ network: { httpServers: [{ port, enable: true }], websocketClients: [{ url: "ws://127.0.0.1:8789", enable: true }] } });
  fs.writeFileSync(onebot, JSON.stringify(network(12345)));
  let timerRan = false;
  f.discovery.beforeFileRead = async value => {
    if (String(value) === onebot) await new Promise<void>(resolve => setTimeout(() => { timerRan = true; resolve(); }, 20));
  };
  const first = await testNapcatHealth(f.ctx, { ...f.request, readWebuiLoginInfo: true });
  assert.equal(timerRan, true);
  assert.match(first.message || "", /尚未重载生效/);
  fs.writeFileSync(onebot, JSON.stringify(network(12346)));
  const replaced = await testNapcatHealth(f.ctx, { ...f.request, readWebuiLoginInfo: true });
  assert.match(replaced.message || "", /写入 HTTP\/WS 配置/);
  fs.unlinkSync(onebot);
  const deleted = await testNapcatHealth(f.ctx, { ...f.request, readWebuiLoginInfo: true });
  assert.match(deleted.message || "", /写入 HTTP\/WS 配置/);
  assert.equal(f.discovery.files.filter(value => value === onebot).length, 3);
});

test("account-owner discovery yields during WebUI and OneBot file reads and preserves the owner", async t => {
  const f = fixture(t);
  f.responses.targetUnavailable = true;
  fs.writeFileSync(f.config, JSON.stringify({ port: 6099, token: "target-file-token" }));
  const ownerDir = path.join(f.base, "legacy", "napcat", "config");
  fs.mkdirSync(ownerDir, { recursive: true });
  const webui = path.join(ownerDir, "webui.json");
  const onebot = path.join(ownerDir, "onebot11_10000.json");
  fs.writeFileSync(webui, JSON.stringify({ port: 6200, token: "owner-file-token" }));
  fs.writeFileSync(onebot, JSON.stringify({ network: { httpServers: [{ port: 12346, enable: true }], websocketClients: [{ url: "ws://127.0.0.1:8789", enable: true }] } }));
  const yielded = new Set<string>();
  f.discovery.beforeFileRead = async value => {
    const filename = String(value);
    if (filename === webui || filename === onebot) await new Promise<void>(resolve => setTimeout(() => { yielded.add(filename); resolve(); }, 20));
  };
  const result = await launchNapcatInstance(f.ctx, f.request);
  assert.equal(result.state, "account-online-elsewhere");
  assert.deepEqual([...yielded].sort(), [webui, onebot].sort());
});
