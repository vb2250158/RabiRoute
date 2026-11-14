import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantCapture, encodePcmWave } from "./assistantCapture.js";

test("PCM utterance is a standalone mono WAV, with clipping and the actual sample rate", async () => {
  const view = new DataView(await encodePcmWave([new Float32Array([-2, 0, 2])], 16000).arrayBuffer());
  assert.equal(view.byteLength, 50); assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32768); assert.equal(view.getInt16(48, true), 32767);
});

test("closing during permission acquisition stops the late stream without starting audio", async () => {
  let grant!: (value: MediaStream) => void, stopped = 0, started = 0;
  const adapter = createAssistantCapture({ transcribe: async () => ({ text: "" }),
    getUserMedia: () => new Promise(resolve => { grant = resolve; }), createContext: () => { throw new Error("must not create"); } });
  const round = adapter.createRound({ onStart: () => started++ });
  const start = adapter.start(round); adapter.stop(round);
  grant({ getTracks: () => [{ stop: () => stopped++ }] } as unknown as MediaStream);
  await start; assert.equal(stopped, 1); assert.equal(started, 0);
});

test("capture remains active during ASR; stop discards a late recognition result", async () => {
  let complete!: (value: { text: string }) => void;
  let process: ((event: any) => void) | null = null, stopped = 0, starts = 0, ends = 0, finals = 0;
  const processor = { connect() {}, disconnect() {}, get onaudioprocess() { return process; }, set onaudioprocess(value) { process = value; } };
  const adapter = createAssistantCapture({ transcribe: () => new Promise(resolve => { complete = resolve; }),
    getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++, addEventListener() {} }] }) as unknown as MediaStream,
    createContext: () => ({ sampleRate: 16000, resume: async () => {}, close: async () => {}, destination: {},
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), createScriptProcessor: () => processor,
      createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }) }) as unknown as AudioContext });
  const round = adapter.createRound({ onSpeechStart: () => starts++, onSpeechEnd: () => ends++, onFinal: () => finals++ });
  await adapter.start(round);
  const frame = (value: number) => process?.({ inputBuffer: { getChannelData: () => new Float32Array(1024).fill(value) } });
  frame(.1); for (let i = 0; i < 10; i++) frame(0);
  await Promise.resolve();
  frame(.1);
  assert.equal(starts, 2); assert.equal(ends, 1); assert.equal(stopped, 0);
  adapter.stop(round); complete({ text: "stale" }); await round.queue;
  assert.equal(stopped, 1); assert.equal(finals, 0); assert.equal(process, null);
});
