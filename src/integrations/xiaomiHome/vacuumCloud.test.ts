import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createCipheriv } from "node:crypto";
import fs from "node:fs";
import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { cloudRc4, cloudSignature, validatedCloudUrl, XiaomiVacuumCloud } from "./vacuumCloud.js";
import { createLocalSecretProtector, type LocalSecretProtector } from "../../shared/localSecretProtection.js";
import {XiaomiHomeManagerApiError} from "./managerApi.js";

const protector: LocalSecretProtector = { scheme: "test-only", protect: text => Buffer.from(text).toString("base64"), unprotect: text => Buffer.from(text, "base64").toString() };
const security = Buffer.alloc(16, 9).toString("base64");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

test("shared feedback brackets the fixed read, resets stale task cursors and reports failures without hiding the map", async () => {
 const f=fixture();try {
  const login:any=await f.cloud.begin("feedback-test-key-01");await f.cloud.poll(login.sessionId);f.setModel("xiaomi.vacuum.pv11cn");
  const m:any={schemaVersion:1,decoded:true,sha256:"a".repeat(64),blobBase64:"",slot:"0",observedAt:new Date().toISOString(),
    device:{deviceId:"987654321",model:"xiaomi.vacuum.pv11cn",name:"Fixture vacuum",online:true},
    grid:{mapId:1,originX:0,originY:0,resolution:50,rotation:0,width:100,height:100},map:{task_id:1,paths:{pose_id:2}}};
  let mapReads=0;f.cloud.map=async()=>{mapReads++;return structuredClone(m);};
  const first:any=await f.cloud.feedback("987654321","cn","0");
  assert.equal(mapReads,2);assert.equal(first.feedback.state,"sample");
  assert.equal(first.feedback.position.poseId,2);assert.equal(first.feedback.newPointCount,0);
  assert.equal(first.feedback.coordinateNavigation,false);assert.equal(first.feedback.poseFreshness,"unverified");
  assert.ok(!JSON.stringify(first).includes("privateToken")&&!JSON.stringify(first).includes("serviceToken"));
  const repeated:any=await f.cloud.feedback("987654321","cn","0",first.feedback.scope,"2");
  assert.equal(repeated.feedback.newPointCount,0);
  m.map.task_id=2;
  const reset:any=await f.cloud.feedback("987654321","cn","0",first.feedback.scope,"20000");
  assert.equal(reset.feedback.reset,true);assert.equal(reset.feedback.queryPoseId,1);
  assert.equal(reset.feedback.nextPoseId,2);
  for(const pair of [["","1"],["invalid","1"],["a".repeat(64),"2147483648"]])
    await assert.rejects(f.cloud.feedback("987654321","cn","0",pair[0],pair[1]),/both feedback/);
  const actionCount=f.requests.filter(r=>r.url.pathname.endsWith("miotspec/action")).length;
  delete m.map.paths;
  assert.equal((await f.cloud.feedback("987654321","cn","0")).feedback.state,"map_identity_unavailable");
  assert.equal(f.requests.filter(r=>r.url.pathname.endsWith("miotspec/action")).length,actionCount);
  m.map.paths={pose_id:2};
  f.cloud.trajectory=async()=>{throw new XiaomiHomeManagerApiError(502,"fixture_rejected","Sensitive payload not returned");};
  const failed:any=await f.cloud.feedback("987654321","cn","0");
  assert.equal(failed.map.decoded,true);assert.equal(failed.feedback.state,"trajectory_unavailable");
  assert.equal(failed.feedback.position,undefined);assert.ok(!JSON.stringify(failed).includes("Sensitive payload"));
 }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});

test("RC4-drop1024 matches independent RFC 6229 vector", () => {
  // https://www.rfc-editor.org/rfc/rfc6229#section-2 : 40-bit key, offset 1024.
  assert.equal(cloudRc4(Buffer.from("0102030405", "hex"), Buffer.alloc(16)).toString("hex"), "30abbcc7c20b01609f23ee2d5f6bb7df");
});

