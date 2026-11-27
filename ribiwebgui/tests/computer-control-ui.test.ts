import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import { transformSync } from "esbuild";
import { ComputerControlClient } from "../../src/plugins/io.rabiroute.manager.core/web/computer/computerControlClient";
import { RemoteTerminalClient } from "../src/remoteTerminalClient";
import * as i18n from "../src/i18n/index";
import { englishCatalog } from "../src/i18n/catalog";
import { pluginTranslations as coreTranslations } from "../../src/plugins/io.rabiroute.manager.core/web/translations";
import { registerPluginTranslations } from "../src/i18n/translationRegistry";
import { after } from "node:test";
const releaseTranslations=registerPluginTranslations("io.rabiroute.manager.core",coreTranslations);after(releaseTranslations);
import { japaneseCatalog } from "../src/i18n/japaneseCatalog";
import * as state from "../../src/plugins/io.rabiroute.manager.core/web/computer/computerControlState";
import * as presentation from "../../src/plugins/io.rabiroute.manager.core/web/computer/computerControlPresentation";
import { computerSettingsSchema, DEFAULT_COMPUTER_SETTINGS, COMPUTER_ACTIONS, computerActionDefinition, isComputerReadOnlyAction } from "../../src/shared/agentInteractiveProtocol";
import { drawingObject, drawingPoint, windowPreviewPointers } from "../../src/plugins/io.rabiroute.manager.core/web/computer/computerControlDrawing";
import * as phoneFeedback from "../../src/plugins/io.rabiroute.manager.core/web/computer/phoneScreenFeedback";
function fixture(t:import("node:test").TestContext, blockedCapture=false) {
 const component=new URL("../../src/plugins/io.rabiroute.manager.core/web/computer/ComputerControlRow.vue",import.meta.url);const require=createRequire(component);const vue=require("vue");const cleanup:Array<()=>void>=[];const calls:Record<string,unknown>[]=[];const saves:Record<string,unknown>[]=[];
 let resolveCapture!:(value:Record<string,unknown>)=>void;const captured=new Promise<Record<string,unknown>>(yes=>resolveCapture=yes);let settings=structuredClone(DEFAULT_COMPUTER_SETTINGS);
 const client={settings:async()=>({settings:structuredClone(settings),etag:'"v1"',schema:computerSettingsSchema}),saveSettings:async(_target:unknown,patch:Record<string,unknown>)=>{saves.push(patch);settings={...settings,...patch,features:{...settings.features,...patch.features as object}};return {settings:structuredClone(settings),etag:'"v2"',schema:computerSettingsSchema};},action:async(_target:unknown,body:Record<string,unknown>)=>{calls.push(body);if(body.action==="screen.capture"&&blockedCapture)return captured;if(body.action==="control.begin")return {state:"active",controlSessionId:"same-control",source:{label:"手动控制"}};if(body.action==="input.execute")throw new Error("uncertain connection");return {state:"absent"};}};
 const eventListeners=new Set<()=>void>();
 const props=vue.reactive({events:{subscribe:(_target:unknown,callback:()=>void)=>{eventListeners.add(callback);return ()=>eventListeners.delete(callback);}},target:{id:"stable",instanceId:"local",name:"电脑",kind:"host",local:true,status:"online",capabilities:["files","windows","screenshots","input","annotation","tracking"],terminalShells:["cmd"]},expanded:false,active:true,client});
 const code=transformSync(compileScript(parse(fs.readFileSync(component,"utf8")).descriptor,{id:"computer-row"}).content,{loader:"ts",format:"cjs"}).code;const module={exports:{} as any};
 vm.runInNewContext(code,{module,exports:module.exports,structuredClone,AbortController,queueMicrotask,Set,Map,Date,console,require(name:string){if(name==="vue")return {...vue,onBeforeUnmount:(fn:()=>void)=>cleanup.push(fn)};if(name.endsWith("/i18n/index"))return i18n;if(name==="@shared/agentInteractiveProtocol")return {COMPUTER_ACTIONS,computerActionDefinition,isComputerReadOnlyAction};if(name==="./computerControlState")return state;if(name==="./computerControlPresentation")return presentation;if(name.endsWith("browserUuid"))return {browserUuid:()=>"fixture-request"};if(name.endsWith("managerApi"))return {managerAccessToken:()=>"fixture-token"};if(name.endsWith("userFacingError"))return {userFacingError:(error:Error)=>error.message};if(name.endsWith(".vue"))return {__esModule:true,default:vue.defineComponent({props:{disabled:Boolean},setup(props:any){return ()=>vue.h("div",{"data-computer-component":name.split("/").pop(),"data-disabled":String(props.disabled)});}})};return require(name);}});
 const scope=vue.effectScope();const model=scope.run(()=>module.exports.default.setup(props,{expose(){},emit(){}}));const dispose=()=>{for(const fn of cleanup)fn();scope.stop();};t.after(dispose);const flush=async()=>{await vue.nextTick();await new Promise(yes=>setImmediate(yes));};return {props,model,calls,saves,resolveCapture,flush,dispose,notify:()=>eventListeners.forEach(callback=>callback()),eventListeners,vue};
}
test("expansion restores only settings and original read-only work; collapse does not launch or stop work",async t=>{
 const f=fixture(t);assert.equal(f.calls.length,0);f.props.expanded=true;await f.flush();assert.deepEqual(f.calls.map(call=>call.action),["control.status","annotation.status"]);f.props.expanded=false;await f.flush();assert.equal(f.calls.length,2);assert.equal(f.saves.length,0);
});
test("manual begin is explicit; unknown input preserves original request ID for status and never repeats input",async t=>{
 const f=fixture(t);await f.model.run({action:"control.begin",captureAfter:false});assert.equal(f.model.sessionId.value,"same-control");await f.model.run({action:"input.execute",actions:[{type:"text",text:"fixture"}]});const id=f.model.inputRequestId.value;assert.equal(id,"fixture-request");await f.model.run({action:"input.status",requestId:id});assert.equal(f.calls.filter(call=>call.action==="input.execute").length,1);assert.equal(f.calls.at(-1)?.requestId,id);assert.equal(f.calls.at(-1)?.action,"input.status");
});
test("window and controller switches are independent of foreground input and visible under their target groups",async t=>{
 const f=fixture(t);
 f.props.target.capabilities.push("windowActivation","backgroundCapture","backgroundInput","gamepad");
 f.props.expanded=true;await f.flush();
 assert.equal(f.model.features.value.windowActivation,true);
 assert.equal(f.model.features.value.backgroundCapture,true);
 assert.equal(f.model.features.value.backgroundInput,true);
 assert.equal(f.model.features.value.gamepad,true);
 const html=await renderRow(f);
 for(const label of ["前台共享键鼠","指定窗口","切换前台窗口","后台窗口截图","后台窗口输入","独立输入设备","独立玩家手柄"]) assert.ok(html.includes(label),label);
 f.model.edit(["features","backgroundInput"],false);await f.flush();
 assert.equal(f.model.features.value.backgroundInput,false);
 assert.equal(f.model.features.value.input,true);
 assert.equal(f.model.features.value.backgroundCapture,true);
 assert.deepEqual(f.saves,[{features:{backgroundInput:false}}]);
 await f.model.run({action:"windows.activate",windowId:"abc",pid:42});
 assert.equal(f.calls.at(-1)?.requestId,"fixture-request");
});
test("turning observation off clears the displayed frame and drops an old capture without altering input receipt",async t=>{
 const f=fixture(t,true);f.props.expanded=true;await f.flush();const capturing=f.model.run({action:"screen.capture"});f.model.edit(["features","observation"],false);await f.flush();f.resolveCapture({mimeType:"image/png",data:"fixture",width:10,height:10});await capturing;assert.equal(f.model.image.value,undefined);assert.equal(f.model.busy.value,"");assert.deepEqual(f.saves,[{features:{observation:false}}]);
});
test("dispose ignores late picture and preserves accepted work at target",async t=>{
 const f=fixture(t,true);const capture=f.model.run({action:"screen.capture"});f.dispose();f.resolveCapture({mimeType:"image/png",data:"fixture"});await capture;assert.equal(f.model.image.value,undefined);assert.deepEqual(f.calls.map(call=>call.action),["screen.capture"]);
});
test("tracking stop, annotation clear and input exit retain independent original identifiers",async t=>{
 const f=fixture(t);f.model.tracking.value={trackingId:"tracking",layerId:"layer",state:"running"};f.model.layer.value={layerId:"layer",state:"visible"};f.model.control.value={controlSessionId:"control",state:"active"};await f.model.stopTracking();await f.flush();await f.model.clearLayer();await f.flush();await f.model.endControl();await f.flush();assert.deepEqual(f.calls.map(call=>call.action),["annotation.track.stop","annotation.clear","control.end"]);assert.equal(f.calls[0]?.trackingId,"tracking");assert.equal(f.calls[1]?.layerId,"layer");assert.equal(f.calls[2]?.controlSessionId,"control");
});
test("device status names observation and input sessions with a stop button for the original input", async t => {
 const f = fixture(t);
 f.props.expanded = true;
 await f.flush();
 f.model.control.value = { state: "absent", activity: { phase: "prepared", observerLabel: "观察会话", activities: [
  { id: "background-batch", label: "输入会话", mode: "background", phase: "operating", windowTitle: "目标窗口", canStop: true },
  { id: "capture", label: "另一观察会话", mode: "observation", phase: "prepared", canStop: false }
 ] } };
 const html = await renderRow(f);
 assert.match(html, /观察会话 正在看你的屏幕/);
 assert.match(html, /输入会话 正在操作后台窗口/);
 assert.match(html, /停止本次操作 · 输入会话/);
 assert.doesNotMatch(html, /停止本次操作 · 另一观察会话/);
 await f.model.run({ action: "input.cancel", requestId: "background-batch" });
 assert.deepEqual({ ...f.calls.at(-1) }, { action: "input.cancel", requestId: "background-batch" });
});
test("a background-only target reads live activity without foreground control", async t => {
 const f = fixture(t);
 f.props.target.capabilities = ["backgroundInput", "backgroundCapture", "windowClientPreview"];
 f.props.expanded = true;
 await f.flush();
 assert.deepEqual(f.calls.map(call => call.action), ["control.status"]);
 f.notify();
 await f.flush();
 assert.deepEqual(f.calls.map(call => call.action), ["control.status", "control.status"]);
});
test("all computer SFC templates compile and small-screen layout remains intrinsic",()=>{
 for(const name of ["Page","Row","SchemaFields","ActionForm","Files","Canvas","Input","Observation"]){const filename=`ComputerControl${name}.vue`;const source=fs.readFileSync(new URL(`../../src/plugins/io.rabiroute.manager.core/web/computer/${filename}`,import.meta.url),"utf8");const parsed=parse(source);assert.equal(parsed.errors.length,0,filename);const script=compileScript(parsed.descriptor,{id:name});const compiled=compileTemplate({source:parsed.descriptor.template!.content,filename,id:name,compilerOptions:{bindingMetadata:script.bindings}});assert.deepEqual(compiled.errors,[],filename);}
 const page=fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.core/web/computer/ComputerControlPage.vue",import.meta.url),"utf8");assert.match(page,/v-show="visibleIds.has\(target.id\)"/);assert.match(page,/@media\(max-width:650px\)/);assert.doesNotMatch(page,/setInterval|screen.capture|control.begin/);
});
test("the merged device list compiles with one icon-led row per device system",()=>{
 for(const file of ["pages/RabiLinkPage.vue","computer/RabiPhoneControlRow.vue","computer/AndroidDisplayRow.vue"]){const filename=file.split("/").pop()!;const parsed=parse(fs.readFileSync(new URL(`../../src/plugins/io.rabiroute.manager.core/web/${file}`,import.meta.url),"utf8"));assert.equal(parsed.errors.length,0,filename);const script=compileScript(parsed.descriptor,{id:filename});const compiled=compileTemplate({source:parsed.descriptor.template!.content,filename,id:filename,compilerOptions:{bindingMetadata:script.bindings}});assert.deepEqual(compiled.errors,[],filename);}
 const page=fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.core/web/computer/ComputerControlPage.vue",import.meta.url),"utf8");assert.match(page,/<RabiPhoneControlRow v-for="phone in phones"/);assert.doesNotMatch(page,/手机控制|电脑控制/);
});

