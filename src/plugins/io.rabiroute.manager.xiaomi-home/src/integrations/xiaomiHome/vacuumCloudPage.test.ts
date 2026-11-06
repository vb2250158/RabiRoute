import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { vacuumCloudConnectPage } from "./vacuumCloudPage.js";

function fixture(mapData?: Record<string, unknown>, pathReply?: Promise<unknown>, feedbackData?: (read: number) => Record<string, unknown>) {
 const nodes = new Map<string, any>();
 const fills:unknown[]=[],urls:string[]=[],ctx:any={fillRect(){fills.push(ctx.fillStyle);}};
 const context2d = new Proxy(ctx, { get: (t,k) => k in t ? t[k] : () => {} });
 const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, { value: id === "region" ? "cn" : id === "interval" ? "5" : "test-device", hidden: false, textContent: "", style: {}, clientWidth: 400, clientHeight: 300, append() {}, replaceChildren() {}, getContext: () => context2d, getBoundingClientRect() { return {left:10,top:20,width:parseFloat(this.style.width),height:parseFloat(this.style.height)}; } }); return nodes.get(id); };
 const timers = new Map<number, () => unknown>(); let next = 0, reads = 0, reject = false;
 const document: any = { hidden: false, getElementById: node, createElement: () => ({ append() {} }), addEventListener(name: string, cb: () => unknown) { this[name] = cb; } };
 const window: any = { addEventListener(name: string, cb: () => unknown) { this[name] = cb; } };
 const fakeURL = Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL() {} });
 const context = vm.createContext({ document, window, location: { pathname: "/api/agent/xiaomi-home/vacuum-cloud/connect" }, URL: fakeURL, URLSearchParams, Blob, Uint8Array, AbortSignal, Date, Number, JSON, atob, console,
  setTimeout(cb: () => unknown) { const id = ++next; timers.set(id, cb); return id; }, clearTimeout(id: number) { timers.delete(id); },
  fetch: async (url: string) => { urls.push(url);if(url.includes("/path?"))return {ok:true,json:async()=>({code:0,data:await pathReply})};if (url.endsWith("/status")) return { ok: true, json: async () => ({ code: 0, data: { connected: false } }) };
   reads++; if (reject) throw Error("cloud unreachable"); return { ok: true, json: async () => ({ code: 0, data: {
    map: { decoded: false, blobBase64: "dGVzdA==", sha256: "unchanged", observedAt: new Date().toISOString(), ...mapData },
    feedback: {state:"sample",scope:"a".repeat(64),nextPoseId:reads,newPointCount:reads===1?1:0,observedAt:new Date().toISOString(),...feedbackData?.(reads)}
   } }) }; }
 });
 const script = vacuumCloudConnectPage("test-nonce").match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/)![1]!;
 new vm.Script(script).runInContext(context);
 return { node, document, window, fills, urls, timers, reads: () => reads, fail: () => { reject = true; }, async tick() { const first = timers.entries().next().value!; timers.delete(first[0]); await first[1](); } };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("auto rendering refresh is opt-in, serial, pausable and recognizes unchanged files", async () => {
 const f = fixture(); await settle(); assert.equal(f.reads(), 0);
 await f.node("live").onclick(); await settle(); assert.equal(f.reads(), 1); assert.equal(f.timers.size, 1);
 await f.tick(); assert.equal(f.reads(), 2); assert.match(f.node("freshness").textContent, /未变化/);
 assert.match(f.node("feedback").textContent, /没有新增轨迹点.*定位时间未验证/);
 const query=new URL(f.urls.at(-1)!,"http://localhost").searchParams;
 assert.equal(query.get("scope"),"a".repeat(64));assert.equal(query.get("poseId"),"1");
 f.node("live").onclick(); assert.equal(f.timers.size, 0); assert.match(f.node("live").textContent, /开启/);
});

test("trajectory movement redraws an unchanged map while repeated positions do not", async () => {
 const f=fixture({decoded:true,grid:{width:4,height:2,originX:0,originY:0,resolution:50,mapId:9,dataBase64:"AwMDAwMDAwM="},map:{},rooms:[]},undefined,
   read=>({position:{poseId:read<3?1:2,x:read<3?50:100,y:50,yaw:0}}));
 await settle();await f.node("map").onclick();const first=f.fills.length;
 await f.node("map").onclick();assert.equal(f.fills.length,first);
 await f.node("map").onclick();assert.ok(f.fills.length>first);
 assert.match(f.node("freshness").textContent,/未变化/);
});

