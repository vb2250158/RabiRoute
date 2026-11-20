import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {startStandalone} from '../src/main.mjs';
import {openSettingsStore} from '../src/settings-store.mjs';

test('standalone HTTP keeps realtime admission, interruption and restart state in sync', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const directory=await mkdtemp(join(tmpdir(),'rabi-web-voice-acceptance-'));
  const requests=[], players=[], rounds=[];
  let opens=0,closes=0;
  const model=createServer(async(req,res)=>{
    let raw=''; for await(const bytes of req) raw+=bytes;
    requests.push(JSON.parse(raw));
    res.writeHead(200,{'content-type':'text/event-stream'});
    const replies=['我正在播报第一条完整回复。','收到你的第二句。'];
    res.end('data: '+JSON.stringify({choices:[{delta:{content:replies[requests.length-1]}}]})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const providerFactory=()=>({
    createAsr:()=>({
      createRound(handlers){const round={handlers};rounds.push(round);return round;},
      start(round){round.handlers.onStart();},stop(){},
    }),
    synthesize:async()=>new Uint8Array(44),
  });
  const deviceFactory=async()=>{
    opens++;
    return {
      close:async()=>{closes++;},configurePresenter:async()=>{},present:async()=>{},
      async createPlayer(){
        const player={events:new EventTarget(),played:0,stopped:0,async play(){this.played++;},async stop(){this.stopped++;},async destroy(){}};
        players.push(player);return player;
      },
    };
  };
  let app;
  const config={directory,publicDirectory:directory,deviceFactory,providerFactory};
  try {
    await(await openSettingsStore(directory)).save({
      llmModel:'fixture',llmEndpoint:'http://127.0.0.1:'+model.address().port+'/v1/chat/completions',
      asrMode:'volcengine',asrModel:'bigmodel',ttsModel:'fixture',ttsVoice:'fixture',
      captionsEnabled:false,electronExecutable:process.execPath,voiceEnabled:true,webSearchEnabled:false,
    });
    app=await startStandalone(config);
    let url=new URL(app.url),headers={authorization:'Bearer '+url.hash.slice(1),'content-type':'application/json'};
    const read=async path=>{const r=await fetch(url.origin+'/api/'+path,{headers});assert.equal(r.status,200);return r.json();};
    const rawCommand=async body=>fetch(url.origin+'/api/command',{method:'POST',headers,body:JSON.stringify(body)});
    const command=async body=>{const r=await rawCommand(body);const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;};
    const until=async (check,label)=>{for(let i=0;i<200;i++){const s=await read('state');if(check(s))return s;await delay(15);}const s=await read('state');throw Error(label+': '+JSON.stringify({voice:s.voice,activity:s.activity,error:s.error,input:s.inputPreview,playback:s.playback}));};
    await command({action:'start'});
    await until(s=>s.voice.phase==='running'&&s.voice.capture==='listening','start');
    const id=(await read('state')).sessionId;
    const asr=rounds.at(-1).handlers;
    asr.onSpeechStart();
    asr.onInterim({text:'第一条'});
    await until(s=>s.inputPreview?.text==='第一条','first interim');
    assert.equal((await read('messages')).length,0);
    asr.onFinal({text:'第一条语音。',additions:{emotion:'happy'}});
    asr.onSpeechEnd();
    await until(s=>players.some(p=>p.played),'first playback');
    const original=players.find(p=>p.played);
    assert.equal(requests.length,1);
    const modelInput=requests[0].messages.find(message=>message.role==='user');
    const turn=JSON.parse(modelInput.content);
    assert.equal(turn.speechObservation?.estimates?.emotion,'happy');
    asr.onSpeechStart(); asr.onInterim({text:'  '});
    await delay(50);
    assert.equal(original.stopped,0);
    asr.onInterim({text:'新'});
    await until(()=>original.stopped===1,'interrupt after first character');
    await until(s=>s.inputPreview?.text==='新','second interim');
    asr.onFinal({text:'新的问题。'});asr.onSpeechEnd();
    await until(s=>requests.length===2&&players.some(p=>p!==original&&p.played),'second playback');
    const next=players.find(p=>p!==original&&p.played);
    next.events.dispatchEvent(new Event('ended'));
    await until(s=>s.activity.pending===0&&s.inputPreview===null,'auto submit and clear');
    const userMessages=(await read('messages')).filter(x=>x.role==='user');
    assert.deepEqual(userMessages.map(x=>x.text),['第一条语音。','新的问题。']);
    await command({action:'settings',patch:{voiceEnabled:false}});
    await until(s=>s.voice.phase==='stopped'&&s.settings.voiceEnabled===false,'voice switch off');
    const disabled=await rawCommand({action:'start'});
    assert.equal(disabled.status,400);assert.equal((await disabled.json()).error,'ASSISTANT_VOICE_DISABLED');
    await app.dispose();
    app=await startStandalone(config);url=new URL(app.url);
    headers={...headers,authorization:'Bearer '+url.hash.slice(1)};
    assert.equal((await read('state')).sessionId,id);
    assert.equal((await read('state')).settings.voiceEnabled,false);
    assert.deepEqual((await read('messages')).filter(x=>x.role==='user').map(x=>x.text),['第一条语音。','新的问题。']);
    assert.equal(opens,closes);
  }finally{
    await app?.dispose();
    await new Promise(resolve=>model.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
});