test("the phone preview renders named live activity, uses the exact stop ID and hides a rotated pointer", async t => {
 const file = new URL("../../src/plugins/io.rabiroute.manager.core/web/computer/RabiPhoneScreenControl.vue", import.meta.url);
 const require = createRequire(file), vue = require("vue");
 const descriptor = parse(fs.readFileSync(file, "utf8")).descriptor;
 const script = compileScript(descriptor, { id: "phone-live" });
 const template = compileTemplate({ source: descriptor.template!.content, filename: file.pathname, id: "phone-live",
   compilerOptions: { bindingMetadata: script.bindings } });
 assert.deepEqual(template.errors, []);
 const loaders: (() => void)[] = [], cleanup: (() => void)[] = [], timed = new Map<number, () => void>();
 const visibility = new Set<() => void>();
 const document = { hidden: false, addEventListener(_name: string, fn: () => void) { visibility.add(fn); },
   removeEventListener(_name: string, fn: () => void) { visibility.delete(fn); } };
 let timerId = 0;
 const running = { state: "sharing", layoutRevision: "phone-view-1", activity: {
   observations: [{ id: "watch", label: "观察者" }],
   operation: { requestId: "external-input", label: "操作会话" },
   pointer: { requestId: "external-input", label: "操作会话", kind: "swipe", x: .7, y: .4, startX: .4, startY: .4, remainingMs: 900 }
 } };
 let status: Record<string, unknown> = running;
 const calls: Record<string, unknown>[] = [];
 const request = async (_phone: unknown, body: Record<string, unknown>) => {
   calls.push(body);
   if (body.action === "input.cancel") {
     status = { state: "sharing", layoutRevision: "phone-view-1", activity: { observations: running.activity.observations } };
     return { state: "cancel-requested" };
   }
   return status;
 };
 const load = (code: string) => {
   const module = { exports: {} as any };
   vm.runInNewContext(transformSync(code, { loader: "ts", format: "cjs" }).code, { module, exports: module.exports,
     AbortController, performance, document,
     setTimeout: (fn: () => void) => { timed.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timed.delete(id),
     require(name: string) {
       if (name === "vue") return { ...vue, onMounted: (fn: () => void) => loaders.push(fn), onBeforeUnmount: (fn: () => void) => cleanup.push(fn) };
       if (name === "./phoneScreenFeedback") return phoneFeedback;
       if (name.endsWith("/i18n/index")) return i18n;
       if (name.endsWith("/managerApi")) return { managerAccessToken: () => "" };
       if (name.endsWith("/browserUuid")) return { browserUuid: () => "manual-id" };
       if (name.endsWith("/rabiLinkHomeClient")) return { requestPhoneScreenOperation: request };
       return require(name);
     } });
   return module.exports;
 };
 const phone = { id: "phone-fixture", guid: "", capabilities: ["phone-input-v1"], online: true };
 const model = load(script.content).default.setup({ phone }, { expose() {} });
 t.after(() => cleanup.forEach(fn => fn()));
 const { render } = load(template.code);
 const html = () => {
   const app = vue.createSSRApp({ props: ["phone"], render, setup: () => model }, { phone });
   app.config.warnHandler = () => {};
   return renderToString(app);
 };
 model.acceptCapture({ mimeType: "image/png", data: "dGVzdA==",
   source: { instanceId: "phone-fixture", frameId: "phone-frame-1", layoutRevision: "phone-view-1" } });
 loaders.forEach(fn => fn());
 await new Promise(resolve => setImmediate(resolve));
 const visible = await html();
 assert.match(visible, /观察者 正在看你的屏幕/);
 assert.match(visible, /操作会话 正在操作你的手机/);
 assert.match(visible, /phone-touch-point near-right[^>]*left:70%;top:40%/);
 assert.match(visible, /x1="40" y1="40" x2="70" y2="40"/);
 model.source.value = { ...model.source.value, layoutRevision: "rotated" };
 assert.doesNotMatch(await html(), /phone-touch-point/);
 await model.readInput("input.cancel", "external-input");
 await new Promise(resolve => setImmediate(resolve));
 assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), { action: "input.cancel", requestId: "external-input" });
 assert.doesNotMatch(await html(), /正在操作你的手机/);
 assert.match(await html(), /观察者 正在看你的屏幕/);
 document.hidden = true;
 visibility.forEach(fn => fn());
 assert.equal(timed.size, 0);
 assert.doesNotMatch(await html(), /正在看你的屏幕/);
});

