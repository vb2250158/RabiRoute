import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function load(name) {
  const bytes = await readFile(new URL('../app/src/main/assets/mobile-assistant/' + name, import.meta.url));
  return import('data:text/javascript;base64,' + bytes.toString('base64'));
}
const { createPhoneCapture } = await load('capture.js');
const { createStreamingRecognition, matchWakeWord } = await load('asr-stream.js');

test('matches the earliest complete alias and preserves the original command', () => {
  assert.deepEqual(matchWakeWord('𠮷，星，河小助手，帮我查 GPU。', ['星河', '星河小助手']), { alias:'星河小助手', text:'帮我查 GPU。' });
  assert.deepEqual(matchWakeWord('Hi RABI, Search A.', ['rabi']), { alias:'rabi', text:'Search A.' });
  assert.equal(matchWakeWord('Rabid news', ['Rabi']), null);
});

test('writes ordered signed PCM16 chunks and retires old stream callbacks', () => {
  const sent = [], notices = [];
  let active;
  const bridge = {
    recognitionStart(id,sessionId) { active=id; assert.equal(sessionId,'session'); return true; },
    recognitionPcm(id,sequence,wave) { assert.equal(id,active); sent.push([sequence,Buffer.from(wave,'base64')]); return true; },
    recognitionCancel(id) { assert.equal(active,id); },
  };
  const streams = createStreamingRecognition(bridge);
  const round = streams.open('session', { receive:value=>notices.push(value.type), end() {}, error() {} });
  streams.receive(active, '{"type":"ready"}');
  assert.equal(round.write(Float32Array.of(-1,0,1)),true);
  assert.equal(round.write(Float32Array.of(0)),true);
  streams.receive(active, '{"type":"interim","text":"你好"}');
  round.close();
  streams.receive(active, '{"type":"final","text":"这是迟到结果"}');
  assert.deepEqual(notices,['ready','interim']);
  assert.deepEqual(sent.map(item=>item[0]),[0,1]);
  assert.deepEqual([...sent[0][1]],[0,128,0,0,255,127]);
});

function microphone(t, applyConstraints = async () => {}) {
  let calls = 0, processor;
  const openedWith = [], processingUpdates = [];
  const descriptions = Object.fromEntries(['navigator','AudioContext'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{
    for (const [key, descriptor] of Object.entries(descriptions)) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor);
      else delete globalThis[key];
    }
  });
  const track = {
    stop() {}, addEventListener() {},
    applyConstraints(options) {
      processingUpdates.push(options);
      return applyConstraints(options);
    },
  };
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{
    async getUserMedia(options) {
      calls++;
      openedWith.push(options.audio);
      return { getTracks:()=>[track], getAudioTracks:()=>[track] };
    },
  }}});
  function endpoint() { return {connect(){},disconnect(){}}; }
  globalThis.AudioContext = class {
    sampleRate = 16000;
    destination = {};
    async resume() {}
    async close() {}
    createMediaStreamSource() { return endpoint(); }
    createScriptProcessor() { processor = endpoint(); return processor; }
    createGain() { return { ...endpoint(),gain:{} }; }
  };
  return {
    frames(amplitude,quantity) {
      for(let index=0;index<quantity;index++) {
        const frame = new Float32Array(1024).fill(amplitude);
        processor.onaudioprocess({inputBuffer:{getChannelData:()=>frame}});
      }
    },
    calls:()=>calls,
    openedWith,
    processingUpdates,
  };
}

test('wake keeps capture local and promotes the same microphone without duplicate delivery', async t => {
  const mic = microphone(t);
  const recognized = ['普通背景文字', '星河，查一查'];
  const transcribes = [], output = [], state = [];
  let background;
  let live;
  const adapter = createPhoneCapture({ waveform(){}, phase:value=>state.push(value), mayRecord:()=>true,
    getPolicy:()=>({kind:'wake',model:'local-kws-asr',aliases:['星河','小助手']}),
    matchWake:matchWakeWord,
    onWake(_alias, recent) {
      background = recent;
      return {kind:'streaming',fallbackModel:'local-kws-asr'};
    },
    async transcribe(wave, signal, policy) { transcribes.push([wave.length,policy]); return {text:recognized.shift()}; },
    openStream(handlers) { live=handlers; return {write:()=>true,close(){}}; },
  });
  const round = adapter.createRound({onFinal:result=>output.push(result.text)});
  await adapter.start(round);
  mic.frames(0,32);
  await round.queue;
  assert.deepEqual(transcribes,[]);
  mic.frames(.1,7);mic.frames(0,12);
  await round.queue;
  assert.deepEqual(output,[]);assert.equal(live,undefined);
  mic.frames(.1,7);mic.frames(0,12);
  await round.queue;
  assert.deepEqual(output,['查一查']);assert.ok(live);
  assert.deepEqual(background.map(item => item.text),['普通背景文字']);
  assert.ok(background.every(item => Number.isSafeInteger(item.capturedAt)));
  live.receive({type:'ready'});
  mic.frames(.1,7);mic.frames(0,12);
  await round.queue;
  assert.equal(transcribes.length,2);
  assert.ok(transcribes.every(([,policy])=>policy.kind==='wake'));
  live.receive({type:'interim',text:'在吗'});
  live.receive({type:'final',text:'在吗'});
  assert.deepEqual(output,['查一查','在吗']);
  assert.equal(mic.calls(),1);
  assert.ok(state.includes('等待唤醒词'));
  adapter.stop(round);
});

