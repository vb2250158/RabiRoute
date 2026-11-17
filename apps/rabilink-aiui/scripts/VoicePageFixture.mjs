import fs from 'node:fs';
import vm from 'node:vm';
import { createAiuiAssistantRuntime } from '../../../packages/assistant-runtime/src/aiui-runtime.js';
import { createVoiceInteraction } from '../../../packages/assistant-runtime/src/voice-interaction.js';
import { guidancePageMethods } from '../utils/guidance-page.js';
import {createVisualCanvas,createVisualCanvasTools,paintVisualCanvas,withVisualCanvasProtocol} from '../../../packages/assistant-runtime/src/visual-canvas.js';
const canvasStorage=new Map();
const canvasMethods=vm.runInNewContext(fs.readFileSync(new URL('../utils/visual-canvas-page.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export const ','const ')+'\nvisualCanvasPageMethods',{
 createVisualCanvas,createVisualCanvasTools,paintVisualCanvas,withVisualCanvasProtocol,window:{innerWidth:480,innerHeight:352},wx:{getStorageSync:key=>canvasStorage.get(key),setStorageSync:(key,value)=>canvasStorage.set(key,structuredClone(value)),createCanvasContext:()=>null}
});
const source = fs.readFileSync(new URL('../pages/home/index.ink', import.meta.url), 'utf8');
const start = source.indexOf('  ensureVoiceInteraction() {');
const end = source.indexOf('  onListeningLifecycleEvent(event)', start);
const methods = vm.runInNewContext('({' + source.slice(start, end).trim().replace(/,$/, '') + '})', {
  createVoiceInteraction, console, cloudSafeMessage: String,
  TRANSCRIPTION_RESTART_DELAY_MS: 250, ASR_EARLY_END_MS: 1000, ASR_EMPTY_END_LIMIT: 3
});

// Use production page wiring and shared loop; only native resources are fixtures.
export function attachPageVoiceFixture(page) {
  for(const [key,value] of Object.entries(canvasMethods))page[key]||=value;
  if (typeof page.beginVoiceResponse !== 'function') Object.assign(page, methods);
  page.interruptAiuiPlayback ||= guidancePageMethods.interruptAiuiPlayback;
  page.onListeningLifecycleEvent ||= () => {};
  page.onSpeechPlaybackEvent ||= () => {};
  page.speechSynthesisTimeoutMs ||= () => 1000;
  page.speechPlaybackTimeoutMs ||= () => 1000;
  page.aiuiRuntime ||= createAiuiAssistantRuntime({
    asr: { createRound: handlers => ({ handlers }), start(round) { round.handlers.onStart?.(); }, stop() {} },
    tts: page.ttsAdapter || { async synthesize(text) {
      page.speakText?.(text);
      const audioPlayer = new EventTarget();
      return { task: { abort() {} }, player: { audioPlayer,
        play() { queueMicrotask(() => audioPlayer.dispatchEvent(new Event('ended'))); }, destroy() {} } };
    } }
  });
  return page;
}