test("Android display UI opens only on request, retries the original ID and closes the selected surface", async () => {
 const component = new URL("../../src/plugins/io.rabiroute.manager.core/web/computer/AndroidDisplayRow.vue", import.meta.url);
 const require = createRequire(component), vue = require("vue");
 const script = compileScript(parse(fs.readFileSync(component, "utf8")).descriptor, { id: "android-display" });
 const module = { exports: {} as any };
 const calls: unknown[] = [], refresh: string[] = [];
 let uuid = 0;
 vm.runInNewContext(transformSync(script.content, { loader: "ts", format: "cjs" }).code, {
   module, exports: module.exports, AbortController,
   require(name: string) {
     if (name === "vue") return { ...vue, onBeforeUnmount() {} };
     if (name.endsWith("/i18n/index")) return i18n;
     if (name.endsWith("/managerApi")) return { managerAccessToken: () => "" };
     if (name.endsWith("/browserUuid")) return { browserUuid: () => "open-" + ++uuid };
     if (name.endsWith("/rabiLinkHomeClient")) return {
       async requestDeviceScreenOperation(target: unknown, action: { action: string }) {
         calls.push(JSON.parse(JSON.stringify({ target, action })));
         if (calls.length === 1) throw new Error("response timed out");
         return { state: action.action === "display.close" ? "closed" : "opened" };
       }
     };
     if (name.endsWith(".vue")) return { __esModule: true, default: {} };
     return require(name);
   }
 });
 const target = { kind: "android-display", bridgeId: "lab", ownerDeviceId: "bridge-pc" };
 const mount = (selected: typeof target & { surfaceId?: string }) => module.exports.default.setup(
   { entry: { name: "Lab", online: true, target: selected } },
   { expose() {}, emit(event: string) { refresh.push(event); } });
 const bridge = mount(target);
 assert.equal(calls.length, 0);
 await bridge.action();
 await bridge.action();
 assert.deepEqual(calls, Array(2).fill({ target, action: { action: "display.open", requestId: "open-1" } }));
 const active = { ...target, surfaceId: "second-display" };
 await mount(active).action();
 assert.deepEqual(calls.at(-1), { target: active, action: { action: "display.close" } });
 assert.deepEqual(refresh, ["refresh", "refresh"]);
});
test("a computer row shows the icon for the system it actually reports",async t=>{const f=fixture(t);f.props.target.platform="win32-x64";let html=await renderRow(f);assert.ok(html.includes("mdi-microsoft-windows"),html);f.props.target.platform="darwin-arm64";html=await renderRow(f);assert.ok(html.includes("mdi-apple"),html);f.props.target.platform="linux-x64";html=await renderRow(f);assert.ok(html.includes("mdi-linux"),html);f.props.target.platform=undefined;html=await renderRow(f);assert.ok(html.includes("mdi-monitor"),html);});
test("a collapsed phone row keeps its system icon and phone tag with no second list heading",async t=>{
 const component=new URL("../../src/plugins/io.rabiroute.manager.core/web/computer/RabiPhoneControlRow.vue",import.meta.url);const require=createRequire(component);const vue=require("vue");const source=fs.readFileSync(component,"utf8");const descriptor=parse(source).descriptor;const cleanup:Array<()=>void>=[];
 const script=compileScript(descriptor,{id:"merged-phone-row"});const template=compileTemplate({source:descriptor.template!.content,filename:component.pathname,id:"merged-phone-row",compilerOptions:{bindingMetadata:script.bindings}});assert.deepEqual(template.errors,[]);
 const code=transformSync(script.content,{loader:"ts",format:"cjs"}).code;const module={exports:{} as any};
 vm.runInNewContext(code,{module,exports:module.exports,structuredClone,AbortController,Set,Map,Date,console,require:(name:string)=>{if(name==="vue")return {...vue,onBeforeUnmount:(fn:()=>void)=>cleanup.push(fn)};if(name.endsWith("/i18n/index"))return i18n;if(name.endsWith("rabiLinkHomeClient"))return {requestPhoneFileOperation:async()=>({enabled:true,permissionGranted:true})};if(name.endsWith(".vue"))return {__esModule:true,default:vue.defineComponent({props:{device:Object,title:String},setup(){return ()=>vue.h("div",{"data-component":"RabiPhoneFilesDialog"});}})};return require(name);}});
 const props=vue.reactive({phone:{id:"phone-1",guid:"guid-1",name:"我的手机",online:true,capabilities:["phone-file-control-v1"],displayName:"我的手机"},expanded:false});
 const scope=vue.effectScope();const model=scope.run(()=>module.exports.default.setup(props,{expose(){},emit(){}}));t.after(()=>{for(const fn of cleanup)fn();scope.stop();});await vue.nextTick();
 const renderCode=transformSync(template.code,{loader:"ts",format:"cjs"}).code;const renderModule={exports:{} as any};
 vm.runInNewContext(renderCode,{module:renderModule,exports:renderModule.exports,require:(name:string)=>name==="vue"?vue:require(name)});
 const app=vue.createSSRApp({props:["phone","expanded"],setup:()=>model,render:renderModule.exports.render},props);
 for(const name of new Set(source.match(/<v-[a-z-]+/g)?.map(value=>value.slice(1))||[]))app.component(name,{inheritAttrs:false,setup(_p:unknown,{slots,attrs}:any){return ()=>vue.h("div",attrs,slots.default?.());}});app.config.warnHandler=()=>{};
 const html=await renderToString(app);assert.ok(html.includes("我的手机"),html);assert.ok(html.includes("mdi-android"),html);assert.ok(html.includes("手机"),html);assert.equal(html.includes("刷新状态"),false);
});
test("six graphical objects retain capture-space coordinates without input dispatch",()=>{const point=drawingPoint(150,100,{left:50,top:50,width:200,height:100},1000,500);assert.deepEqual(point,{x:500,y:250});for(const type of ["rect","ellipse","arrow","path","text","highlight"]){const object=drawingObject("same",type,[{x:20,y:30},{x:10,y:5}],"plain",{});assert.equal(object.type,type);if(type==="path"||type==="arrow")assert.equal(object.points?.length,2);else assert.deepEqual(object.bounds,{x:10,y:5,width:10,height:25});}});

