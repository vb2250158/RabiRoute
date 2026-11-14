import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createNapcatManagerOwner, type NapcatManagerHostPorts } from "./managerOwner.js";
import { NapcatLifecycleOwner, type NapcatProcessIdentity, type NapcatPortInspection } from "../../manager/napcatLifecycleOwner.js";
import { recoverNapcatExternalPorts } from "./externalPortRecovery.js";
import { launchNapcatInstance } from "../../messageEndpoints/napcatManager.js";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";

const request = { gatewayId: "route", instanceId: "bot" };
const childCode = `
 const http=require('http'),crypto=require('crypto');
 const serve=()=>http.createServer(async(req,res)=>{
  let bytes='';for await(const part of req)bytes+=part;res.setHeader('content-type','application/json');
  if(req.url==='/api/auth/login'){
    if(JSON.parse(bytes).hash!==crypto.createHash('sha256').update('test-only-webui.napcat').digest('hex'))return res.writeHead(401).end('{}');
    return res.end(JSON.stringify({code:0,data:{Credential:'test-only-session'}}));
  }
  if(req.url.startsWith('/api/')){
    if(req.headers.authorization!=='Bearer test-only-session')return res.writeHead(401).end('{}');
    return res.end(JSON.stringify({code:0,data:{uin:'10000',online:true}}));
  }
  if(req.headers.authorization!=='Bearer test-only-http')return res.writeHead(401).end('{}');
  res.end(JSON.stringify({retcode:0,data:req.url==='/get_login_info'?{user_id:10000,nickname:'fixture'}:{online:true,good:true}}));
 });
 const ports=JSON.parse(process.env.FIXTURE_PORTS);let ready=0;
 for(const port of ports){const s=serve();s.on('error',()=>process.exit(7));s.listen(port,'127.0.0.1',()=>{if(++ready===ports.length)process.send({ready:true});});}
`;