test("cloud URL validation rejects credentials, insecure redirects, suffix spoofing and private hosts", () => {
  for (const url of ["http://account.xiaomi.com/", "https://xiaomi.com.evil.invalid/", "https://127.0.0.1/", "https://account.xiaomi.com:444/", "https://user:pass@account.xiaomi.com/", "https://account.xiaomi.com/#x"]) assert.throws(() => validatedCloudUrl(url), /HTTPS/);
  assert.equal(validatedCloudUrl("https://cnbj1.fds.api.xiaomi.com/map", true).protocol, "https:");
});

function fixture(realProtection = false, vendorParams?: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vacuum-cloud-"));
  const secretProtector = realProtection ? createLocalSecretProtector(directory, ".vacuum-cloud.key") : protector;
  const requests: Array<{ url: URL; options: RequestInit }> = [];
  let mapBlob:Buffer|undefined;
  let mapRedirect = "", oversized = false, loginBadRedirect = false, backupPackage = false, hugePackage = false;
  let model = "xiaomi.vacuum.test1", videoMode = false, pinResult = "0", mismatch = false;
  const videoActions: any[] = [];
  let pageOutput: unknown = [];
  let trajectoryResponse: unknown = { code: 0, result: { did: "987654321", siid: 2, aiid: 47, code: 0,
    out: [JSON.stringify({points:[{pose_id:2,x:150,y:-200,yaw:12,privateToken:"not-returned"},{pose_id:1,x:100,y:-200}]})] } };
  let positionResponse: unknown = {code:0,result:[{did:"987654321",siid:10,piid:4,code:0,value:""}]};
  const telemetryResponse = {code:0,result:[
    {did:"987654321",siid:2,piid:2,code:0,value:8}, {did:"987654321",siid:2,piid:3,code:0,value:0},
    {did:"987654321",siid:2,piid:26,code:0,value:false}, {did:"987654321",siid:20,piid:11,code:0,value:1}
  ]};
  const fetchImpl = (async (input: any, options: RequestInit = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === "/pass/serviceLogin") return new Response("&&&START&&&" + JSON.stringify({ _sign: "test-sign", qs: "test-query", callback: "https://sts.api.io.mi.com/sts", location: "https://account.xiaomi.com/login?serviceParam=test" }), { headers: { "set-cookie": "loginCookie=test; Domain=account.xiaomi.com; Path=/" } });
    if (url.pathname === "/longPolling/loginUrl") return Response.json({ lp: "https://account.xiaomi.com/poll", qr: "https://account.xiaomi.com/qr.png", loginUrl: "https://account.xiaomi.com/scan" });
    if (url.pathname === "/qr.png") return new Response(png);
    if (url.pathname === "/poll") return Response.json({ code: 0, userId: "123456789", ssecurity: security, location: "https://sts.api.io.mi.com/sts" });
    if (url.pathname === "/sts") return loginBadRedirect ? new Response(null, { status: 302, headers: { location: "https://untrusted.invalid/token" } }) : new Response("ok", { headers: { "set-cookie": "serviceToken=test-secret-token; Domain=sts.api.io.mi.com; Path=/" } });
    if (url.pathname.startsWith("/app/")) {
      const nonce = Buffer.from(url.searchParams.get("_nonce")!, "base64");
      const signed = createHash("sha256").update(Buffer.concat([Buffer.from(security, "base64"), nonce])).digest();
      const encrypted = { data: url.searchParams.get("data")!, rc4_hash__: url.searchParams.get("rc4_hash__")! };
      assert.equal(url.searchParams.get("signature"), cloudSignature(url, signed.toString("base64"), encrypted));
      const body = JSON.parse(cloudRc4(signed, Buffer.from(encrypted.data, "base64")).toString());
      let result;
      if (url.pathname.endsWith("device_list")) result = { code: 0, result: { list: [{ did: "987654321", model, name: "Test vacuum", localip:"192.168.1.100", isOnline: true, token: "never-return-this" }, { did: "999", model: "xiaomi.light.test1" }] } };
      else if (url.pathname.endsWith("miotspec/prop/get")) {
        if (body.params.length === 4) {
          assert.deepEqual(body,{datasource:2,params:[{did:"987654321",siid:2,piid:2},{did:"987654321",siid:2,piid:3},{did:"987654321",siid:2,piid:26},{did:"987654321",siid:20,piid:11}]});
          result=telemetryResponse;
        } else {
        assert.deepEqual(body,{datasource:2,params:[{did:"987654321",siid:10,piid:4}]}, "position must read the device, not prefer cached coordinates");
        result=positionResponse;
        }
      }
      else if (url.pathname.endsWith("miotspec/action")) {
        if (videoMode) {
          videoActions.push(body.params);
          assert.equal(body.params.siid,21); assert.ok([4,7].includes(body.params.aiid), "never set or reset the password");
          result = {code:0,result:{did:mismatch?"wrong-device":body.params.did,siid:21,aiid:body.params.aiid,code:0,out:body.params.aiid===7?[{piid:7,value:pinResult}]:pageOutput}};
        } else {
        assert.deepEqual(body, {params:{did:"987654321",siid:2,aiid:47,in:['{"pose_id":1}']}});
        result = trajectoryResponse;
        }
      }
      else if (url.pathname.endsWith("miss_get_vendor")) { assert.equal(body.did,"987654321"); assert.match(body.app_pubkey,/^[a-f0-9]{64}$/); result={code:0,result:{vendor:{vendor:4,vendor_params:vendorParams},public_key:"ab".repeat(32),sign:"ephemeral-sign"}}; }
      else if (url.pathname.endsWith("fetch_plugin")) {
        assert.deepEqual(body, { latest_req: { api_version: 10112, app_platform: "Android", region: "CN", package_type: "", plugins: [{ model: "xiaomi.vacuum.test1" }] }, backup_req: {api_level:101,app_platform:"phone",plugins:[{model:"xiaomi.vacuum.test1"}]} });
        const info = {model: "xiaomi.vacuum.test1", plugin_id: 10, package_id: 20, version: 1, download_url: "https://cnbj1.fds.api.xiaomi.com/map"};
        result = { code: 0, result: { latest_info: backupPackage ? [] : [info], backup_info: backupPackage ? [info] : [] } };
      }
      else { assert.deepEqual(body, { obj_name: "123456789/987654321/0" }); result = { code: 0, result: { url: "https://cnbj1.fds.api.xiaomi.com/map" } }; }
      return new Response(cloudRc4(signed, Buffer.from(JSON.stringify(result))).toString("base64"));
    }
    if (url.pathname === "/map") {
      assert.equal(options.headers, undefined, "no cloud cookie or auth header may reach map storage");
      if (mapRedirect) return new Response(null, { status: 302, headers: { location: mapRedirect } });
      return new Response(mapBlob ? new Uint8Array(mapBlob) : "actual-test-map-file", { headers: hugePackage ? {"content-length":"67108865"} : oversized ? { "content-length": "16777217" } : {} });
    }
    throw new Error("unexpected endpoint");
  }) as typeof fetch;
  return { directory, requests, setPositionResponse:(value:unknown)=>{positionResponse=value;}, setPageOutput:(value:unknown)=>{pageOutput=value;}, setMap:(raw:Buffer)=>{mapBlob=raw;model="xiaomi.vacuum.pv11cn";}, videoActions, videoFixture: (result="0", wrongDevice=false) => {videoMode=true;model="xiaomi.vacuum.pv11cn";pinResult=result;mismatch=wrongDevice;}, cloud: new XiaomiVacuumCloud(directory, fetchImpl, secretProtector), setModel: (value: string) => {model=value;}, setTrajectoryResponse: (value:unknown) => {trajectoryResponse=value;}, setRedirect: (url: string) => { mapRedirect = url; }, setOversized: () => { oversized = true; }, setBackupPackage: () => { backupPackage = true; }, setHugePackage: () => {hugePackage = true;}, setBadLoginRedirect: () => { loginBadRedirect = true; }, fetchImpl };
}

