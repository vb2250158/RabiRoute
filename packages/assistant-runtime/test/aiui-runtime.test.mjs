import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiuiAssistantRuntime } from '../src/aiui-runtime.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixtures(synthesis) {
  const rounds = [], jobs = [], signals = []; let starts = 0, stops = 0;
  const makeJob = () => {
    const stats = { aborts: 0, destroys: 0 };
    const job = { task: { abort() { stats.aborts++; } }, player: { destroy() { stats.destroys++; } }, stats };
    jobs.push(job); return job;
  };
  const asr = { createRound(handlers) { const round = { handlers }; rounds.push(round); return round; },
    start() { starts++; }, stop() { stops++; } };
  const tts = { async synthesize(text, options) { signals.push(options.signal); return synthesis ? synthesis(text, options, makeJob) : makeJob(); } };
  return { asr, tts, rounds, jobs, signals, makeJob, get starts() { return starts; }, get stops() { return stops; } };
}
const sessionOptions = createModel => ({ profile: { systemPrompt: 'shared profile' }, createModel,
  discoverTools: async () => ({ tools: [], executeTool() {}, toolPolicy: {
    classify: () => ({ mutation: false }), inspectOutcome: () => ({ uncertain: false, failed: false, terminal: false })
  } }) });

test('background observations wait for final ASR after speech end and foreground input runs first', async () => {
  const f=fixtures(), calls=[], changes=[];
  const runtime=createAiuiAssistantRuntime({...f,onInputStateChange:value=>changes.push(value),
    session:sessionOptions(()=>({prompt:async messages=>{calls.push(JSON.stringify(messages));return '已收到';}}))});
  const conversation=runtime.createConversation({scope:'test',receipts:{has:()=>false,acknowledge:()=>true}});
  let user;
  const round=runtime.asr.createRound({onFinal:result=>{user=conversation.run(result.text);}});
  round.handlers.onSpeechStart();round.handlers.onSpeechEnd();
  const observation=conversation.observe({id:'task:event:1',scope:'test',kind:'progress',status:'completed',body:'background result'});
  await tick();assert.equal(calls.length,0,'Speech end is not a final transcript receipt');
  assert.equal(runtime.getState().inputPending,true);
  round.handlers.onFinal({text:'foreground question'});
  await user;await observation;
  assert.match(calls[0],/foreground question/);assert.match(calls[1],/background result/);
  assert.deepEqual(changes,[true,false]);runtime.dispose();
});

test('recognition input state handles interim-only hosts, either final/end order, and replacement', async () => {
  const f=fixtures(),runtime=createAiuiAssistantRuntime(f);
  const round=runtime.asr.createRound();
  round.handlers.onInterim({text:'未说完'});assert.equal(runtime.getState().inputPending,true);
  round.handlers.onFinal({text:'完整输入'});assert.equal(runtime.getState().inputPending,false);
  round.handlers.onSpeechStart();round.handlers.onFinal({text:'仍在说话'});
  assert.equal(runtime.getState().inputPending,true);
  round.handlers.onSpeechEnd();assert.equal(runtime.getState().inputPending,false);
  round.handlers.onSpeechStart();runtime.asr.stop(round);assert.equal(runtime.getState().inputPending,false);
  const replacement=runtime.asr.createRound();replacement.handlers.onSpeechStart();
  round.handlers.onEnd();round.handlers.onError(Error('late'));assert.equal(runtime.getState().inputPending,true);
  replacement.handlers.onEnd();assert.equal(runtime.getState().inputPending,false);runtime.dispose();
});

test('a conversation created mid-utterance and a reentrant next round keep the current input priority', async () => {
  const f=fixtures(),runtime=createAiuiAssistantRuntime({...f,session:sessionOptions(()=>({prompt:async()=> 'reply'}))});
  let replacement;
  const old=runtime.asr.createRound({onEnd:()=>{replacement=runtime.asr.createRound();replacement.handlers.onSpeechStart();}});
  old.handlers.onSpeechStart();
  const conversation=runtime.createConversation({scope:'test',receipts:{has:()=>false,acknowledge:()=>true}});
  assert.equal(conversation.getState().listening,true);
  old.handlers.onEnd();assert.equal(runtime.getState().inputPending,true);assert.equal(conversation.getState().listening,true);
  replacement.handlers.onError(Error('current failure'));
  assert.equal(runtime.getState().inputPending,false);assert.equal(conversation.getState().listening,false);runtime.dispose();
});