test('before the first valid streaming result, disconnect recognizes the buffered continuation locally', async t => {
  const mic= microphone(t);
  const rows = ['小助手', '本机已接续'];
  const output=[];
  let plugin, fallback=0;
  const adapter=createPhoneCapture({ waveform(){}, phase(){}, mayRecord:()=>true,
    getPolicy:()=>({kind:'wake',model:'local',aliases:['小助手']}),matchWake:matchWakeWord,
    onWake:()=>({kind:'streaming',fallbackModel:'local'}),onFallback:()=>fallback++,
    async transcribe(){return {text:rows.shift()};},
    openStream(handlers) {plugin=handlers;return {write:()=>true,close(){}};},
  });
  const round=adapter.createRound({onFinal:result=>output.push(result.text)});
  await adapter.start(round);
  mic.frames(.1,7);mic.frames(0,12);
  await round.queue;
  plugin.receive({type:'ready'});
  mic.frames(.1,7);mic.frames(0,12);
  await round.queue;
  assert.deepEqual(output,[]);
  plugin.error(new Error('disconnect'));
  plugin.receive({type:'final',text:'stale'});
  await round.queue;
  assert.equal(fallback,1);
  assert.deepEqual(output,['本机已接续']);
  assert.equal(mic.calls(),1);
  adapter.stop(round);
});

test('disconnect after a nonempty interim recovers the full sentence from the same microphone exactly once', async t => {
  const mic = microphone(t);
  const output = [], heard = [], recognized = [];
  let live;
  let fallbackCount = 0;
  const adapter = createPhoneCapture({ waveform(){}, phase(){}, mayRecord:()=>true,
    getPolicy:()=>({ kind:'streaming', fallbackModel:'verified-local' }),
    onFallback() { fallbackCount++; },
    async transcribe(wave, _signal, policy) {
      const pcm = new DataView(wave.buffer, wave.byteOffset);
      recognized.push({ policy, first:pcm.getInt16(44, true), lastSpoken:pcm.getInt16(44 + 7 * 1024 * 2, true) });
      return { text:'完整的一句话' };
    },
    openStream(handlers) { live=handlers; return { write:()=>true, close(){} }; },
  });
  const round = adapter.createRound({ onInterim:value=>heard.push(value.text), onFinal:value=>output.push(value.text) });
  await adapter.start(round);
  live.receive({ type:'ready' });
  mic.frames(.1, 4);
  live.receive({ type:'interim', text:'完整的' });
  mic.frames(.2, 2);
  live.end();
  live.receive({ type:'final', text:'延迟到达的云端结果' });
  live.error(new Error('duplicated close'));
  mic.frames(.3, 2);
  mic.frames(0, 10);
  await round.queue;
  assert.deepEqual(heard, ['完整的']);
  assert.deepEqual(recognized, [{ policy:{kind:'utterance',local:true}, first:3277, lastSpoken:9830 }]);
  assert.deepEqual(output, ['完整的一句话']);
  assert.equal(fallbackCount, 1);
  assert.equal(mic.calls(), 1);
  adapter.stop(round);
});