test("a reduced background preview projects two named pointers from the exact receiver geometry", () => {
 const source = { captureMethod: "window-print", minimized: true, windowId: "a", pid: 7,
   previewClient: { receiverId: "b", revision: "current", x: 8, y: 31, width: 314, height: 211, frameWidth: 330, frameHeight: 250 } };
 const image = { source, width: 160, height: 121 };
 const point = { id: "a", label: "会话甲", color: "#b6a0ff", space: "window-client", windowId: "a", pid: 7,
   receiverId: "b", clientRevision: "current", x: 72, y: 81 };
 const second = { ...point, id: "b", label: "会话乙", color: "#ffb465" };
 const irrelevant = [
   { ...point, windowId: "c" }, { ...point, pid: 8 }, { ...point, receiverId: "a" },
   { ...point, clientRevision: "old" }, { ...point, y: 222 }, { ...point, space: "desktop" }
 ];
 const rendered = windowPreviewPointers(image, [point, second, ...irrelevant]);
 assert.deepEqual(rendered, [
   { id: "a", label: "会话甲", color: "#b6a0ff", x: 80 / 330 * 100, y: 112 / 250 * 100, labelOffset: 0 },
   { id: "b", label: "会话乙", color: "#ffb465", x: 80 / 330 * 100, y: 112 / 250 * 100, labelOffset: 1 }
 ]);
 assert.equal(windowPreviewPointers(image, [second])[0]?.label, "会话乙");
 assert.deepEqual(windowPreviewPointers({ source: { ...source, previewClient: undefined } }, [point]), []);
});

