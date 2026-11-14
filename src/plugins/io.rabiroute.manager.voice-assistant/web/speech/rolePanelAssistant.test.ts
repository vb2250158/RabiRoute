import test from "node:test";
import assert from "node:assert/strict";
import { createRolePanelAssistant } from "./rolePanelAssistant.js";
import { createAiuiAssistantRuntime } from "../../../../../packages/assistant-runtime/src/aiui-runtime.js";
import { createVoiceInteraction } from "../../../../../packages/assistant-runtime/src/voice-interaction.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const admissions: ((value: any) => void)[] = [], spoken: string[] = [], replies: string[] = [], errors: unknown[] = [];
  const runtime = createAiuiAssistantRuntime({ asr: { createRound: () => ({}), start() {}, stop() {} },
    tts: { async synthesize(text: string) {
      spoken.push(text); let ended: (() => void) | undefined;
      return { task: { abort() {} }, player: { play() { queueMicrotask(() => ended?.()); }, stop() {}, destroy() {},
        audioPlayer: { onEnded(callback: () => void) { ended = callback; } } } };
    } }
  });
  const voice = createVoiceInteraction({ runtime, onInput: input => assistant.send(input.text), onError: error => errors.push(error) });
  const assistant = createRolePanelAssistant({ roleId: "role", gatewayId: "route", voice,
    send: () => new Promise(resolve => admissions.push(resolve)), onAdmission() {},
    onReply: reply => replies.push(reply.text), onError: error => errors.push(error)
  });
  const reply = (input: string, id: string, text: string) => assistant.receive({ roleId: "role", gatewayId: "route", replyToMessageId: input, messageId: id, text });
  return { voice, assistant, admissions, spoken, replies, errors, reply,
    dispose() { assistant.dispose(); voice.dispose(); runtime.dispose(); } };
}

test("committed reply arriving before HTTP admission is correlated once, including reconnect replay", async () => {
  const f = fixture();
  f.voice.submitText("hello");
  f.reply("input-1", "reply-1", "Hello.");
  assert.deepEqual(f.spoken, []);
  f.admissions[0]!({ roleId: "role", messageId: "input-1" });
  await tick(); await tick();
  f.reply("input-1", "reply-1", "Hello.");
  assert.deepEqual(f.replies, ["Hello."]);
  assert.deepEqual(f.spoken, ["Hello."]);
  f.reply("input-1", "reply-2", "Work finished.");
  await tick(); await tick();
  assert.deepEqual(f.spoken, ["Hello.", "Work finished."]);
  f.dispose();
});

test("onset while native work is pending suppresses TTS but retains delivered text", async () => {
  const f = fixture();
  f.voice.submitText("work");
  f.voice.interruptSpeech("speech-onset");
  f.admissions[0]!({ messageId: "input-1" });
  await tick();
  f.reply("input-1", "reply-1", "Still completed.");
  await tick();
  assert.deepEqual(f.replies, ["Still completed."]);
  assert.deepEqual(f.spoken, []);
  f.dispose();
});

test("out-of-order old replies remain text; another role or route never enters this voice owner", async () => {
  const f = fixture();
  f.voice.submitText("first"); f.voice.submitText("second");
  f.admissions[1]!({ messageId: "input-2" }); f.admissions[0]!({ messageId: "input-1" });
  await tick();
  f.reply("input-1", "reply-1", "Old result.");
  f.assistant.receive({ roleId: "other", gatewayId: "route", replyToMessageId: "input-2", messageId: "unrelated", text: "private" });
  f.assistant.receive({ roleId: "role", gatewayId: "other", replyToMessageId: "input-2", messageId: "unrelated", text: "private" });
  f.reply("input-2", "reply-2", "Current result.");
  await tick(); await tick();
  assert.deepEqual(f.replies, ["Old result.", "Current result."]);
  assert.deepEqual(f.spoken, ["Current result."]);
  f.dispose();
});

test("uncertain admission retains identity without resubmitting native work", async () => {
  const f = fixture();
  f.voice.submitText("work");
  f.admissions[0]!({ messageId: "input-1", uncertain: true });
  await tick(); f.reply("input-1", "reply-1", "Actually accepted."); await tick();
  assert.equal(f.admissions.length, 1);
  assert.deepEqual(f.replies, ["Actually accepted."]);
  f.dispose(); f.reply("input-1", "late", "Closed.");
  assert.equal(f.replies.length, 1);
});