test('a timed final acknowledges only its audio, even if the next words are already buffered', async t => {
  const mic = microphone(t);
  const output = [], recognized = [];
  let live;
  const adapter = createPhoneCapture({ waveform(){}, phase(){}, mayRecord:()=>true,
    getPolicy:()=>({ kind:'streaming', fallbackModel:'verified-local' }),
    async transcribe(wave) {
      const pcm = new DataView(wave.buffer, wave.byteOffset);
      const firstAudible = Array.from({ length:(wave.length - 44) / 2048 }, (_, index)=>pcm.getInt16(44 + index * 2048, true)).find(Boolean);
      recognized.push(firstAudible);
      return { text:'补齐下一句话' };
    },
    openStream(handlers) { live=handlers; return { write:()=>true, close(){} }; },
  });
  const round = adapter.createRound({ onFinal:value=>output.push(value.text) });
  await adapter.start(round);
  mic.frames(.1, 7);
  mic.frames(0, 4);
  mic.frames(.25, 4); // Matches a new sentence for the remote provider, inside one local VAD segment.
  live.receive({ type:'final', text:'已经发过的第一句', endSample:7 * 1024 });
  live.receive({ type:'interim', text:'下一句' });
  mic.frames(0, 10);
  live.error(new Error('disconnect'));
  await round.queue;
  assert.deepEqual(recognized, [8192]);
  assert.deepEqual(output, ['已经发过的第一句', '补齐下一句话']);
  assert.equal(mic.calls(), 1);
  adapter.stop(round);
});

test('timed recognition after keyword replay uses the beginning of the replay as stream origin', async t => {
  const mic = microphone(t);
  const output = [];
  let completeWake, live, replayed = 0, recovered;
  const wake = new Promise(resolve => { completeWake = resolve; });
  const adapter = createPhoneCapture({ waveform(){}, phase(){}, mayRecord:()=>true,
    getPolicy:()=>({ kind:'wake', model:'local', aliases:['星河'] }), matchWake:matchWakeWord,
    onWake:()=>({ kind:'streaming', fallbackModel:'local' }),
    async transcribe(wave) {
      if (!live) return wake;
      const pcm = new DataView(wave.buffer, wave.byteOffset);
      recovered = pcm.getInt16(44 + 4 * 2048, true);
      return { text:'下一句' };
    },
    openStream(handlers) {
      live = handlers;
      return { write() { replayed++; return true; }, close(){} };
    },
  });
  const round = adapter.createRound({ onFinal:value=>output.push(value.text) });
  await adapter.start(round);
  mic.frames(.1, 7);
  mic.frames(0, 10);
  mic.frames(.1, 4);
  mic.frames(0, 4);
  mic.frames(.2, 4);
  completeWake({ text:'星河' });
  await round.queue;
  assert.equal(replayed, 12);
  live.receive({ type:'final', text:'已经提交', endSample:4 * 1024 });
  live.receive({ type:'final', text:'迟到重复', endSample:4 * 1024 });
  live.error(new Error('disconnect'));
  mic.frames(0, 10);
  await round.queue;
  assert.equal(recovered, 6553);
  assert.deepEqual(output, ['已经提交', '下一句']);
  assert.equal(mic.calls(), 1);
  adapter.stop(round);
});

test('Android edge wake keeps standby audio on-device and starts streaming from the exact keyword boundary', async t => {
  const mic = microphone(t);
  const pcm = [], events = [];
  let edge;
  let laneClosed = 0;
  const kws = { model:'fixture-model', keywords:'y è y ǔ @rabi-0/N AY1 T R EY1 N @rabi-1', tokensSha256:'hash' };
  const adapter = createPhoneCapture({ waveform(){}, phase(){}, mayRecord:()=>true,
    getPolicy:()=>({ kind:'wake', aliases:['星河','star river'], kws }),
    openWake(config, aliasCount, handlers) {
      assert.equal(config, kws);
      assert.equal(aliasCount, 2);
      edge = handlers;
      return { write:(_frame, after)=>{ events.push(after); return true; }, close(){ laneClosed++; } };
    },
    onWake(alias, recent) {
      assert.equal(alias, 'star river');
      assert.deepEqual(recent, []);
      return { kind:'streaming' };
    },
    async transcribe() { assert.fail('standby audio must not reach the PC without opt-in'); },
    openStream() { return { write:frame=>{ pcm.push(frame); return true; }, close(){} }; },
  });
  const round = adapter.createRound({});
  await adapter.start(round);
  edge.ready();
  mic.frames(.1, 2);
  mic.frames(.2, 2);
  assert.deepEqual(events, [1024, 2048, 3072, 4096]);
  assert.deepEqual(pcm, []);
  edge.hit({ aliasIndex:1, utteranceStartSample:0, replayFromSample:2148 });
  assert.deepEqual(pcm.map(frame=>frame.length), [924, 1024]);
  assert.ok(pcm.every(frame => frame[0] === Math.fround(.2)));
  edge.hit({ aliasIndex:1, utteranceStartSample:0, replayFromSample:2148 });
  assert.equal(pcm.length, 2);
  assert.equal(laneClosed, 1);
  assert.equal(mic.calls(), 1);
  adapter.stop(round);
});