test("explicit input exit is not blocked behind a slow screenshot",async t=>{const f=fixture(t,true);f.model.control.value={controlSessionId:"control",state:"active"};const capture=f.model.run({action:"screen.capture"});await f.model.run({action:"control.end"});assert.deepEqual(f.calls.map(call=>call.action),["screen.capture","control.end"]);f.resolveCapture({mimeType:"image/png",data:"fixture"});await capture;});

test("leaving the active tab invalidates an in-flight frame before returning",async t=>{const f=fixture(t,true);const capture=f.model.run({action:"screen.capture"});f.props.active=false;await f.flush();f.resolveCapture({mimeType:"image/png",data:"old"});await capture;f.props.active=true;await f.flush();assert.equal(f.model.image.value,undefined);});

test("collapsing a row invalidates an old screenshot before re-expansion",async t=>{const f=fixture(t,true);f.props.expanded=true;await f.flush();const capture=f.model.run({action:"screen.capture"});f.props.expanded=false;await f.flush();f.resolveCapture({mimeType:"image/png",data:"old"});await capture;f.props.expanded=true;await f.flush();assert.equal(f.model.image.value,undefined);});

test("computer English interface translates actual SFC labels and every shared setting title",t=>{i18n.setLocale("en");t.after(()=>i18n.setLocale("zh-CN"));const f=fixture(t);assert.equal(f.model.t("电脑控制"),"Computer control");for(const key of ["电脑控制","开始手动控制","退出控制","停止跟踪","清除标注","观察来源","本次输入","在电脑显示静态标注","控制体验、标注与资源参数"]) {assert.ok(coreTranslations.en[key as keyof typeof coreTranslations.en] || englishCatalog[key],key);assert.ok(coreTranslations.ja[key as keyof typeof coreTranslations.ja] || japaneseCatalog[key],key);}function walk(value:unknown){if(!value||typeof value!=="object")return;for(const [key,child]of Object.entries(value)){if(["title","description"].includes(key)&&typeof child==="string"&&/[\u4e00-\u9fff]/.test(child))assert.notEqual(i18n.translateText(child,"en"),child,child);else walk(child);}}walk(computerSettingsSchema);});