test("switching devices clears the feedback continuation rather than reusing another task", async () => {
 const f=fixture();await settle();await f.node("map").onclick();
 f.node("device").value="another-device";f.node("device").onchange();await f.node("map").onclick();
 const query=new URL(f.urls.at(-1)!,"http://localhost").searchParams;
 assert.equal(query.get("deviceId"),"another-device");assert.equal(query.has("scope"),false);
 assert.equal(query.has("poseId"),false);
});

test("hidden page suspends updates; visibility resumes and page exit stops", async () => {
 const f = fixture(); await settle(); f.node("live").onclick(); await settle();
 f.document.hidden = true; f.document.visibilitychange(); assert.equal(f.timers.size, 0);
 assert.match(f.node("freshness").textContent, /页面隐藏/);
 f.document.hidden = false; f.document.visibilitychange(); await settle(); assert.equal(f.reads(), 2);
 f.window.pagehide(); assert.equal(f.timers.size, 0);
});

test("three read failures stop refresh rather than replaying indefinitely", async () => {
 const f = fixture(); await settle(); f.fail(); f.node("live").onclick(); await settle();
 await f.tick(); await f.tick(); assert.equal(f.reads(), 3); assert.equal(f.timers.size, 0);
 assert.match(f.node("freshness").textContent, /自动刷新已暂停/);
});

test("the whole map fits the viewport and zoom/resize preserve native point coordinates", async () => {
 const f = fixture({decoded:true,grid:{width:4,height:2,originX:1000,originY:2000,resolution:50,mapId:9,dataBase64:"AwMDAwMDAwM="},map:{},rooms:[]});
 await settle(); await f.node("map").onclick();
 const canvas=f.node("mapview");
 assert.equal(canvas.style.width,"400px");assert.equal(canvas.style.height,"200px");
 const selectCenter=()=>canvas.onclick({clientX:10+parseFloat(canvas.style.width)/2,clientY:20+parseFloat(canvas.style.height)/2});
 selectCenter();assert.match(f.node("point").textContent,/\(1100, 2050\).*地图 9/);
 f.node("zoom-in").onclick();assert.equal(canvas.style.width,"500px");selectCenter();assert.match(f.node("point").textContent,/\(1100, 2050\)/);
 f.node("mapstage").clientWidth=100;f.window.resize();f.node("fit").onclick();
 assert.equal(canvas.style.width,"100px");assert.equal(canvas.style.height,"50px");selectCenter();assert.match(f.node("point").textContent,/\(1100, 2050\)/);
});


test("verified cell colors and map-click preview share the displayed hash; hidden pages discard replies",async()=>{
 let resolve!:(p:unknown)=>void;const pending=new Promise(r=>{resolve=r;});
 const f=fixture({decoded:true,sha256:"a".repeat(64),grid:{width:4,height:2,originX:1000,originY:2000,resolution:50,mapId:9,dataBase64:Buffer.from([1,2,255,3,3,3,3,3]).toString("base64"),additionalDataBase64:Buffer.from([0,0,0,1,2,8,0,0]).toString("base64"),cellSemanticsVerified:true,labels:{wall:[1],floor:[2],roomGridRange:[3,255],additionalBits:{hidden:1,unreachable:2,carpet:4,object:8}}},map:{},rooms:[]},pending);
 await settle();await f.node("map").onclick();
 assert.deepEqual(f.fills.slice(1,7),["#3a4654","#e1e5ea","#deedf9","#aab3bf","#b9a6a6","#5d6c80"]);
 const click=f.node("mapview").onclick({clientX:210,clientY:120});await settle();
 const query=new URL(f.urls.find(u=>u.includes("/path?"))!,"http://localhost").searchParams;
 assert.equal(query.get("mapHash"),"a".repeat(64));assert.equal(query.get("targetX"),"1100");assert.equal(query.get("targetY"),"2050");
 f.document.hidden=true;resolve({waypoints:[{x:1100,y:2050}],target:{x:1100,y:2050},lengthMm:123,clearanceMm:250});await click;
 assert.match(f.node("point").textContent,/路径预览，不移动/);assert.ok(!f.node("point").textContent.includes("0.12"));
});
