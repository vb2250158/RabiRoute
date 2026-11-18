import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import { createNapcatWebuiManagementOperations, createNapcatWebuiManagementReceiptOperation, type NapcatWebuiManagementContext } from "./napcatWebuiManagementOperations.js";
import { napcatWebuiManagementDescriptors } from "./napcatWebuiManagementContracts.js";

type Row = Record<string, unknown>;
function fixture(t: test.TestContext, override?: (pathname: string, body: Row) => unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-management-"));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const calls: Array<{method:string; path:string; body:Row}> = [];
  const state = { loggedIn: false, account: {} as Row, preference: "", theme: {fontMode:"system",dark:{},light:{}}, platform:"win32", readOnly:false };
  const instance = { id:"instance",enabled:true,botUserId:"12345",httpUrl:"" };
  const route = {id:"fixture",gatewayPort:3001,enabled:true,messageAdapters:["napcat"],napcatInstances:[instance]} as GatewayDefinition;
  const onebot = {network:Object.fromEntries(["httpServers","httpSseServers","httpClients","websocketServers","websocketClients","plugins"].map(key=>[key,[] as Row[]])),
    enableLocalFile2Url:false,parseMultMsg:true,musicSignUrl:"https://user:PRIVATE_FIXTURE@music.example/sign?key=PRIVATE_FIXTURE",timeout:{baseTimeout:10000}};
  onebot.network.httpServers!.push({name:"fixture",host:"127.0.0.1",port:3000,enable:true,token:"PRIVATE_FIXTURE"});
  const config = { fileLog:false, consoleLog:true, fileLogLevel:"debug", consoleLogLevel:"info", packetBackend:"auto", packetServer:"PRIVATE_FIXTURE", o3HookMode:0, autoTimeSync:true };
  const replies = {
    "/api/NapCatConfig/GetConfig": () => config,
    "/api/NapCatConfig/GetUinConfig": () => config,
    "/api/File/font/exists/webui": () => true,
    "/api/Mirror/List": () => ({fileMirrors:["https://user:PRIVATE_FIXTURE@mirror.example/prefix?key=PRIVATE_FIXTURE"],rawMirrors:[""],customMirror:"",timeout:5000}),
    "/api/WebUIConfig/GetConfig": () => ({ host: "::", port: 6099, loginRate: 10, disableWebUI: false, accessControlMode: "none", ipWhitelist: [], ipBlacklist: [], enableXForwardedFor: false, token: "PRIVATE_FIXTURE" }),
    "/api/WebUIConfig/GetDisableWebUI": () => false,
    "/api/WebUIConfig/GetClientIP": () => ({ ip: "127.0.0.1" }),
    "/api/OB11Config/GetConfig": () => onebot,
    "/api/QQLogin/GetPlatformInfo": () => ({ platform: state.platform }),
    "/api/QQLogin/GetQQLoginQrcode": () => ({ qrcode: "PRIVATE_FIXTURE_QR" }),
    "/api/QQLogin/GetQuickLoginList": () => ["12345", "23456", null],
    "/api/QQLogin/GetQuickLoginQQ": () => state.preference,
    "/api/QQLogin/GetDeviceGUID": () => ({ guid: "a".repeat(32) }),
    "/api/QQLogin/GetGUIDBackups": () => ["Registry20.bak.20261118000000", "../outside"],
    "/api/QQLogin/GetLinuxMAC": () => ({ mac: "11-22-33-44-55-66" }),
    "/api/QQLogin/GetLinuxMachineId": () => ({ machineId: "PRIVATE_FIXTURE_MACHINE" }),
    "/api/QQLogin/GetLinuxMachineInfoBackups": () => ["machine-info.bak.20261118000000"],
    "/api/base/Theme": () => state.theme,
  };

  const context: NapcatWebuiManagementContext = {
    rootDir:root, readOnly:()=>state.readOnly, local:()=>true,route:()=>route,
    transport:async()=>{throw new Error("First-login management must not require OneBot online");},
    openManagementSession:async selection=>({assertCurrent:selection.assertCurrent,runBindingOperation:async run=>run(),
      requestManagement:async(method,pathname,body)=>{
        calls.push({method,path:pathname,body});
        const replaced=override?.(pathname,body);
        if(replaced!==undefined)return Response.json(replaced);
        let data:unknown;
        if(pathname==="/api/QQLogin/CheckLoginStatus")data={isLogin:state.loggedIn};
        else if(pathname==="/api/QQLogin/GetQQLoginInfo")data=state.account;
        else if(pathname==="/api/QQLogin/SetQuickLoginQQ"){state.preference=String(body.uin);data=null;}
        else if(pathname==="/api/base/SetTheme"){const patch=body.theme as typeof state.theme;state.theme={...state.theme,...patch,dark:{...state.theme.dark,...patch.dark},light:{...state.theme.light,...patch.light}};data=null;}
        else if(pathname==="/api/QQLogin/ComputeLinuxGUID"){
          const machineId=String(body.machineId||"PRIVATE_FIXTURE_MACHINE"),mac=String(body.mac||"11-22-33-44-55-66");
          data={machineId,mac,guid:createHash("md5").update(machineId,"ascii").update(mac,"ascii").digest("hex")};
        } else {assert.ok(replies[pathname as keyof typeof replies],pathname);data=replies[pathname as keyof typeof replies]();}
        return Response.json({code:0,data});
      }})
  };
  const operations=createNapcatWebuiManagementOperations(context);
  const input=(id:string,params:Row={},deliveryId?:string):ApiOperationInput=>({request:{headers:{}} as IncomingMessage,response:{},
    url:new URL(`http://localhost/api/agent/qq/webui-management/${id}`),path:{},query:{},body:{routeId:"fixture",instanceId:"instance",params,...(deliveryId?{deliveryId}:{})}} as ApiOperationInput);
  const run=async(id:string,params:Row={},deliveryId?:string)=>operations.find(op=>op.contract.operationId===`agent.qq.webui.management.${id}`)!.handler(input(id,params,deliveryId));
  return {root,state,instance,route,calls,context,input,run,operations};
}

