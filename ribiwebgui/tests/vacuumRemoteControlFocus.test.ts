import assert from "node:assert/strict";
import fs from "node:fs";
import {createRequire} from "node:module";
import test from "node:test";
import vm from "node:vm";
import {compileScript, parse} from "@vue/compiler-sfc";
import {transformSync} from "esbuild";

function fixture() {
  let resolveStart!: (value: unknown) => void;
  const started = new Promise(resolve => {resolveStart = resolve;});
  const calls: string[] = [];
  const ready = {sessionId:"test-session",resourceId:"home:ha:vacuum.example",state:"ready"};
  const client = {
    capabilities: async () => ({available:true}),
    start: () => started,
    stop: async () => {calls.push("stop");return ready;},
    exit: async () => {calls.push("exit");return {...ready,state:"stopped"};}
  };
  const source = fs.readFileSync(new URL("../src/components/renderers/VacuumRemoteControl.vue",import.meta.url),"utf8");
  const script = compileScript(parse(source).descriptor,{id:"remote-focus-test"}).content;
  const compiled = transformSync(script,{loader:"ts",format:"cjs"}).code;
  const module = {exports:{} as any};
  const require = createRequire(import.meta.url);
  const vue = {...require("vue"),onMounted:()=>{},onBeforeUnmount:()=>{},watch:()=>{}};
  vm.runInNewContext(compiled,{module,exports:module.exports,crypto:globalThis.crypto,require:(name:string) =>
    name === "vue" ? vue : name.endsWith("vacuumRemoteClient") ? {vacuumRemoteClient:client} :
    name.endsWith("userFacingError") ? {userFacingError:String} : require(name)});
  const model = module.exports.default.setup({active:true,resourceId:ready.resourceId},{expose:()=>{}});
  return {model,calls,resolveStart:()=>resolveStart(ready)};
}

test("loading-button focus loss does not discard successful remote initialization",async()=>{
  const {model,calls,resolveStart}=fixture();
  const pending=model.enter();await Promise.resolve();
  model.focusout({relatedTarget:null});resolveStart();await pending;
  assert.equal(model.session.value?.state,"ready");assert.deepEqual(calls,[]);
  model.focusout({relatedTarget:null});await Promise.resolve();await Promise.resolve();
  assert.deepEqual(calls,["stop"]);
});

test("leaving the window during initialization cleans up the late remote session",async()=>{
  const {model,calls,resolveStart}=fixture();
  const pending=model.enter();await Promise.resolve();model.blur();resolveStart();await pending;
  assert.equal(model.session.value,undefined);assert.deepEqual(calls,["exit"]);
});
