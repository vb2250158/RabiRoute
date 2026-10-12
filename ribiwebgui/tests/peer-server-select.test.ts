import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {createRequire} from "node:module";
import vm from "node:vm";
import {compileScript,parse} from "@vue/compiler-sfc";
import {transformSync} from "esbuild";

function fixture(t: any,persistSelection=false) {
  const component=new URL("../src/components/PeerServerSelect.vue",import.meta.url);
  const require=createRequire(component),vue=require("vue");
  const props=vue.reactive({modelValue:"media-a",persistSelection,label:"模型服务电脑",disabled:false});
  const mounted:(()=>void)[]=[],unmount:(()=>void)[]=[],calls:{url:string;method?:string}[]=[],emitted:string[]=[];
  let global="speech-a";
  const code=transformSync(compileScript(parse(fs.readFileSync(component,"utf8")).descriptor,{id:"peer-select-test"}).content,{loader:"ts",format:"cjs"}).code;
  const module={exports:{} as any};
  vm.runInNewContext(code,{module,exports:module.exports,Date,setTimeout,clearTimeout,
    fetch:async(url:string,init?:RequestInit)=>{calls.push({url,method:init?.method});if(url.endsWith("/selection") && init?.method==="PUT") global=JSON.parse(String(init.body)).deviceId;return Response.json({selectedDeviceId:global,peers:[]});},
    require:(name:string)=>name==="vue"?{...vue,onMounted:(fn:()=>void)=>mounted.push(fn),onBeforeUnmount:(fn:()=>void)=>unmount.push(fn)}:name.endsWith("managerApi")?{managerEventSource:()=>({close(){},addEventListener(){}})}:require(name)
  });
  const scope=vue.effectScope();const model=scope.run(()=>module.exports.default.setup(props,{expose(){},emit(_event:string,value:string){emitted.push(value);if(!persistSelection)props.modelValue=value;}}));
  t.after(()=>{for(const fn of unmount)fn();scope.stop();});
  for(const fn of mounted)fn();
  const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await vue.nextTick();};
  return {model,props,calls,emitted,flush,global:()=>global};
}
test("media selector restores its project value and never changes the global speech choice",async t=>{
  const f=fixture(t);await f.flush();assert.equal(f.model.selected.value,"media-a");
  await f.model.select("media-b");await f.flush();
  assert.equal(f.model.selected.value,"media-b");assert.equal(f.global(),"speech-a");
  assert.deepEqual(f.emitted,["media-b"]);assert.equal(f.calls.some(call=>call.method==="PUT"),false);
  f.props.modelValue="saved-project-peer";await f.flush();assert.equal(f.model.selected.value,"saved-project-peer");
});
test("speech wrapper mode retains global selection persistence and disabled changes are ignored",async t=>{
  const f=fixture(t,true);await f.flush();assert.equal(f.model.selected.value,"speech-a");
  f.props.disabled=true;await f.model.select("speech-b");assert.equal(f.global(),"speech-a");
  f.props.disabled=false;await f.model.select("speech-b");await f.flush();
  assert.equal(f.global(),"speech-b");assert.equal(f.calls.filter(call=>call.method==="PUT").length,1);
});