test("live invalidation is coalesced, metadata-only, and detached on collapse",async t=>{const f=fixture(t);f.props.expanded=true;await f.flush();assert.equal(f.eventListeners.size,1);const before=f.calls.length;f.notify();f.notify();await f.flush();assert.equal(f.calls.length-before,2);assert.ok(f.calls.every(value=>["control.status","annotation.status"].includes(String(value.action))));f.props.expanded=false;await f.flush();assert.equal(f.eventListeners.size,0);const after=f.calls.length;f.notify();await f.flush();assert.equal(f.calls.length,after);});
test("absent original control never appears active merely because its ID remains",async t=>{const f=fixture(t);f.model.control.value={controlSessionId:"original",state:"absent"};assert.equal(f.model.controlling.value,false);});

test("new live status read wins over an older in-flight control snapshot",async t=>{const f=fixture(t);let controlReads=0;let old!:(value:Record<string,unknown>)=>void;f.props.client.action=async(_target:unknown,body:Record<string,unknown>)=>{f.calls.push(body);if(body.action==="control.status"){controlReads++;if(controlReads===1)return new Promise(resolve=>old=resolve);return {state:"ended",controlSessionId:"same"};}return {layers:[]};};f.props.expanded=true;await f.flush();f.notify();await f.flush();assert.equal(f.model.control.value.state,"ended");old({state:"active",controlSessionId:"same"});await f.flush();assert.equal(f.model.control.value.state,"ended");assert.equal(controlReads,2);});