test('speech onset stops only owned output while model and recognition remain active', async () => {
  const f = fixtures(), pending = deferred(); let modelDestroyed = 0, onsets = 0, playbackStops = 0;
  const runtime = createAiuiAssistantRuntime({ ...f, session: sessionOptions(() => ({
    prompt: () => pending.promise, destroy() { modelDestroyed++; }
  })) });
  assert.equal(f.starts, 0, 'Construction must not acquire a microphone');
  const round = runtime.asr.createRound({ onSpeechStart() { onsets++; } }); runtime.asr.start(round);
  const running = runtime.session.run('继续工作'); await tick();
  const job = await runtime.tts.synthesize('正在播报');
  job.player.stop = () => { playbackStops++; };
  job.task.abort = () => { assert.equal(onsets, 1, 'UI invalidation precedes synchronous player callbacks'); job.stats.aborts++; };
  round.handlers.onSpeechStart();
  assert.deepEqual(job.stats, { aborts: 1, destroys: 1 });
  assert.equal(playbackStops, 1);
  assert.equal(runtime.session.getState().busy, true); assert.equal(modelDestroyed, 0); assert.equal(f.stops, 0);
  assert.equal(runtime.releaseSpeech(job, { abort: true }).handled, true);
  assert.deepEqual(job.stats, { aborts: 1, destroys: 1 }, 'Page cleanup must not release the same native resources twice');
  pending.resolve('工作完成'); assert.equal((await running).text, '工作完成'); assert.equal(onsets, 1);
  runtime.dispose(); assert.equal(f.stops, 1); assert.equal(modelDestroyed, 1);
});

test('cancelled synthesis rejects immediately and retires late resources without publishing cues', async () => {
  const pending = deferred(); let cues = 0, options;
  const f = fixtures((_text, supplied) => { options = supplied; return pending.promise; });
  const runtime = createAiuiAssistantRuntime(f);
  const old = runtime.tts.synthesize('旧回复', { onCue() { cues++; } }); await tick();
  runtime.interruptSpeech(); await assert.rejects(old, /AIUI_SPEECH_CANCELLED/);
  const job = f.makeJob(); pending.resolve(job); await tick(); options.onCue({ text: '迟到' });
  assert.deepEqual(job.stats, { aborts: 1, destroys: 1 }); assert.equal(cues, 0);
  assert.equal(options.signal.aborted, true); runtime.dispose();
});

test('stale recognition callbacks and delayed cleanup cannot affect a replacement', async () => {
  const f = fixtures(); let finals = 0, ended = 0;
  const runtime = createAiuiAssistantRuntime(f);
  const oldRound = runtime.asr.createRound({ onFinal() { finals++; }, onEnd() { ended++; } });
  runtime.asr.start(oldRound);
  const newRound = runtime.asr.createRound({ onFinal() { finals++; } });
  assert.throws(() => runtime.asr.start(oldRound), /AIUI_ASR_ROUND_INACTIVE/);
  const oldJob = await runtime.tts.synthesize('旧');
  const newJob = await runtime.tts.synthesize('新');
  oldRound.handlers.onSpeechStart(); oldRound.handlers.onFinal({ text: '迟到' }); oldRound.handlers.onEnd();
  assert.equal(finals, 0); assert.equal(ended, 0);
  runtime.releaseSpeech(oldJob, { abort: true });
  assert.deepEqual(newJob.stats, { aborts: 0, destroys: 0 });
  newRound.handlers.onFinal({ text: '有效' }); assert.equal(finals, 1);
  runtime.dispose();
});

