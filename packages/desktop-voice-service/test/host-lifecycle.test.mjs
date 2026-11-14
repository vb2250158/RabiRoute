import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createResidentHost } from '../src/assistant-host.mjs';
import { initialAssistantSettings } from '../src/assistant-settings.mjs';

test('resident stop drains capture before closing device, and can start again', async () => {
  const events = [];
  const config = {...initialAssistantSettings(), electronExecutable:process.execPath,
    asrMode:'native', ttsModel:'fixture', ttsVoice:'fixture'};
  const host = createResidentHost({settings:()=>config, saveSettings:async()=>{},
    credentials:{describe:async()=>({configured:true})},
    conversation:()=>({open:async()=>{},getSessionId:()=>null,close:()=>{}}),
    observeOutput:()=>()=>{}, speech:()=>({catalog:async()=>({maxAudioBytes:1000})}),
    createProviders:()=>({synthesize:async()=>Buffer.alloc(2)}),
    deviceFactory:async({signal})=>{
      let closed=false;
      const close=async()=>{closed=true;events.push('close')};
      signal.addEventListener('abort',()=>{void close()},{once:true});
      return {close,configurePresenter:async()=>{},present:async()=>{
        if(closed)throw Error('DEVICE_CLOSED');
      },createRecording:()=>{let disposal;return {start:async()=>{},amplitude:()=>0,
        dispose:()=>disposal??=(async()=>{await delay(5);if(closed)throw Error('DEVICE_CLOSED');events.push('capture-disposed')})(),
      }}};
    },
  });
  try {
    for(let i=0;i<2;i++) {
      await host.command({action:'start'});
      await host.command({action:'stop'});
      await delay(65);
      assert.equal((await host.state()).error,null);
      assert.equal((await host.state()).voice.phase,'stopped');
    }
    assert.deepEqual(events,['capture-disposed','close','capture-disposed','close']);
  } finally {await host.dispose()}
});