test("twenty fixed contracts and eighteen safe reads support explicit first-login bootstrap",async t=>{
  const f=fixture(t);assert.equal(f.operations.length,20);
  f.instance.botUserId="";
  for(const spec of napcatWebuiManagementDescriptors.filter(item=>item.effects!=="configuration-mutation")){
    f.state.loggedIn=spec.binding==="login-required";
    f.instance.botUserId=f.state.loggedIn?"12345":"";
    f.state.account=f.state.loggedIn?{uin:"12345"}:{};
    const result=await f.run(spec.id);
    assert.equal(result.status,200,`${spec.id}: ${JSON.stringify(result.body)}`);
    assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE_FIXTURE|a{32}|11-22-33-44-55-66/);
  }
});

test("network authentication and malformed status never become logged-out evidence",async t=>{
  for(const reply of [{code:-1,message:"Unauthorized"},{code:0,data:{}},{code:0,data:{isLogin:"false"}}]){
    const f=fixture(t,p=>p==="/api/QQLogin/CheckLoginStatus"?reply:undefined);
    assert.equal((await f.run("login-qr")).status,503);assert.equal(f.calls.length,1);
  }
  const f=fixture(t,()=>{throw new Error("PRIVATE_FIXTURE network");});
  const result=await f.run("login-qr");assert.equal(result.status,503);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_FIXTURE/);
});

test("observed QQ and native login status control the actual selected binding",async t=>{
  const f=fixture(t);f.state.account={uin:"54321"};
  assert.equal((await f.run("platform")).status,409);assert.equal(f.calls.length,2);
  f.state.account={};assert.equal((await f.run("onebot-config")).status,409);
  f.state.loggedIn=true;assert.equal((await f.run("platform")).status,503);
  f.state.account={uin:"12345"};assert.equal((await f.run("login-qr")).status,409);
});

test("native OS and file requirements preserve pure explicit GUID computation",async t=>{
  const f=fixture(t);f.state.platform="linux";
  assert.equal((await f.run("windows-guid")).status,409);
  assert.equal(f.calls.some(c=>c.path==="/api/QQLogin/GetDeviceGUID"),false);
  assert.equal((await f.run("linux-guid-compute",{machineId:"fixture",mac:"fixture"})).status,200);
  const missing=fixture(t,p=>p==="/api/QQLogin/ComputeLinuxGUID"?{code:0,data:{machineId:"",mac:"",guid:"a".repeat(32)}}:undefined);
  assert.equal((await missing.run("linux-guid-compute")).status,503);
});

