import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createSystemRecognitionSample } from './recognition-sample.mjs';

const ids=['model','asr','tts','microphone','voice'];
const safeError=error=>/^[A-Z][A-Z0-9_]+$/.test(error?.message)?error.message:'ASSISTANT_TEST_FAILED';

/** Host owns evidence. Configuration changes make prior results visibly stale. */
export async function createAssistantDiagnostics({directory,settings,host,conversation,recognize,createSample=createSystemRecognitionSample}) {
  const path=join(directory,'checks.json');
  let records={},running,admitting=false,job={status:'idle',current:null,completed:0,total:0},serial=Promise.resolve();
  try { records=JSON.parse(await readFile(path,'utf8')); }
  catch(error) { if(error.code!=='ENOENT')throw Error('ASSISTANT_CHECKS_FILE_INVALID'); }
  for(const record of Object.values(records))if(record.status==='running') {
    record.status='failed';record.detail='上次测试中断，请重新测试';
  }
  const signature=(id,config=settings())=>{
    const prefixes=id==='model'?['llm','persona']:id==='asr'?['asr']:id==='tts'?['tts','outputDeviceId']:id==='microphone'?['inputDeviceId','electronExecutable']:['llm','persona','asr','tts','inputDeviceId','outputDeviceId','silence','electronExecutable'];
    const values=Object.fromEntries(Object.entries(config).filter(([key])=>!key.endsWith('Profiles')&&prefixes.some(prefix=>key.startsWith(prefix))));
    return createHash('sha256').update(JSON.stringify(['asr','voice'].includes(id)?{...values,sampleSource:'system-speech-v1'}:values)).digest('hex');
  };
  const persist=()=>{
    const snapshot=JSON.stringify(records);
    const operation=serial.then(async()=>{const temporary=path+'.'+randomUUID()+'.tmp';await writeFile(temporary,snapshot,{mode:0o600});await rename(temporary,path)});
    serial=operation.catch(()=>{});return operation;
  };
  const record=async(id,status,detail,config=settings())=>{
    records[id]={status,detail,checkedAt:new Date().toISOString(),signature:signature(id,config)};
    await persist();
  };
  const begin=id=>{job={...job,current:id};records[id]={status:'running',detail:'正在测试，请稍候',signature:signature(id)};};
  const complete=()=>{job={...job,completed:Math.min(job.total,job.completed+1)};};
  const testModel=async text=>{
    const config=settings();
    if(!config.llmModel)throw Error('ASSISTANT_MODEL_REQUIRED');
    await conversation.submit(text||'这是连接测试，请只回复：连接正常。','test-'+randomUUID());
    await conversation.drain();
    const turn=conversation.activity();
    if(turn.status!=='completed')throw Error(turn.error||'ASSISTANT_MODEL_FAILED');
    await record('model','passed','已收到真实回复',config);
  };
  const testOne=async id=>{
    const config=settings(),started=Date.now();
    if(id==='asr') {
      if(!recognize)throw Error('ASR_SAMPLE_TEST_UNAVAILABLE');
      const audio=await createSample();
      const result=await recognize(audio,new AbortController().signal);
      if(!result.text.trim())throw Error('ASR_TEST_EMPTY');
      await record(id,'passed','识别结果「'+result.text.slice(0,80)+'」 · '+((Date.now()-started)/1000).toFixed(1)+' 秒',config);
      return result.text;
    }
    if(id==='model') {await testModel();return;}
    if(id==='tts') {
      const result=await host.command({action:'test-playback'});
      if(!result.played)throw Error('SPEECH_PLAYBACK_TIMEOUT');
      await record(id,'passed','示例语音播放完成 · 请确认扬声器声音',config);return;
    }
    if(id==='microphone') {
      const result=await host.command({action:'test-microphone'});
      if(!result.bytes)throw Error('MICROPHONE_NO_AUDIO');
      await record(id,result.audible?'passed':'warning',result.audible?'录音成功，检测到输入信号 · 3 秒':'录音成功，未检测到说话声，请开口后重测',config);
      return;
    }
    throw Error('ASSISTANT_CHECK_INVALID');
  };
  const voiceLoop=async transcript=>{
    let acquired=false;
    try {
      begin('voice');
      await host.command({action:'start'});acquired=true;
      await host.command({action:'pause'});
      const before=(await host.state()).playback.completed;
      begin('model');await testModel('请用一句简短的话回应这句测试语音：「'+transcript+'」。');complete();
      begin('tts');
      let ended=false;
      for(let i=0;i<100;i++) {
        const current=await host.state();
        if(current.error)throw Error(current.error);
        if(current.playback.completed>before){ended=true;break;}
        await delay(300);
      }
      if(!ended)throw Error('SPEECH_PLAYBACK_TIMEOUT');
      await record('tts','passed','模型回复已播报，收到播放结束回执');complete();
      begin('voice');await host.command({action:'resume'});
      const stopped=await host.command({action:'stop'});acquired=false;
      if(stopped.error||stopped.voice.phase!=='stopped')throw Error(stopped.error||'VOICE_STOP_FAILED');
      await record('voice','passed','示例识别 → 模型回复 → 播报完成；暂停、恢复和停止成功');complete();
    } finally {if(acquired)await host.command({action:'stop'});}
  };
  return {
    snapshot() {
      const checks=Object.fromEntries(ids.map(id=>{
        const value=records[id];
        return [id,value?{status:value.signature===signature(id)?value.status:'stale',detail:value.detail,checkedAt:value.checkedAt}: {status:'untested'}];
      }));
      return {checks,job};
    },
    async confirmPlayback(heard) {
      if(typeof heard!=='boolean')throw Error('ASSISTANT_CHECK_INVALID');
      if(running||admitting)throw Error('ASSISTANT_CHECK_BUSY');
      if(!records.tts||records.tts.signature!==signature('tts')||!['passed','warning'].includes(records.tts.status))throw Error('ASSISTANT_CHECK_INVALID');
      await record('tts',heard?'passed':'warning',heard?'播放流程完成，用户已确认听到声音':'播放器已结束，但用户未听到声音；请检查输出设备和系统音量');
    },
    async recordModel(config) {await record('model','passed','已收到真实回复',config);},
    async invalidate(id) {delete records[id];delete records.voice;await persist();},
    async run(requested) {
      if(running||admitting)throw Error('ASSISTANT_CHECK_BUSY');
      admitting=true;
      try {if((await host.state()).voice.phase!=='stopped')throw Error('ASSISTANT_STOP_VOICE_BEFORE_TEST');}
      finally {admitting=false;}
      const all=requested==='all';
      if(!all&&!ids.includes(requested))throw Error('ASSISTANT_CHECK_INVALID');
      if(requested==='voice')throw Error('ASSISTANT_CHECK_INVALID');
      if((all||requested==='tts')&&settings().outputEnabled===false)throw Error('SPEECH_TEST_UNMUTE_REQUIRED');
      if(all)for(const id of ['model','tts','voice'])delete records[id];
      const sequence=all?['asr','microphone']:[requested];
      job={status:'running',current:sequence[0],completed:0,total:all?5:1,startedAt:new Date().toISOString()};
      running=(async()=>{
        let transcript;
        for(const id of sequence) {
          begin(id);
          try {const result=await testOne(id);if(id==='asr')transcript=result;}
          catch(error){await record(id,'failed',safeError(error));}
          complete();
        }
        if(all) {
          if(transcript) {
            try {await voiceLoop(transcript);}
            catch(error) {
              const current=job.current;
              await record(current,'failed',safeError(error));
              for(const id of ['model','tts','voice'])if(id!==current&&records[id]?.status!=='passed')await record(id,'failed','前一步未通过，尚未完成测试');
            }
          } else {
            for(const id of ['model','tts','voice'])await record(id,'failed','请先修复语音识别，再运行完整测试');
          }
        }
        job={...job,status:'completed',current:null,completed:job.total,finishedAt:new Date().toISOString()};
      })().catch(error=>{job={...job,status:'failed',current:null,error:safeError(error)};}).finally(()=>{running=undefined;});
      return {started:true};
    },
    async drain() {await running;await serial;},
  };
}