test("telemetry reads fixed device properties with the existing account and never sends actions", async () => {
 const f=fixture();
 try {
  const login:any=await f.cloud.begin("telemetry-read-test-01");await f.cloud.poll(login.sessionId);
  await assert.rejects(f.cloud.telemetry("987654321","cn"),/verified telemetry/);
  f.setModel("xiaomi.vacuum.pv11cn");
  await assert.rejects(f.cloud.telemetry("999","cn"),/not in/);
  const value=await f.cloud.telemetry("987654321","cn");
  assert.equal(value.statusCode,8);assert.equal(value.status,"remote");assert.equal(value.faultCode,0);
  assert.equal(value.locating,false);assert.equal(value.lidar,"top");assert.equal(value.coordinateNavigation,false);
  assert.equal(value.deviceUpdateTime,"unverified");
  assert.ok(!JSON.stringify(value).includes("never-return-this"));
  assert.equal(f.requests.filter(r=>r.url.pathname.endsWith("miotspec/action")).length,0);
 }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});

test("position queries bypass cloud cache, preserve absence and reject foreign identity without inventing current coordinates", async () => {
 const f=fixture();
 try {
  const login:any=await f.cloud.begin("position-read-test-01");await f.cloud.poll(login.sessionId);f.setModel("xiaomi.vacuum.pv11cn");
  const empty=await f.cloud.position("987654321","cn");assert.equal(empty.state,"unavailable");assert.equal(empty.position,undefined);assert.equal(empty.coordinateNavigation,false);
  f.setPositionResponse({code:0,result:[{did:"987654321",siid:10,piid:4,code:0,value:'{"x":100,"y":-200,"yaw":3141,"secret":"not-returned"}'}]});
  const sample=await f.cloud.position("987654321","cn");assert.deepEqual(sample.position,{x:100,y:-200,yaw:3141});assert.equal(sample.poseFreshness,"unverified");assert.equal(sample.coordinateUnit,"unverified");assert.ok(!JSON.stringify(sample).includes("not-returned"));
  f.setPositionResponse({code:0,result:[{did:"wrong",siid:10,piid:4,code:0,value:""}]});await assert.rejects(f.cloud.position("987654321","cn"),/mismatched/);
  for (const property of [{siid:11,piid:4,code:0}, {siid:10,piid:5,code:0}, {siid:10,piid:4,code:-1}]) {
   f.setPositionResponse({code:0,result:[{did:"987654321",value:"",...property}]});
   await assert.rejects(f.cloud.position("987654321","cn"), /mismatched|rejected/);
  }
  f.setPositionResponse({code:0,result:[{did:"987654321",siid:10,piid:4,code:0,value:'private-bad-json'}]});await assert.rejects(f.cloud.position("987654321","cn"),error=>error instanceof Error&&error.message.includes("invalid_json")&&!error.message.includes("private-bad-json"));
  await assert.rejects(f.cloud.position("999","cn"),/not in/);f.setModel("xiaomi.vacuum.test1");await assert.rejects(f.cloud.position("987654321","cn"),/verified position/);
  assert.equal(f.requests.filter(r=>r.url.pathname.endsWith("miotspec/action")).length,0);
 } finally {fs.rmSync(f.directory,{recursive:true,force:true});}
});