test("live annotation invalidation queries only known tracking IDs and updates the original summary",async t=>{const f=fixture(t);f.model.tracking.value={trackingId:"original",state:"tracking"};f.props.client.action=async(_target:unknown,body:Record<string,unknown>)=>{f.calls.push(body);return body.action==="annotation.status"?{layers:[]}:body.action==="annotation.track.status"?{trackingId:body.trackingId,state:"stopped"}:{state:"absent"};};f.props.expanded=true;await f.flush();assert.equal(f.model.tracking.value.state,"stopped");assert.equal(f.model.trackingActive.value,false);assert.deepEqual(f.calls.filter(call=>call.action==="annotation.track.status").map(call=>call.trackingId),["original"]);});

async function renderRow(f:ReturnType<typeof fixture>) {const component=new URL("../../src/plugins/io.rabiroute.manager.core/web/computer/ComputerControlRow.vue",import.meta.url);const require=createRequire(component);const source=fs.readFileSync(component,"utf8");const descriptor=parse(source).descriptor;const script=compileScript(descriptor,{id:"legacy-computer-render"});const template=compileTemplate({source:descriptor.template!.content,filename:component.pathname,id:"legacy-computer-render",compilerOptions:{bindingMetadata:script.bindings}});assert.deepEqual(template.errors,[]);const code=transformSync(template.code,{loader:"ts",format:"cjs"}).code;const module={exports:{} as any};vm.runInNewContext(code,{module,exports:module.exports,require:(name:string)=>name==="vue"?f.vue:require(name)});const app=f.vue.createSSRApp({props:["target","client","expanded","active","events"],setup:()=>f.model,render:module.exports.render},f.props);for(const name of new Set(source.match(/<v-[a-z-]+/g)?.map(value=>value.slice(1)) || []))app.component(name,{inheritAttrs:false,setup(_props:unknown,{slots,attrs}:any){return ()=>f.vue.h("div",attrs,slots.default?.());}});app.config.warnHandler=()=>{};return renderToString(app);}
test("old host settings404 preserves rendered files and terminal entry through actual SFC and fake HTTP",async t=>{const f=fixture(t);const urls:string[]=[];const request=async(url:RequestInfo|URL,init?:RequestInit)=>{urls.push(String(url));if(String(url).endsWith("/computer-settings"))return Response.json({code:-1,message:"HTTP 404: settings are not provided by this version"},{status:404});if(String(url).endsWith("/computer")){const body=JSON.parse(String(init?.body));assert.equal(body.action,"file.stat");return Response.json({code:0,data:{path:"D:/fixture",size:3,version:"v1",chunkBytes:65536}});}if(String(url).endsWith("/terminals"))return Response.json({code:0,data:{shells:["cmd"],sessions:[]}});throw new Error("Unexpected old-host request "+url);};Object.assign(f.props.target,{ownerDeviceId:"older-host",capabilities:["files","windows","screenshots"],terminalShells:["cmd"]});f.props.client=new ComputerControlClient(request as typeof fetch);f.props.expanded=true;await f.flush();assert.equal(f.model.draft.value,undefined);assert.match(f.model.settingsError.value,/404/);assert.equal(f.model.available("files"),true);assert.equal(f.model.available("terminal"),true);assert.equal(f.model.available("input"),false);assert.equal(f.model.available("annotation"),false);const html=await renderRow(f);assert.ok(html.includes('data-computer-component="ComputerControlFiles.vue"'));assert.ok(html.includes("打开终端"));assert.equal(html.includes("控制体验、标注与资源参数"),false);assert.equal(html.includes("保存设置"),false);await f.model.run({action:"file.stat",path:"D:/fixture"});assert.equal(f.model.receipt.value.version,"v1");f.model.openTerminal();assert.equal(f.model.terminal.value,true);const terminal=new RemoteTerminalClient("local","",request as typeof fetch,"older-host");assert.deepEqual((await terminal.request<{shells:string[]}>()).shells,["cmd"]);assert.equal(urls.filter(url=>url.endsWith("/computer-settings")).length,1);assert.equal(urls.some(url=>url.endsWith("/computer")&&url.includes("control.status")),false);});
test("missing new settings retains explicit old enabled=false and never invents support",async t=>{const f=fixture(t);Object.assign(f.props.target,{enabled:false,capabilities:undefined});f.props.client.settings=async()=>{throw new Error("settings404");};f.props.expanded=true;await f.flush();assert.equal(f.model.enabled.value,false);assert.equal(f.model.available("input"),false);assert.equal(f.model.available("annotation"),false);assert.equal(f.saves.length,0);});

