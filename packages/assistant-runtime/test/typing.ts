import { createAssistantSession, type ToolAdapter, type AssistantRunError } from '@rabilink/assistant-runtime/session';
import { createAgentProtocol } from '@rabilink/assistant-runtime/protocol';
import { createAgentTurnRuntime, type ToolPolicy } from '@rabilink/assistant-runtime/turn';
import { createAiuiAssistantRuntime, type AsrHandlers } from '@rabilink/assistant-runtime/aiui';
import { createAssistantConversation, type ConversationRunError } from '@rabilink/assistant-runtime/conversation';
import { createListeningLifecycle } from '@rabilink/assistant-runtime/listening';
import { createSpeechPlayback } from '@rabilink/assistant-runtime/playback';

const policy: ToolPolicy = {
  classify: decision => ({ mutation: decision.name === 'task.send' }),
  inspectOutcome: result => ({ uncertain: result === undefined, failed: false, terminal: false })
};
const adapter: ToolAdapter = {
  tools: [{ function: { name: 'task.send', parameters: { type: 'object' } } }],
  toolPolicy: policy,
  executeTool: event => ({ state: 'accepted', callId: event.callId })
};
const protocol = createAgentProtocol();
const model = { prompt: async () => '宿主回复' };
const session = createAssistantSession({ profile: { systemPrompt: '全局提示词' }, protocol,
  discoverTools: async ({ signal }) => { signal.throwIfAborted(); return adapter; },
  createModel: async options => { void options.initialPrompts; return model; }
});
const result = session.guide('完整引导');
session.notifyGuidance() satisfies boolean;
if (!result.accepted) result.reason satisfies 'idle' | 'finishing' | 'full';
void createAgentTurnRuntime({ protocol, model, toolPolicy: policy, executeTool: adapter.executeTool });
void session.run('带页面回调', { turnId: 'page-1', limits: { maxSteps: 8, interjectWhileWaiting: true }, takeGuidance: () => ['补充'],
  onText: value => { value.text satisfies string; }, onState: value => { void value.state; } })
  .then(value => { value.pendingGuidance satisfies string[] | undefined; });
// @ts-expect-error A backend policy cannot classify a mutation using text.
const invalid: ToolPolicy = { ...policy, classify: () => ({ mutation: 'yes' }) };
void invalid;
const recover = (error: AssistantRunError) => { error.pendingGuidance satisfies string[]; error.cause satisfies unknown; };
void recover;
const voiceRuntime = createAiuiAssistantRuntime({
  onInputStateChange: pending => { pending satisfies boolean; },
  asr: { createRound(_handlers?: AsrHandlers<{ text: string }>) { return { id: 1 }; }, start(_round: { id: number }) {}, stop(_round: { id: number }) {} },
  tts: { async synthesize() { return { task: { abort() {} }, player: { play() {}, destroy() {} } }; } }
});
voiceRuntime.getState().inputPending satisfies boolean;
const playback = createSpeechPlayback({ tts: voiceRuntime.tts,
  releaseSpeech: voiceRuntime.releaseSpeech,
  onEvent: event => { if (event.type === 'error') event.error satisfies unknown; },
  synthesisTimeoutMs: () => 30000 });
playback.speak('sentence', { voice: 'selected', volume: 0.5 }) satisfies boolean;
playback.getState().player?.play(); playback.cancel(); playback.dispose();
// @ts-expect-error The shared lifecycle owns cancellation and cue delivery.
playback.speak('invalid', { signal: new AbortController().signal });
const listening = createListeningLifecycle({ asr: voiceRuntime.asr,
  canStart: () => true, isActive: () => true,
  clock: { now: () => 0, setTimeout: (_callback, _ms) => 0, clearTimeout: (_timer: number) => {} },
  onEvent: event => { if (event.type === 'ended') event.emptyEnds satisfies number; }
});
listening.activate({ handlers: { onFinal: result => { result.text satisfies string; } } })?.id satisfies number | undefined;
listening.getState().restartPending satisfies boolean;
listening.pause(); listening.dispose();
// @ts-expect-error End is emitted by the lifecycle; it is not a transcript handler.
listening.activate({ handlers: { onEnd() {} } });
voiceRuntime.asr.createRound({ onFinal(value) { value.text satisfies string; } }).id satisfies number;
void voiceRuntime.tts.synthesize('测试').then(job => { job.player.play(); voiceRuntime.releaseSpeech(job); });
voiceRuntime.createSession({ profile: { systemPrompt: '系统提示' }, createModel: () => model, discoverTools: () => adapter });
voiceRuntime.dispose();
const conversation = createAssistantConversation({ session, scope: 'backend/host/generation',
  receipts: { has: async () => false, acknowledge: async () => true } });
conversation.supportsTurnGuard satisfies boolean;
conversation.supportsInterjectionReceipts satisfies boolean;
session.supportsInterjectionReceipts satisfies true;
session.supportsTurnGuard satisfies true;
void conversation.run('绑定原任务', { assertCurrent() {} });
void conversation.run('原任务', { inputScope: 'original-binding', assertCurrent() {} });
void conversation.interject({ id: 'handoff-1', scope: 'original-binding', text: '插话' }, { assertCurrent() {} })
  .then(value => {
    value.toolDispatched satisfies false;
    value.input.id satisfies string;
    if (value.status === 'answered') { value.text satisfies string; value.modelInvoked satisfies true; }
    if (value.status === 'returned' || value.status === 'unavailable') value.modelInvoked satisfies false;
    // @ts-expect-error Independent input identity is an immutable snapshot.
    value.input.text = 'changed';
  });
const recoverInput = (error: ConversationRunError) => {
  error.originalInput satisfies string;
  error.pendingGuidance satisfies string[] | undefined;
};
void recoverInput;
void conversation.observe({ id: 'turn-4-end', scope: 'backend/host/generation', kind: 'turn/end', status: 'idle', body: { text: '结果' } })
  .then(value => { if (value.status === 'processed') value.result.text satisfies string; });

import { createVoiceInteraction } from '../src/voice-interaction.js';
const voice = createVoiceInteraction({ runtime: voiceRuntime,
  outputEnabled: false,
  onInput: input => { input.text satisfies string; input.result?.text satisfies string | undefined; },
  onEvent: event => { if (event.type === 'response') event.foreground satisfies boolean; }
});
voice.activate({ handlers: { onFinal: result => { result.text satisfies string; } } });
voice.setOutputEnabled(true);
voice.getState().outputEnabled satisfies boolean;
// @ts-expect-error Output permission must be an explicit boolean.
voice.setOutputEnabled('true');
const reply = voice.beginResponse({ id: 'reply-1', speech: { voice: 'selected' } });
reply.append('文字'); reply.finish(); voice.interruptSpeech(); voice.dispose();

import { createResidentInteraction } from '../src/resident-interaction.js';
const resident = createResidentInteraction({
  openServices: async ({ signal }) => { signal.throwIfAborted(); return { runtime: voiceRuntime, async dispose() {} }; },
  onInput: input => { input.text satisfies string; },
  onEvent: event => { if (event.type === 'state') event.state.outputEnabled satisfies boolean; },
});
void resident.start(); resident.pauseCapture(); void resident.resumeCapture();
resident.setOutputEnabled(false); resident.beginResponse()?.finish(); void resident.stop(); void resident.dispose();
// @ts-expect-error Only explicit booleans are valid output commands.
resident.setOutputEnabled('false');