test("video verifies the existing PIN before one enter and pairs one exit without storing or resetting it", async () => {
 const f=fixture();
 try {
  const login:any=await f.cloud.begin("video-pin-test-0001");await f.cloud.poll(login.sessionId);f.videoFixture();
  const provision=await (f.cloud as any).videoSource("987654321","cn","4821");
  assert.deepEqual(f.videoActions.map(a=>({aiid:a.aiid,in:a.in})),[{aiid:7,in:["4821"]},{aiid:4,in:["3"]}]);
  assert.equal(new URL(provision.source).searchParams.get("audio"),"0");
  // Random hexadecimal key material may coincidentally contain the four PIN digits.
  const videoUrl=new URL(provision.source);
  assert.equal(videoUrl.password,"");assert.equal(videoUrl.username,"");
  assert.deepEqual([...videoUrl.searchParams.keys()].sort(),["audio","client_private","client_public","device_public","model","sign","subtype","vendor"]);
  await provision.release();await provision.release();
  assert.deepEqual(f.videoActions.at(-1).in,["4"]);assert.equal(f.videoActions.length,3);
  assert.ok(!fs.readFileSync(path.join(f.directory,"vacuum-cloud-session.json"),"utf8").includes("4821"));
 }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});

test("wrong PIN or mismatched video receipt never enters the page or requests MISS keys", async () => {
 const f=fixture();
 try {
  const login:any=await f.cloud.begin("video-pin-test-0002");await f.cloud.poll(login.sessionId);f.videoFixture("-1");
  await assert.rejects((f.cloud as any).videoSource("987654321","cn","4821"),/密码不正确/);
  f.videoFixture("0",true);await assert.rejects((f.cloud as any).videoSource("987654321","cn","4821"),/回执无法确认/);
  assert.ok(f.videoActions.every(a=>a.aiid===7));assert.equal(f.requests.filter(r=>r.url.pathname.endsWith("miss_get_vendor")).length,0);
 }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});