test("original Manager recovers a real foreign port conflict, verifies owned listeners/auth, and commits only URLs", { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-external-owner-"));
  fs.mkdirSync(path.join(directory, "config"));
  for (const filename of ["NapCatWinBootMain.exe", "QQ.exe", "NapCatWinBootHook.dll"]) fs.writeFileSync(path.join(directory, filename), "fixture");
  let foreignCredentialRequests = 0;
  const foreign = http.createServer((req, res) => {
    if (req.headers.authorization) foreignCredentialRequests++;
    res.end("foreign-still-alive");
  });
  foreign.listen(0, "127.0.0.1"); await once(foreign, "listening");
  const foreignAddress = foreign.address(); if (!foreignAddress || typeof foreignAddress === "string") throw new Error("No fixture port.");
  const foreignProcess = { pid: process.pid, parentPid: 0, startedAt: "foreign-original-start", executable: process.execPath };
  let child: ChildProcess | undefined, own: NapcatProcessIdentity | undefined, activePorts: number[] = [], ready = false;
  const killed: number[] = [];
  const snapshot = () => [foreignProcess, ...(child && child.exitCode === null && child.signalCode === null && own ? [own] : [])];
  const processOwner = new NapcatLifecycleOwner({ statePath: path.join(directory, "ownership.json"), log() {}, driver: {
    async snapshot() { return snapshot(); },
    async terminate(target) {
      assert.notEqual(target.pid, foreignProcess.pid, "A foreign port holder must never be killed."); killed.push(target.pid);
      if (child?.pid === target.pid && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    },
    async inspectBundledPorts(binding, plan) {
      const ports = [binding.httpUrl, binding.webuiUrl!].map(value => Number(new URL(value).port));
      const listeners: NapcatPortInspection["listeners"] = [];
      if (ports.includes(foreignAddress.port)) listeners.push({ port: foreignAddress.port, process: foreignProcess });
      if (ready && own && snapshot().some(value => value.pid === own!.pid))
        for (const port of activePorts) if (ports.includes(port)) listeners.push({ port, process: own });
      return { checkedAt: new Date().toISOString(), commandPath: plan.commandPath,
        instanceStopped: !child || child.exitCode !== null || child.signalCode !== null, listeners };
    }
  } });
  let saved: GatewayDefinition = { id: "route", gatewayPort: 0, messageAdapters: ["napcat"],
    napcatInstances: [{ id: "bot", gatewayPort: 0, botUserId: "10000", workingDir: directory,
      launchCommand: path.join(directory, "NapCatWinBootMain.exe"), httpUrl: `http://127.0.0.1:${foreignAddress.port}`,
      webuiUrl: `http://127.0.0.1:${foreignAddress.port}/webui`, accessToken: "test-only-http", webuiToken: "test-only-webui" }] };
  fs.writeFileSync(path.join(directory, "config", "webui.json"), JSON.stringify({ port: foreignAddress.port, token: "test-only-webui", retained: "original" }));
  const originalTemplate = { retained: "original", network: { httpServers: [{ name: "RabiRoute HTTP", port: foreignAddress.port, token: "test-only-http" }] } };
  fs.writeFileSync(path.join(directory, "config", "onebot11_rabiroute_bot.json"), JSON.stringify(originalTemplate));
  const proof = { gatewayId: "route", gatewayGenerationId: "original", pid: process.pid,
    listenerId: "original-ws", leaseId: "original-ws-lease", protocol: "onebot-v11-reverse-websocket",
    address: { protocol: "http" as const, hostname: "127.0.0.1", port: 45678 }, assertCurrent() {} };
  const host: NapcatManagerHostPorts = { rootDir: directory, managerPort: 0, readOnly: false,
    readListener: () => proof, async waitForListener() { return proof; },
    readRoutes: () => [structuredClone(saved)], readRuntimes: () => [{ definition: structuredClone(saved), running: true, status: {} }],
    normalizeDefinition: value => value, appendRouteLog() {}, async checkHttpEndpoint() { return false; },
    async saveRoute(next) { assert.equal(next.gatewayPort, 0); assert.equal(next.napcatInstances![0]!.gatewayPort, 0);
      saved = structuredClone(next); await manager.reconcileRoutes([saved]); },
    async writeRoutes() {}, routeVersion: () => "fixture", syncRoutes() {}, gatewayPayload() {}, log() {} };
  const manager = createNapcatManagerOwner(host, { resources: { processOwner } });
  t.after(async () => {
    await manager.stopResources(); foreign.closeAllConnections(); await new Promise<void>(resolve => foreign.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await manager.reconcileRoutes([saved]);
  const context = manager.context();
  const originalHttpUrl = saved.napcatInstances![0]!.httpUrl;
  context.launchNapcatProcess = async (plan, _visible, launchRequest) => {
    const candidate = JSON.parse(fs.readFileSync(path.join(directory, "config", "webui.json"), "utf8"));
    const onebot = JSON.parse(fs.readFileSync(path.join(directory, "config", "onebot11_rabiroute_bot.json"), "utf8"));
    activePorts = [onebot.network.httpServers.find((value: { name: string }) => value.name === "RabiRoute HTTP").port, candidate.port];
    await processOwner.launch(launchRequest, () => {
      child = spawn(process.execPath, ["--eval", childCode], { env: { ...process.env, FIXTURE_PORTS: JSON.stringify(activePorts) }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      own = { pid: child.pid!, parentPid: process.pid, startedAt: new Date().toISOString(), executable: process.execPath };
      return child;
    }, plan);
    const [message] = await once(child!, "message"); assert.deepEqual(message, { ready: true }); ready = true;
  };
  const result = await launchNapcatInstance(context, request);
  assert.equal(result?.ok, true); assert.deepEqual(killed, []);
  assert.equal(foreignCredentialRequests, 0, "A conflicting original port must never receive the retained credential.");
  assert.equal(await (await fetch(`http://127.0.0.1:${foreignAddress.port}`)).text(), "foreign-still-alive");
  assert.notEqual(saved.napcatInstances![0]!.httpUrl, originalHttpUrl);
  assert.equal(saved.napcatInstances![0]!.webuiToken, "test-only-webui"); assert.equal(saved.napcatInstances![0]!.accessToken, "test-only-http");
  assert.equal(saved.napcatInstances![0]!.workingDir, directory); assert.equal(saved.napcatInstances![0]!.botUserId, "10000");
  const webui = JSON.parse(fs.readFileSync(path.join(directory, "config", "webui.json"), "utf8"));
  assert.equal(webui.retained, "original"); assert.equal(webui.token, "test-only-webui");
  assert.equal(webui.port, Number(new URL(saved.napcatInstances![0]!.webuiUrl!).port));
  assert.equal(processOwner.recoveredEndpoints(request), undefined, "Configuration owner acknowledges the durable recovery receipt.");
});

test("foreign bind races have three candidates and no foreign kill; unrelated failures do not retry", async () => {
  const foreign = { pid: 123, parentPid: 0, startedAt: "original", executable: "foreign.exe" };
  const inspection: NapcatPortInspection = { checkedAt: new Date().toISOString(), commandPath: "original.exe", instanceStopped: true,
    listeners: [{ port: 12345, process: foreign }] };
  for (const conflict of [true, false]) {
    let launches = 0, stops = 0, published = 0;
    await assert.rejects(recoverNapcatExternalPorts({ instance: { httpUrl: "http://127.0.0.1:12345", webuiUrl: "http://127.0.0.1:12346/webui" },
      assertCurrent() {}, stopped: async () => inspection, writeCandidate() {},
      async launch() { launches++; throw new Error("original-launch-failed"); },
      async verify() { return undefined; }, async conflicted() { return conflict; },
      async stopOwned() { stops++; }, publish() { published++; }
    }), /original-launch-failed/);
    assert.equal(launches, conflict ? 3 : 1); assert.equal(stops, conflict ? 3 : 0); assert.equal(published, 0);
  }
});

test("unknown or live original instance cannot mutate external port configuration", async () => {
  for (const stopped of [undefined, { checkedAt: "now", commandPath: "original", instanceStopped: false, listeners: [] }]) {
    let mutations = 0;
    const result = await recoverNapcatExternalPorts({ instance: { httpUrl: "http://127.0.0.1:12345", webuiUrl: "http://127.0.0.1:12346/webui" },
      assertCurrent() {}, async stopped() { return stopped; }, writeCandidate() { mutations++; },
      async launch() { mutations++; return {}; }, async verify() { return undefined; }, async conflicted() { return false; },
      async stopOwned() { mutations++; }, publish() { mutations++; }
    });
    assert.equal(result, undefined); assert.equal(mutations, 0);
  }
});