test('external abort owns only its output, and completion releases without aborting a finished task', async () => {
  const f = fixtures(), signal = new AbortController(), runtime = createAiuiAssistantRuntime(f);
  const old = await runtime.tts.synthesize('旧', { signal: signal.signal });
  const current = await runtime.tts.synthesize('新'); signal.abort();
  assert.deepEqual(current.stats, { aborts: 0, destroys: 0 });
  assert.throws(() => runtime.releaseSpeech({ task: old.task, player: current.player }), /AIUI_SPEECH_OWNER_MISMATCH/);
  runtime.releaseSpeech(current);
  assert.deepEqual(current.stats, { aborts: 0, destroys: 1 });
  runtime.dispose(); assert.equal(current.stats.destroys, 1);
});

test('session replacement disposes late model candidates, while voice suspension retains the model', async () => {
  const f = fixtures(), pending = deferred(); let oldDestroyed = 0, currentDestroyed = 0;
  const runtime = createAiuiAssistantRuntime(f);
  const old = runtime.createSession(sessionOptions(() => pending.promise));
  const oldReady = old.ready(); const rejection = assert.rejects(oldReady, /ASSISTANT_INITIALIZATION_CANCELLED/); await tick();
  const current = runtime.createSession(sessionOptions(() => ({ prompt: async () => '新会话', destroy() { currentDestroyed++; } })));
  assert.throws(() => runtime.createSession({}), /ASSISTANT_DEPENDENCIES_REQUIRED/);
  assert.equal(runtime.session, current);
  await current.ready(); pending.resolve({ prompt() {}, destroy() { oldDestroyed++; } }); await rejection; await tick();
  assert.equal(oldDestroyed, 1); assert.equal(currentDestroyed, 0);
  runtime.asr.createRound(); await runtime.tts.synthesize('暂停'); runtime.suspendVoice();
  assert.equal((await current.run('继续')).text, '新会话'); assert.equal(currentDestroyed, 0);
  runtime.dispose(); assert.equal(currentDestroyed, 1);
  assert.throws(() => runtime.asr.createRound(), /AIUI_RUNTIME_CLOSED/);
  assert.throws(() => runtime.createSession(sessionOptions(() => ({}))), /AIUI_RUNTIME_CLOSED/);
});

test('cleanup errors do not prevent other resources from being released', async () => {
  const f = fixtures(), errors = []; let destroyed = 0;
  f.asr.stop = () => { throw Error('stop failed'); };
  const runtime = createAiuiAssistantRuntime({ ...f, onCleanupError: error => errors.push(error.message),
    session: sessionOptions(() => ({ prompt: async () => '回复', destroy() { destroyed++; } })) });
  await runtime.session.ready(); runtime.asr.createRound(); const job = await runtime.tts.synthesize('播报');
  assert.equal(runtime.dispose().length, 1); assert.deepEqual(errors, ['stop failed']);
  assert.equal(destroyed, 1); assert.deepEqual(job.stats, { aborts: 1, destroys: 1 });
});

test('already-aborted or invalid speech requests leave current playback intact', async () => {
  const f = fixtures(), runtime = createAiuiAssistantRuntime(f), controller = new AbortController();
  const job = await runtime.tts.synthesize('当前回复'); controller.abort();
  await assert.rejects(runtime.tts.synthesize('已取消', { signal: controller.signal }), /AIUI_SPEECH_CANCELLED/);
  assert.throws(() => runtime.tts.synthesize(''), /AIUI_SPEECH_INPUT_INVALID/);
  assert.deepEqual(job.stats, { aborts: 0, destroys: 0 }); runtime.dispose();
});

test('an asynchronous ASR start failure releases its own round and cannot stop a replacement', async () => {
  const f = fixtures(), pending = deferred(); let started = 0;
  f.asr.start = () => { if (++started === 1) return pending.promise.then(() => { throw Error('capability failed'); }); };
  const runtime = createAiuiAssistantRuntime(f);
  const old = runtime.asr.createRound(); const first = runtime.asr.start(old);
  const next = runtime.asr.createRound(); runtime.asr.start(next);
  const stopped = f.stops; pending.resolve(); await assert.rejects(first, /capability failed/);
  assert.equal(f.stops, stopped); assert.equal(runtime.getState().hasRecognitionRound, true); runtime.dispose();
});