test("trajectory uses only the verified query and reports returned points without claiming current localization", async () => {
  const f = fixture();
  try {
    const login: any = await f.cloud.begin("trajectory-test-key-01"); await f.cloud.poll(login.sessionId);
    await assert.rejects(f.cloud.trajectory("987654321", "cn", "1"), /verified read-only/);
    f.setModel("xiaomi.vacuum.pv11cn");
    await assert.rejects(f.cloud.trajectory("123", "cn", "1"), /connected cloud account/);
    for (const poseId of ["", "-1", "1.5", "2147483648"]) await assert.rejects(f.cloud.trajectory("987654321", "cn", poseId), /poseId/);
    assert.equal(f.requests.filter(r=>r.url.pathname.endsWith("miotspec/action")).length, 0);
    const data: any = await f.cloud.trajectory("987654321", "cn", "1");
    assert.deepEqual(data.points, [{poseId:1,x:100,y:-200},{poseId:2,x:150,y:-200,yaw:12}]);
    assert.equal(data.nextPoseId,2); assert.equal(data.newPointCount,1);
    assert.equal(data.poseFreshness,"unverified"); assert.equal(data.coordinateNavigation,false);
    assert.ok(!JSON.stringify(data).includes("Token") && !JSON.stringify(data).includes("never-return-this"));
    f.setTrajectoryResponse({code:0,result:{did:"987654321",siid:2,aiid:47,code:0,out:[{piid:24,value:'{"points":[]}'}]}});
    const empty: any = await f.cloud.trajectory("987654321", "cn", "1");
    assert.equal(empty.nextPoseId,1); assert.equal(empty.latestReturnedPoint,undefined);
    f.setTrajectoryResponse({code:0,result:{did:"987654321",siid:2,aiid:47,code:-704042011}});
    await assert.rejects(f.cloud.trajectory("987654321", "cn", "1"), /rejected/);
    f.setTrajectoryResponse({code:0,result:{did:"different-device",siid:2,aiid:47,code:0,out:['{"points":[]}']}});
    await assert.rejects(f.cloud.trajectory("987654321", "cn", "1"), /mismatched/);
    f.setTrajectoryResponse({code:0,result:{did:"987654321",siid:2,aiid:47,code:0,out:['{"points":[{"pose_id":1,"x":"150","y":0}]}']}});
    await assert.rejects(f.cloud.trajectory("987654321", "cn", "1"), /invalid bounded/);
  } finally {fs.rmSync(f.directory,{recursive:true,force:true});}
});