test("closed parameters and read-only mode reject before any provider call",async t=>{
  const f=fixture(t);
  assert.equal((await f.run("platform",{url:"http://private"})).status,400);
  assert.equal((await f.run("theme.set",{theme:{fontMode:"system",dark:{},light:{},token:"private"}},"bad")).status,400);
  f.state.readOnly=true;
  assert.equal((await f.run("quick-login-preference.set",{userId:"12345"},"readonly")).status,403);
  assert.equal(f.calls.length,0);
});

test("preferences use original durable receipts, empty disables, conflicting payload never dispatches",async t=>{
  const f=fixture(t);
  const first=await f.run("quick-login-preference.set",{userId:"12345"},"fixture-preference");
  assert.equal(first.status,200,JSON.stringify(first.body));
  assert.equal((await f.run("quick-login-preference.set",{userId:"12345"},"fixture-preference")).status,200);
  assert.equal((await f.run("quick-login-preference.set",{userId:""},"fixture-preference")).status,409);
  assert.equal(f.calls.filter(c=>c.path==="/api/QQLogin/SetQuickLoginQQ").length,1);
  assert.equal((await f.run("quick-login-preference.set",{userId:"54321"},"wrong-account")).status,409);
  assert.equal((await f.run("quick-login-preference.set",{userId:""},"disable")).status,200);
  f.instance.botUserId = "";
  assert.equal((await f.run("quick-login-preference.set", { userId: "12345" }, "unbound-account")).status, 409);
  f.instance.botUserId = "12345";
  const count=f.calls.length;
  const receipt=createNapcatWebuiManagementReceiptOperation(f.context);
  const result=await receipt.handler({...f.input(""),path:{deliveryId:"fixture-preference"},query:{routeId:"fixture",instanceId:"instance"}});
  assert.equal(result.status,200);assert.equal(f.calls.length,count);
});

test("accepted but lost replies stay uncertain without replay or changing legacy receipts",async t=>{
  let writes=0;
  const f=fixture(t,p=>{if(p==="/api/QQLogin/SetQuickLoginQQ"){writes++;throw new Error("PRIVATE_FIXTURE lost reply");}});
  const legacy=path.join(f.root,"legacy-unknown.json");fs.writeFileSync(legacy,'{"state":"unknown"}');
  assert.equal((await f.run("quick-login-preference.set",{userId:"12345"},"uncertain")).status,202);
  assert.equal((await f.run("quick-login-preference.set",{userId:"12345"},"uncertain")).status,202);
  assert.equal(writes,1);assert.equal(fs.readFileSync(legacy,"utf8"),'{"state":"unknown"}');
});

test("theme write readback is verified before completion",async t=>{
  const f=fixture(t);const theme={fontMode:"system",dark:{"--background":"fixture"},light:{}};
  assert.equal((await f.run("theme.set",{theme},"theme")).status,200);
  const wrong=fixture(t,p=>p==="/api/base/Theme"?{code:0,data:{fontMode:"system",dark:{},light:{}}}:undefined);
  assert.equal((await wrong.run("theme.set",{theme},"wrong-readback")).status,202);
});

test("authority, unexpected targets and changed binding stop before protected native calls", async t => {
  const f = fixture(t);
  f.context.local = () => false;
  assert.equal((await f.run("platform")).status, 403);
  assert.equal(f.calls.length, 0);
  f.context.local = () => true;
  const operation = f.operations.find(item => item.contract.operationId.endsWith(".platform"))!;
  const unexpected = { ...f.input("platform"), url: new URL("http://localhost/api/agent/qq/webui-management/platform?url=http://private") };
  assert.equal((await operation.handler(unexpected)).status, 400);
  f.context.openManagementSession = async selection => {
    f.instance.enabled = false;
    return { assertCurrent: selection.assertCurrent, requestManagement: async () => { throw new Error("must not reach provider"); }, runBindingOperation: async run => run() };
  };
  assert.equal((await f.run("platform")).status, 409);
  assert.equal(f.calls.length, 0);
});

test("a durable original ID cannot be reused under a different configured QQ", async t => {
  const f = fixture(t);
  const theme = { fontMode: "system", dark: {}, light: {} };
  assert.equal((await f.run("theme.set", { theme }, "account-bound")).status, 200);
  f.instance.botUserId = "54321";
  assert.equal((await f.run("theme.set", { theme }, "account-bound")).status, 409);
  assert.equal(f.calls.filter(item => item.path === "/api/base/SetTheme").length, 1);
  const receipt = createNapcatWebuiManagementReceiptOperation(f.context);
  const input = { ...f.input(""), path: { deliveryId: "account-bound" }, query: { routeId: "fixture", instanceId: "instance" } };
  assert.equal((await receipt.handler(input)).status, 404);
});

