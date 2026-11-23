import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {PassThrough} from 'node:stream';
import {startStandalone} from '../src/main.mjs';
import {createResidentWake} from '../../../packages/desktop-voice-service/src/resident-wake.mjs';
import {openSettingsStore} from '../src/settings-store.mjs';

test('standalone HTTP keeps realtime admission, interruption and restart state in sync', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const directory=await mkdtemp(join(tmpdir(),'rabi-web-voice-acceptance-'));
  const requests=[], players=[], rounds=[];
  const captureId='a12c'.repeat(8), handoffs=[];
  const wakeEvents=Object.assign(new PassThrough(),{statusCode:200,headers:{'content-type':'application/x-ndjson'}});
  const capture=Object.assign(new PassThrough(),{statusCode:200,headers:{
    'content-type':'application/octet-stream','x-rabispeech-sample-rate':'16000',
    'x-rabispeech-capture-id':captureId,'x-rabispeech-start-sample':'9200',
  }});
  let armed=false, borrowed=false, receivedAudio=false;
  const residentSpeech={
    async openAssistantWake(aliases,signal){
      assert.deepEqual(aliases,['星河','小星']);
      armed=true;
      signal.addEventListener('abort',()=>wakeEvents.destroy(),{once:true});
      wakeEvents.write(JSON.stringify({type:'ready',captureId,sampleRate:16000})+'\n');
      return wakeEvents;
    },
    async openAssistantCapture(signal,cursor){
      assert.deepEqual(cursor,{captureId,sample:9200});
      signal.addEventListener('abort',()=>capture.destroy(),{once:true});
      borrowed=true;
      return capture;
    },
    async setAssistantRealtime(id,enabled){assert.equal(id,captureId);handoffs.push(enabled);},
  };
  let opens=0,closes=0;
  const model=createServer(async(req,res)=>{
    let raw=''; for await(const bytes of req) raw+=bytes;
    requests.push(JSON.parse(raw));
    res.writeHead(200,{'content-type':'text/event-stream'});
    const replies=['我正在播报第一条完整回复。','收到你的第二句。','收到唤醒词后的问题。'];
    res.end('data: '+JSON.stringify({choices:[{delta:{content:replies[requests.length-1]}}]})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const providerFactory=()=>({
    createAsr:({createRecording})=>{
      let recording;
      return {
      createRound(handlers){const round={handlers};rounds.push(round);return round;},
      async start(round){
        if (borrowed) throw Error('A wake turn must borrow only one capture');
        if (armed) {
          recording=createRecording();
          await recording.start(round.handlers.onError,{onPcm:()=>{receivedAudio=true;}});
        }
        round.handlers.onStart();
      },
      stop(){return recording?.dispose();},
    };},
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
  const config={directory,publicDirectory:directory,deviceFactory,providerFactory,residentSpeech};
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
    asr.onInterim({text:'第一条'});
    // A provider can report text before the desktop VAD timer sees the onset.
    asr.onSpeechStart();
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
    await command({action:'settings',patch:{voiceEnabled:true,keywordWakeEnabled:true,keywordWakeAliases:'星河\n小星'}});
    await until(s=>s.keywordWake.phase==='armed','wake armed');
    const recentSpeech=[{text:'刚才在讨论天气',ageMs:1500}];
    wakeEvents.write(JSON.stringify({type:'wake',captureId,sampleRate:16000,aliasIndex:0,
      replayFromSample:9200,observedThroughSample:18000,recentSpeech})+'\n');
    capture.write(Buffer.from([3,10,6,12]));
    await until(()=>receivedAudio,'replayed PCM');
    const wakeAsr=rounds.at(-1).handlers;
    wakeAsr.onSpeechStart();
    wakeAsr.onInterim({text:'   '});
    await delay(50);
    assert.deepEqual(handoffs,[]);
    wakeAsr.onInterim({text:'帮'});
    await until(()=>handoffs.length===1,'nonempty recognition hands off');
    wakeAsr.onFinal({text:'帮我查一下。'});
    wakeAsr.onSpeechEnd();
    await until(()=>players.some((player,index)=>index>=2&&player.played),'wake reply playback');
    players.at(-1).events.dispatchEvent(new Event('ended'));
    await until(s=>requests.length===3&&s.activity.pending===0,'wake turn submitted');
    assert.deepEqual(JSON.parse(requests[2].messages.at(-1).content).recentSpeech,recentSpeech);
    assert.deepEqual((await read('messages')).filter(x=>x.role==='user').map(x=>x.text),['第一条语音。','新的问题。','帮我查一下。']);
    await command({action:'settings',patch:{voiceEnabled:false}});
    await until(s=>s.keywordWake.phase==='disabled'&&s.voice.phase==='stopped','power switch releases capture and wake');
    assert.deepEqual(handoffs,[true,false]);
  }finally{
    await app?.dispose();
    await new Promise(resolve=>model.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
});

test('the wake idle deadline waits for active work and returns the microphone to passive mode', { timeout: 1000 }, async () => {
  const captureId = 'ab'.repeat(16);
  const events = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'application/x-ndjson' } });
  const calls = [];
  let pending = true, checked = false, phase = 'stopped';
  const wake = createResidentWake({
    speechRuntime: {
      async openAssistantWake(_aliases, signal) {
        signal.addEventListener('abort', () => events.destroy(), { once: true });
        return events;
      },
      async setAssistantRealtime(_id, enabled) { calls.push(enabled); },
    },
    acquireTarget: () => ({
      conversation: { activity: () => { checked = true; return { pending }; } },
      host: {
        captureState: () => ({ phase }),
        captureHasWork: () => false,
        voiceEnabled: () => true,
        async startWithRecording() { phase = 'running'; wake.captureActivity(true); },
        async command({ action }) { assert.equal(action, 'stop'); phase = 'stopped'; },
      },
    }),
    assertCurrent() {},
    canStart: () => true,
    shouldUseFallback: () => false,
    sleepAfterMs: 15,
  });
  try {
    wake.arm(['星河']);
    events.write(JSON.stringify({ type: 'ready', captureId, sampleRate: 16000 }) + '\n');
    events.write(JSON.stringify({ type: 'wake', captureId, sampleRate: 16000, aliasIndex: 0, replayFromSample: 2000, observedThroughSample: 3000 }) + '\n');
    for (let i = 0; !checked && i < 80; i++) await delay(5);
    assert.equal(checked, true);
    assert.equal(phase, 'running');
    assert.deepEqual(calls, [true]);
    pending = false;
    for (let i = 0; phase !== 'stopped' && i < 80; i++) await delay(5);
    await wake.drainHandoff();
    assert.equal(phase, 'stopped');
    assert.equal(wake.snapshot().phase, 'armed');
    assert.deepEqual(calls, [true, false]);
  } finally {
    await wake.stop();
  }
});
