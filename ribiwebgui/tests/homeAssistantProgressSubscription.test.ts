import assert from "node:assert/strict";
import fs from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";
import {compileScript,parse} from "@vue/compiler-sfc";
import {transformSync} from "esbuild";

function fixture(state="ready") {
  const require=createRequire(import.meta.url), vue=require("vue");
  const mounted:Array<()=>Promise<void>>=[],unmounted:Array<()=>void>=[],connections:Array<{closed:boolean;close():void;addEventListener():void}>=[];
  const snapshot={state,installation:"installed",configured:true,config:{mode:"haos",containerName:"homeassistant",autoStart:true}};
  const source=fs.readFileSync(new URL("../src/components/renderers/HomeAssistantDeploymentPanel.vue",import.meta.url),"utf8");
  const code=transformSync(compileScript(parse(source).descriptor,{id:"deployment-subscription-test"}).content,{loader:"ts",format:"cjs"}).code;
  const module={exports:{} as any};
  vm.runInNewContext(code,{module,exports:module.exports,require:(name:string)=>
    name==="vue" ? {...vue,onMounted:(fn:()=>Promise<void>)=>mounted.push(fn),onUnmounted:(fn:()=>void)=>unmounted.push(fn)} :
    name.endsWith("homeAssistantDeploymentClient") ? {homeAssistantDeploymentClient:{read:async()=>snapshot}} :
    name.endsWith("managerApi") ? {managerEventSource:()=>{const connection={closed:false,close(){this.closed=true;},addEventListener(){}};connections.push(connection);return connection;}} :
    name.endsWith("userFacingError") ? {userFacingError:String} : require(name)});
  const model=module.exports.default.setup({}, {expose:()=>{},emit:()=>{}});
  return {model,mounted,unmounted,connections,nextTick:vue.nextTick};
}

test("completed deployment does not hold a progress connection; new installation opens then releases it",async()=>{
  const f=fixture();await f.mounted[0]!();assert.equal(f.connections.length,0);
  f.model.installing.value=true;await f.nextTick();assert.equal(f.connections.length,1);assert.equal(f.connections[0]?.closed,false);
  f.model.installing.value=false;await f.nextTick();assert.equal(f.connections[0]?.closed,true);
});

test("opening an ongoing installation still subscribes, and unmount closes progress",async()=>{
  const f=fixture("installing");await f.mounted[0]!();assert.equal(f.connections.length,1);
  f.unmounted[0]!();assert.equal(f.connections[0]?.closed,true);
});