test("theme readback proves the native deep-merge result and preserves prior fields", async t => {
  const f = fixture(t);
  const before = { fontMode: "old", dark: { "--prior": "keep", "--changed": "old" }, light: { "--prior-light": "keep" } };
  f.state.theme = before;
  const patch = { fontMode: "system", dark: { "--changed": "new" }, light: {} };
  const result = await f.run("theme.set", { theme: patch }, "theme-merge");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(f.state.theme, { fontMode: "system", dark: { "--prior": "keep", "--changed": "new" }, light: { "--prior-light": "keep" } });
  assert.deepEqual(f.calls.filter(item => item.path === "/api/base/Theme" || item.path === "/api/base/SetTheme").map(item => item.path),
    ["/api/base/Theme", "/api/base/SetTheme", "/api/base/Theme"]);
  const digest = (value: unknown): string => {
    const stable = (entry: unknown): unknown => entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : entry;
    return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
  };
  assert.equal((result.body as {data:{afterDigest:string}}).data.afterDigest, digest(f.state.theme));
});

test("an observed native QQ always requires its original configured account, including explicit logged-out status", async t => {
  const f = fixture(t);
  f.instance.botUserId = "";
  f.state.loggedIn = true;
  f.state.account = { uin: "12345" };
  const live = await f.run("platform");
  assert.equal(live.status, 409);
  assert.equal((live.body as {errorCode:string}).errorCode, "QQ_WEBUI_CONFIGURED_ACCOUNT_REQUIRED");
  f.state.loggedIn = false;
  assert.equal((await f.run("platform")).status, 409);
  f.state.account = {};
  assert.equal((await f.run("platform")).status, 200);
});

test("native account changes while the binding operation queues cannot dispatch the setter", async t => {
  const f = fixture(t);
  f.context.openManagementSession = async selection => ({
    assertCurrent: selection.assertCurrent,
    runBindingOperation: async run => { f.state.account = { uin: "54321" }; return run(); },
    requestManagement: async (_method, pathname) => {
      f.calls.push({ method: _method, path: pathname, body: {} });
      assert.ok(["/api/QQLogin/CheckLoginStatus", "/api/QQLogin/GetQQLoginInfo"].includes(pathname));
      return Response.json({ code: 0, data: pathname.endsWith("CheckLoginStatus") ? { isLogin: f.state.loggedIn } : f.state.account });
    }
  });
  const result = await f.run("quick-login-preference.set", { userId: "12345" }, "queue-account-change");
  assert.equal(result.status, 202);
  assert.equal(f.calls.some(item => item.path === "/api/QQLogin/SetQuickLoginQQ"), false);
  const original = fs.readdirSync(f.root, { recursive: true }).length;
  assert.ok(original > 0);
});

test("a native account change during the original theme read prevents writing and remains uncertain", async t => {
  const f = fixture(t, pathname => {
    if (pathname === "/api/base/Theme") {
      f.state.account = { uin: "54321" };
      return { code: 0, data: f.state.theme };
    }
  });
  const result = await f.run("theme.set", { theme: { fontMode: "system", dark: {}, light: {} } }, "theme-account-change");
  assert.equal(result.status, 202);
  assert.equal(f.calls.some(item => item.path === "/api/base/SetTheme"), false);
  f.state.account = {};
  const repeated = await f.run("theme.set", { theme: { fontMode: "system", dark: {}, light: {} } }, "theme-account-change");
  assert.equal(repeated.status, 202);
  assert.equal(f.calls.some(item => item.path === "/api/base/SetTheme"), false);
});

test("a changed native account after accepted setter readback retains the uncertain original ID", async t => {
  let preferenceReads = 0;
  const f = fixture(t, pathname => {
    if (pathname === "/api/QQLogin/GetQuickLoginQQ" && ++preferenceReads === 1) {
      f.state.account = { uin: "54321" };
      return { code: 0, data: f.state.preference };
    }
  });
  const params = { userId: "12345" };
  assert.equal((await f.run("quick-login-preference.set", params, "after-write-change")).status, 202);
  f.state.account = {};
  assert.equal((await f.run("quick-login-preference.set", params, "after-write-change")).status, 202);
  assert.equal(f.calls.filter(item => item.path === "/api/QQLogin/SetQuickLoginQQ").length, 1);
});
