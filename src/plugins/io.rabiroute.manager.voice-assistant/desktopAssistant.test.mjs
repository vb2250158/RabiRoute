import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { build } from 'esbuild';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rabi-voice-lifecycle-'));
after(()=>fs.rmSync(temp,{recursive:true,force:true}));
const bundled=path.join(temp,'desktop.mjs');
await build({entryPoints:[fileURLToPath(new URL('./web/speech/desktopAssistant.ts',import.meta.url))],outfile:bundled,bundle:true,platform:'node',format:'esm',alias:{'@shared':path.join(root,'src/shared')}});
const {createDesktopAssistant}=await import(pathToFileURL(bundled));
const tick=()=>new Promise(r=>setTimeout(r,10));
const until=async fn=>{for(let n=0;n<100&&!fn();n++)await tick();assert.ok(fn(),'Expected host event did not arrive');};
function fixture(){
  const events=[],calls=[],streams=new Map();let inputs=0;
  class Stream extends EventTarget{closed=0;close(){this.closed++;}emit(type,data){this.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));}}
  const owner=createDesktopAssistant({gatewayId:'route',persona:{id:'role',voiceReady:true},asrModel:'asr',ttsModel:'tts'},{
    onEvent:e=>events.push(e),openEvents:p=>{const s=new Stream();streams.set(p,s);return s;},
    fetch:async(p,init)=>{
      const body=init?.body?JSON.parse(init.body):undefined;calls.push({path:p,body});
      if(p==='/api/role-panel/messages')return Response.json({messageId:'input-'+(++inputs),roleId:'role'});
      if(p==='/api/speech/tts')return new Response(new Uint8Array([0]),{headers:{'x-rabispeech-playback-job':'job'}});
      if(p==='/api/speech/playback/cancel-session')return Response.json({code:0,data:{jobs:[]}});
      throw new Error('Unexpected request '+p);
    }
  });
  const reply=(input,id,text)=>streams.get('/api/events').emit('role_panel_message',{roleId:'role',gatewayId:'route',replyToMessageId:input,messageId:id,text});
  const count=p=>calls.filter(c=>c.path===p).length;
  const send=async text=>{assert.equal(owner.submitText(text),true);await until(()=>events.some(e=>e.type==='admission'&&e.admission.messageId==='input-'+inputs));return 'input-'+inputs;};
  return {owner,events,calls,streams,reply,count,send};
}
test('desktop hide preserves admitted replies; showing does not replay suppressed tokens',async()=>{
  const f=fixture();try{
    const id=await f.send('First task');f.owner.setVisible(false);f.owner.setVisible(false);
    f.reply(id,'reply-1','The original task finished.');await tick();
    assert.equal(f.events.filter(e=>e.type==='reply').length,1);assert.equal(f.count('/api/speech/tts'),0);
    assert.ok([...f.streams.values()].every(s=>s.closed===0));
    f.owner.setVisible(true);f.reply(id,'reply-2','Later progress for the same task.');await tick();
    assert.equal(f.count('/api/speech/tts'),0);assert.equal(f.events.filter(e=>e.type==='reply').length,2);
    const next=await f.send('New task');f.reply(next,'reply-3','A new answer.');await until(()=>f.count('/api/speech/tts')===1);
    await f.owner.dispose();await f.owner.dispose();
    assert.equal(f.count('/api/speech/playback/cancel-session'),1);
    assert.ok([...f.streams.values()].every(s=>s.closed===1));
    assert.ok(f.calls.every(c=>!c.path.includes('cancel')||c.path==='/api/speech/playback/cancel-session'));
  }finally{await f.owner.dispose();}
});
test('manual mute and pause survive repeated visibility changes while text continues',async()=>{
  const f=fixture();try{
    f.owner.pauseVoice();for(let n=0;n<3;n++){f.owner.setVisible(false);f.owner.setVisible(true);}
    assert.equal(f.owner.getState().outputEnabled,false);
    const first=await f.send('Muted task');f.reply(first,'muted','Complete muted text.');await tick();
    assert.equal(f.events.filter(e=>e.type==='reply').length,1);assert.equal(f.count('/api/speech/tts'),0);
    f.owner.setOutputEnabled(true);f.reply(first,'muted-late','Old response remains silent.');await tick();assert.equal(f.count('/api/speech/tts'),0);
    const second=await f.send('New audible task');f.reply(second,'audible','New response.');await until(()=>f.count('/api/speech/tts')===1);
  }finally{await f.owner.dispose();}
});
test('hide releases a delayed microphone grant once and show does not reacquire it',async()=>{
  let grant,requests=0,stops=0;
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>{requests++;return new Promise(r=>grant=r);}}}});
  const f=fixture();try{
    f.owner.activate();await until(()=>requests===1);f.owner.setVisible(false);
    grant({getTracks:()=>[{stop(){stops++;}}]});await tick();f.owner.setVisible(true);await tick();
    assert.equal(stops,1);assert.equal(requests,1);await f.owner.dispose();assert.equal(stops,1);
  }finally{await f.owner.dispose();if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator;}
});
