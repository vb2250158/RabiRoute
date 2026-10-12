import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {createRequire} from "node:module";
import vm from "node:vm";
import {compileScript,parse} from "@vue/compiler-sfc";
import {transformSync} from "esbuild";

test("opening another project stops the remaining audio fragments before they reach its compute PC",async()=>{
  const component=new URL("../src/pages/VideoPage.vue",import.meta.url);
  const require=createRequire(component),vue=require("vue");
  const client=require("./mediaServiceClient.ts");
  const calls:string[]=[];let model:any;
  const canvas={minimap:vue.ref({}),selectedIds:vue.ref([]),marquee:vue.ref(),viewport:vue.ref(),scale:vue.ref(1),handMode:vue.ref(false),dragging:vue.ref(false),transform:vue.ref(""),grid:vue.ref(""),positions:vue.ref({}),add(){}};
  const code=transformSync(compileScript(parse(fs.readFileSync(component,"utf8")).descriptor,{id:"media-audio-scope"}).content,{loader:"ts",format:"cjs"}).code;
  const module={exports:{} as any};
  vm.runInNewContext(code,{module,exports:module.exports,URL,Blob,Date,location:{href:"http://fixture/#/video"},window:{},
    require:(name:string)=>name==="vue"?{...vue,onMounted(){},onBeforeUnmount(){},watch(){}}:
    name.endsWith(".vue")?{}:
    name.endsWith("useVideoCanvas")?{useVideoCanvas:()=>canvas}:
    name.endsWith("ttsParameters")?{normalizeTtsParameters:()=>({}),ttsCommandSettings:()=>({model:"fixture",play:false})}:
    name.endsWith("mediaServiceClient")?{...client,createMediaServiceClient:(target:()=>string)=>client.createMediaServiceClient(target,async(url:string)=>{calls.push(String(url));return new Response("audio",{headers:{"content-type":"audio/wav"}});})}:
    name.endsWith("audioPause")?{synthesizeWithPauses:async(_text:string,fragment:(input:string)=>Promise<Blob>)=>{
      await fragment("first");
      // Project restoration changes the choice independently of the disabled selector.
      model.serviceDeviceId.value="pc-b";model.mediaService.invalidate();
      return fragment("second");
    }}:require(name)
  });
  model=module.exports.default.setup({}, {expose(){}});
  model.serviceDeviceId.value="pc-a";
  model.audioModels.value=[{id:"fixture",available:true,capability:"tts"}];
  const item={id:"audio-a",kind:"audio",title:"Audio",text:"first second",audioModel:"fixture"};
  await model.generateAudioCard(item);
  assert.deepEqual(calls,["/api/speech/tts?computeDeviceId=pc-a"]);
  assert.equal((item as any).audioBusy,false);assert.equal((item as any).audioUrl,undefined);
  assert.match((item as any).audioError,/旧响应已忽略/);
});
