import test from 'node:test';
import assert from 'node:assert/strict';
import { speechFieldError, assistantSetupGaps } from '../ui/assistant-panel.js';
test('configuration guidance distinguishes native ASR and missing standalone models',()=>{
  const state={settings:{asrMode:'native',ttsModel:'tts',ttsVoice:'voice'},capabilities:{host:'dsh'},selectedModel:{provider:'host',model:'model'},credentials:{asr:{configured:false},tts:{configured:true}}};
  assert.deepEqual(assistantSetupGaps(state),[]);
  assert.equal(assistantSetupGaps({...state,selectedModel:{provider:'host'}})[0].section,'conversation');
  assert.equal(assistantSetupGaps({...state,capabilities:{host:'dsh',hostModels:[]}})[0].section,'conversation');
  const gaps=assistantSetupGaps({...state,settings:{...state.settings,ttsVoice:''},capabilities:{host:'standalone'}});
  assert.deepEqual(gaps.map(item=>item.section),['conversation','tts']);
});
test('speech form rejects empty, fractional and out-of-range numbers without coercing them to defaults',()=>{
  const vad={type:'number',min:300,max:5000,integer:true};
  for(const value of ['',NaN,Infinity,'800',299,5001,800.5])assert.ok(speechFieldError(vad,value));
  for(const value of [300,800,5000])assert.equal(speechFieldError(vad,value),'');
  assert.equal(speechFieldError({type:'number',min:0,max:1},.5),'');
  assert.ok(speechFieldError({type:'textarea',maxLength:3},'1234'));
});