test("uncertain control is not active input but retains original end and status recovery",async t=>{const f=fixture(t);f.model.control.value={controlSessionId:"original",state:"uncertain"};assert.equal(f.model.controlling.value,false);assert.equal(f.model.hasControlSession.value,true);assert.equal(f.model.controlSummary.value,"控制状态待确认");const html=await renderRow(f);assert.ok(html.includes("控制状态待确认"));assert.ok(!html.includes(">正在控制<"));assert.match(html,/data-computer-component="ComputerControlInput.vue" data-disabled="true"/);await f.model.endControl();await f.flush();assert.equal(f.calls.at(-1)?.action,"control.end");assert.equal(f.calls.at(-1)?.controlSessionId,"original");});
test("paused and failed tracking render their real state with the original stop path",async t=>{const f=fixture(t);for(const [state,label]of [["paused","跟踪已暂停"],["failed","跟踪失败"]]){f.model.tracking.value={trackingId:"original-tracking",state};assert.equal(f.model.trackingActive.value,false);assert.equal(f.model.hasTrackingWork.value,true);const html=await renderRow(f);assert.ok(html.includes(label));assert.ok(!html.includes(">跟踪中<"));await f.model.stopTracking();assert.equal(f.calls.at(-1)?.action,"annotation.track.stop");assert.equal(f.calls.at(-1)?.trackingId,"original-tracking");}});

test("starting, ending and unknown original sessions remain recoverable without enabling input",async t=>{const f=fixture(t);for(const [state,label]of [["starting","正在进入控制"],["ending","正在退出控制"],["future-pending-state","控制状态待确认"]]){f.model.control.value={controlSessionId:"original-pending",state};assert.equal(f.model.hasControlSession.value,true);assert.equal(f.model.controlling.value,false);assert.equal(f.model.controlSummary.value,label);const html=await renderRow(f);assert.ok(html.includes(label));assert.match(html,/data-computer-component="ComputerControlInput.vue" data-disabled="true"/);await f.model.endControl();await f.flush();assert.equal(f.calls.at(-1)?.action,"control.end");assert.equal(f.calls.at(-1)?.controlSessionId,"original-pending");}f.model.control.value={controlSessionId:"original-pending",state:"ended"};assert.equal(f.model.hasControlSession.value,false);});

test("a late screenshot for an earlier target cannot replace the latest requested computer image",async t=>{const f=fixture(t);let release!:(value:Record<string,unknown>)=>void;f.props.client.action=async(target:any,body:Record<string,unknown>)=>body.action!=="screen.capture"?{state:"absent"}:target.instanceId==="local"?new Promise(resolve=>release=resolve):{mimeType:"image/png",data:"new-image",width:1,height:1};const pending=f.model.run({action:"screen.capture"});f.props.target={...f.props.target,id:"latest",instanceId:"latest",name:"Latest"};await f.flush();await f.model.run({action:"screen.capture"});release({mimeType:"image/png",data:"old-image",width:1,height:1});await pending;assert.equal(f.model.image.value.data,"new-image");assert.equal(f.props.target.name,"Latest");});
test("mismatching settings readback retains submitted draft and accepted receipt without automatic overwrite",async t=>{const f=fixture(t);let patches=0;f.props.client=new ComputerControlClient(async(_url,init)=>{if(init?.method==="PATCH"){patches++;return Response.json({code:0,data:{settings:{enabled:false},schema:computerSettingsSchema,revision:'"v2"',execution:"applied"}},{headers:{etag:'"v2"'}});}return Response.json({code:0,data:{settings:{enabled:true},schema:computerSettingsSchema,revision:'"v3"'}},{headers:{etag:'"v3"'}});});await f.model.loadSettings();f.model.edit(["enabled"],false);await f.flush();assert.equal(patches,1);assert.equal(f.model.draft.value.readbackUnconfirmed,true);assert.equal(f.model.draft.value.value.enabled,false);assert.equal(f.model.draft.value.saved.settings.enabled,true);assert.match(f.model.draft.value.application.readbackIssue,/修改已提交/);f.model.edit(["control","showPointer"],false);await f.flush();assert.equal(patches,1);const html=await renderRow(f);assert.ok(html.includes("修改已提交，回读待确认"));assert.ok(!html.includes("未保存："));});