test("QR login keeps protected provider session, replays once and downloads redacted map through encrypted calls", async () => {
  const f = fixture();
  try {
    const [first, replay]: any[] = await Promise.all([f.cloud.begin("login-test-key-0001"), f.cloud.begin("login-test-key-0001")]);
    assert.deepEqual(first, replay); assert.match(first.imageDataUrl, /^data:image\/png/);
    assert.equal(f.requests.filter(r => r.url.pathname === "/longPolling/loginUrl").length, 1);
    const state: any = await f.cloud.poll(first.sessionId); assert.equal(state.state, "connected"); assert.equal(state.imageDataUrl, undefined);
    const file = fs.readFileSync(path.join(f.directory, "vacuum-cloud-session.json"), "utf8");
    assert.ok(!file.includes("test-secret-token") && !file.includes(security));
    const devices = await f.cloud.devices(); assert.equal(devices.length, 1); assert.ok(!JSON.stringify(devices).includes("never-return-this"));
    const map: any = await f.cloud.map("987654321"); assert.equal(Buffer.from(map.blobBase64, "base64").toString(), "actual-test-map-file"); assert.equal(map.coordinateNavigation, false);
    const restored = new XiaomiVacuumCloud(f.directory, f.fetchImpl, protector); assert.equal((restored.status() as any).connected, true);
    await assert.rejects(restored.begin("login-test-key-0001"), /no longer in memory/);
    assert.equal((await restored.map("987654321") as any).sha256, map.sha256);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("map requires account device match and bounds bytes and all redirects", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.cloud.devices(), /QR login first/);
    const login: any = await f.cloud.begin("login-test-key-0002"); await f.cloud.poll(login.sessionId);
    await assert.rejects(f.cloud.map("123"), /not in the connected cloud account/);
    await assert.rejects(f.cloud.devices("bad-region"), /supported Mi Home region/);
    f.setRedirect("https://127.0.0.1/secrets"); await assert.rejects(f.cloud.map("987654321"), /HTTPS service domains/);
    f.setRedirect(""); f.setOversized(); await assert.rejects(f.cloud.map("987654321"), /size limit/);
    assert.ok(f.requests.every(r => r.url.hostname !== "127.0.0.1"));
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("official package inspection checks device ownership and strips download credentials", async () => {
  const f = fixture();
  try {
    const login: any = await f.cloud.begin("plugin-test-key-0001"); await f.cloud.poll(login.sessionId);
    await assert.rejects(f.cloud.pluginPackage("123"), /not in the connected cloud account/);
    const data: any = await f.cloud.pluginPackage("987654321");
    assert.equal(data.packageId, 20);
    const information = await f.cloud.pluginInformation("987654321");
    assert.equal(information.latestInfo[0]?.hasDownload, true);
    assert.ok(!JSON.stringify(information).includes("https:") && !JSON.stringify(information).includes("test-secret-token"));
    await assert.rejects(f.cloud.pluginInformation("987654321", "cn", 9999), /SDK version/);
    f.setBackupPackage();
    assert.equal((await f.cloud.pluginInformation("987654321")).backupInfo[0]?.hasDownload, true);
    assert.equal((await f.cloud.pluginPackage("987654321") as any).packageId, 20);
    f.setHugePackage();
    await assert.rejects(f.cloud.pluginPackage("987654321"), /size limit/);
    assert.equal(Buffer.from(data.packageBase64, "base64").toString(), "actual-test-map-file");
    assert.equal(data.sha256, createHash("sha256").update("actual-test-map-file").digest("hex"));
    assert.ok(!JSON.stringify(data).includes("download_url") && !JSON.stringify(data).includes("serviceToken"));
    f.setRedirect("https://127.0.0.1/package");
    await assert.rejects(f.cloud.pluginPackage("987654321"), /HTTPS service domains/);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("login rejects off-domain redirects before credentials are persisted", async () => {
  const f = fixture();
  try {
    f.setBadLoginRedirect(); const login: any = await f.cloud.begin("login-test-key-0003");
    await assert.rejects(f.cloud.poll(login.sessionId), /HTTPS service domains/);
    assert.equal((f.cloud.status() as any).connected, false);
    assert.ok(!fs.existsSync(path.join(f.directory, "vacuum-cloud-session.json")));
    assert.ok(f.requests.every(r => r.url.hostname !== "untrusted.invalid"));
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("concurrent map readers share one download and subsequent reads fetch again", async () => {
  const f = fixture();
  try {
    const login: any = await f.cloud.begin("login-test-key-0004"); await f.cloud.poll(login.sessionId);
    const [a, b] = await Promise.all([f.cloud.map("987654321"), f.cloud.map("987654321")]);
    assert.deepEqual(a, b);
    assert.equal(f.requests.filter(r => r.url.pathname === "/map").length, 1);
    await f.cloud.map("987654321");
    assert.equal(f.requests.filter(r => r.url.pathname === "/map").length, 2);
    f.setRedirect("https://untrusted.invalid/file");
    await assert.rejects(f.cloud.map("987654321"));
    f.setRedirect(""); await f.cloud.map("987654321");
    assert.equal(f.requests.filter(r => r.url.pathname === "/map").length, 4);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});


test("path previews use owned fresh maps, reject stale hashes and never call device actions", async()=>{
 const f=fixture();try {
  const login:any=await f.cloud.begin("path-preview-test-01");await f.cloud.poll(login.sessionId);
  const map={map_id:1,width:30,height:30,origin_x:0,origin_y:0,resolution:100,rotate:0,position:{x:850,y:1550},
   map_data:deflateSync(Buffer.alloc(900,3)).toString("base64"),additional_map_data:deflateSync(Buffer.alloc(900)).toString("base64")};
  const iv=Buffer.from("ABCDEF1234123412"),key=Buffer.from("xiaomi.vacuum.pv11cn".slice(-16));
  const derive=createCipheriv("aes-128-cbc",key,iv),material=Buffer.concat([derive.update(Buffer.concat([key,Buffer.from("987654321")])),derive.final()]);
  const cipher=createCipheriv("aes-128-cbc",createHash("md5").update(material).digest(),iv);
  const blob=Buffer.from(JSON.stringify({version:2,data:Buffer.concat([cipher.update(deflateSync(Buffer.from(JSON.stringify(map)))),cipher.final()]).toString("base64")}));f.setMap(blob);
  const hash=createHash("sha256").update(blob).digest("hex");
  await assert.rejects(f.cloud.path("999","cn","0",hash,"2150","1550"),/connected cloud account/);
  await assert.rejects(f.cloud.path("987654321","cn","0","0".repeat(64),"2150","1550"),/map changed/);
  await assert.rejects(f.cloud.path("987654321","cn","0",hash,"1e3","1550"),/finite millimeter/);
  const p=await f.cloud.path("987654321","cn","0",hash,"2150","1550");assert.equal(p.mapSha256,hash);assert.equal(p.movementCommandsSent,0);
  assert.ok(!JSON.stringify(p).includes("blobBase64"));assert.equal(f.requests.filter(r=>r.url.pathname.endsWith("miotspec/action")).length,0);
 }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});


test("verified remembered PIN survives provider restart, stays encrypted, and forget replay preserves replacement", async () => {
 const f = fixture(true);
 try {
  const login:any=await f.cloud.begin("video-save-test-0001"); await f.cloud.poll(login.sessionId); f.videoFixture();
  const first=await (f.cloud as any).videoSource("987654321","cn","4821",true); await first.release();
  assert.deepEqual(f.cloud.videoPasswordStatus("987654321"),{saved:true});
  const root=path.join(f.directory,"vacuum-video-passwords"), file=path.join(root,fs.readdirSync(root)[0]!);
  const saved=JSON.parse(fs.readFileSync(file,"utf8"));
  assert.equal(saved.protection,process.platform==="win32"?"windows-dpapi-current-user":"local-aes-256-gcm-v1");
  assert.notEqual(saved.protectedPassword,"4821");
  assert.deepEqual(Object.keys(saved).sort(),["schemaVersion","protection","protectedPassword"].sort());
  const restarted=new XiaomiVacuumCloud(f.directory,f.fetchImpl);
  const next=await (restarted as any).videoSource("987654321","cn"); await next.release();
  assert.deepEqual(f.videoActions.filter(a=>a.aiid===7).map(a=>a.in),[["4821"],["4821"]]);
  assert.equal(restarted.videoPasswordStatus("987654321","de").saved,false);
  (restarted as any).session={...(restarted as any).session,userId:"222"};
  assert.equal(restarted.videoPasswordStatus("987654321").saved,false);
  (restarted as any).session={...(restarted as any).session,userId:"123456789"};
  const key="video-forget-test-0001";
  assert.equal(restarted.forgetVideoPassword("987654321","cn",key).state,"completed");
  assert.equal(restarted.videoPasswordStatus("987654321").saved,false);
  const replacement=await (restarted as any).videoSource("987654321","cn","3952",true); await replacement.release();
  restarted.forgetVideoPassword("987654321","cn",key);
  assert.equal(restarted.videoPasswordStatus("987654321").saved,true,"old deletion cannot remove replacement");
  assert.throws(()=>restarted.forgetVideoPassword("987654321","de",key),/another device/);
 } finally { fs.rmSync(f.directory,{recursive:true,force:true}); }
});

test("rejected or unconfirmed PIN never gets remembered",async()=>{
 const f=fixture();try {
  const login:any=await f.cloud.begin("video-save-test-0002");await f.cloud.poll(login.sessionId);
  for(const value of ["-1","unknown"]) {
   f.videoFixture(value);await assert.rejects((f.cloud as any).videoSource("987654321","cn","4821",true));
   assert.equal(f.cloud.videoPasswordStatus("987654321").saved,false);
  }
 }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});


test("no-output video page acknowledgements allow empty or omitted output but retain identity checks",async()=>{
 const f=fixture();try {
  const login:any=await f.cloud.begin("video-page-empty-0001");await f.cloud.poll(login.sessionId);f.videoFixture();
  for(const output of [undefined,null,"",[]]) {
   f.setPageOutput(output);const provision=await (f.cloud as any).videoSource("987654321","cn","4821");await provision.release();
  }
  for(const output of ["unexpected",["unexpected"],{}]) {
   f.setPageOutput(output);await assert.rejects((f.cloud as any).videoSource("987654321","cn","4821"),/回执无法确认/);
  }
  f.setPageOutput(undefined);f.videoFixture("0",true);await assert.rejects((f.cloud as any).videoSource("987654321","cn","4821"),/回执无法确认/);
 }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});


test("video network diagnostics use account ownership without PIN, MISS material or page actions",async()=>{
 const f=fixture();try {
  const login:any=await f.cloud.begin("video-network-test-0001");await f.cloud.poll(login.sessionId);f.videoFixture();
  const result=await f.cloud.videoNetwork("987654321");assert.equal(result.localAddress,"192.168.1.100");assert.equal(typeof result.onLinkInterfacePresent,"boolean");
  await assert.rejects(f.cloud.videoNetwork("123"),/owned vacuum/);
  assert.equal(f.videoActions.length,0);assert.ok(!f.requests.some(r=>r.url.pathname.endsWith("miss_get_vendor")));
  assert.ok(!JSON.stringify(result).includes("token"));
 }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});

test("video retains verified cloud relay material on and off the device subnet",async(t)=>{
 let interfaces:ReturnType<typeof os.networkInterfaces>={};
 t.mock.method(os,"networkInterfaces",()=>interfaces);
 const params={p2p_id:"ABCDEF-123456-GHIJK",init_string:"EBGBEPBPKGJKHOJOELGHEKEKHLMFHLNCGKELBICIBJIILILDCABCCGODHBKHJFKGBGNLLHCMPHNOAEDHICMMIEBANPOLBD"};
 for(const onLink of [false,true]) {
 interfaces=onLink?{LAN:[{address:"192.168.1.89",netmask:"255.255.255.0",family:"IPv4",mac:"00:00:00:00:00:00",internal:false,cidr:"192.168.1.89/24"}]}:{};
 const f=fixture(false,params);try {
  const login:any=await f.cloud.begin("video-relay-test-0001");await f.cloud.poll(login.sessionId);f.videoFixture();
  assert.equal((await f.cloud.videoNetwork("987654321","cn")).onLinkInterfacePresent,onLink);
  const provision=await (f.cloud as any).videoSource("987654321","cn","4821");
  const url=new URL(provision.source);assert.equal(url.searchParams.get("cs2_peer"),params.p2p_id);
  assert.equal(url.searchParams.get("cs2_servers"),"104.166.181.58,169.197.116.186,169.197.116.216");
  assert.equal(url.searchParams.get("audio"),"0");await provision.release();
 }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
 }
 const bad=fixture(false,{...params,init_string:"bad"});try {
  const login:any=await bad.cloud.begin("video-relay-test-0002");await bad.cloud.poll(login.sessionId);bad.videoFixture();
  await assert.rejects((bad.cloud as any).videoSource("987654321","cn","4821"),/中继参数无法确认/);
  assert.deepEqual(bad.videoActions.map(a=>a.aiid),[7,4,4]);
 }finally{fs.rmSync(bad.directory,{recursive:true,force:true});}
});