test('explicit standby transcription populates context without racing ahead of the local wake detector', async t => {
  const mic = microphone(t);
  let edge;
  let promoted = false;
  const adapter = createPhoneCapture({ waveform(){}, phase(){}, mayRecord:()=>true,
    getPolicy:()=>({ kind:'wake', model:'verified-local', aliases:['星河'], kws:{} }), matchWake:matchWakeWord,
    openWake(_config, _count, handlers) { edge = handlers; return { write:()=>true, close(){} }; },
    async transcribe() { return { text: '听起来像星河的背景内容' }; },
    onWake(_alias, recent) {
      assert.deepEqual(recent.map(item=>item.text), ['听起来像星河的背景内容']);
      promoted = true;
      return { kind:'streaming' };
    },
    openStream() { return { write:()=>true, close(){} }; },
  });
  const round = adapter.createRound({});
  await adapter.start(round);
  mic.frames(.1, 7);
  mic.frames(0, 10);
  await round.queue;
  assert.equal(promoted, false);
  mic.frames(.2, 4);
  edge.hit({ aliasIndex:0, utteranceStartSample:17 * 1024, replayFromSample:18 * 1024 + 80 });
  assert.equal(promoted, true);
  adapter.stop(round);
});

test('edge wake keeps raw capture through the first final and switches processing on the same track', async t => {
  const mic = microphone(t);
  const keyword = {echoCancellation:false, noiseSuppression:false, autoGainControl:false};
  const realtime = {echoCancellation:true, noiseSuppression:true, autoGainControl:true};
  const wake = {kind:'wake', aliases:['星河'], kws:{}};
  const active = {kind:'streaming'};
  const finals = [];
  let edge, stream;
  const adapter = createPhoneCapture({ waveform(){}, phase(){}, mayRecord:()=>true,
    getPolicy:()=>wake, onWake:()=>active,
    openWake(_config, _count, handlers) { edge = handlers; return {write:()=>true,close(){}}; },
    openStream(handlers) { stream = handlers; return {write:()=>true,close(){}}; },
  });
  const round = adapter.createRound({onFinal:value=>finals.push(value.text)});
  await adapter.start(round);
  assert.deepEqual(mic.openedWith,[keyword]);
  mic.frames(.1,3);
  edge.hit({aliasIndex:0,utteranceStartSample:0,replayFromSample:1600});
  stream.receive({type:'interim',text:'查'});
  await adapter.beforePlayback();
  assert.deepEqual(mic.processingUpdates,[]);
  stream.receive({type:'final',text:'查天气'});
  await adapter.beforePlayback();
  assert.deepEqual(mic.processingUpdates,[realtime]);
  assert.deepEqual(finals,['查天气']);
  adapter.setPolicy(wake);
  await adapter.beforePlayback();
  assert.deepEqual(mic.processingUpdates,[realtime,keyword]);
  adapter.setPolicy(active);
  await adapter.beforePlayback();
  assert.deepEqual(mic.processingUpdates,[realtime,keyword,realtime]);
  assert.equal(mic.calls(),1);
  adapter.stop(round);
});

test('unsupported track updates leave manual voice and finalized wake audio usable', async t => {
  const mic = microphone(t, async () => { throw new Error('Track update unsupported'); });
  let recognized = 0;
  const adapter = createPhoneCapture({ waveform(){}, phase(){}, mayRecord:()=>true,
    getPolicy:()=>({kind:'utterance'}),
    openWake() { return {write:()=>true,close(){}}; },
    async transcribe() { return {text:'已完成'}; },
  });
  const round = adapter.createRound({onFinal:()=>recognized++});
  await adapter.start(round);
  assert.equal(mic.openedWith[0].echoCancellation,true);
  adapter.setPolicy({kind:'wake',kws:{},aliases:['星河']});
  await adapter.beforePlayback();
  adapter.setPolicy({kind:'utterance'});
  await adapter.beforePlayback();
  mic.frames(.1,7);
  mic.frames(0,10);
  await round.queue;
  assert.equal(recognized,1);
  assert.equal(mic.calls(),1);
  adapter.stop(round);
});
