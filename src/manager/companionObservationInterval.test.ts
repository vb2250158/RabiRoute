import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CompanionIntervalAudio, readCompanionObservationPolicy, validateCompanionInterval } from "./companionObservationInterval.js";
import { CompanionActivity } from "./companionActivity.js";
import type { CompanionObservation } from "../shared/companionActivity.js";

const policy = readCompanionObservationPolicy(JSON.parse(readFileSync("packages/rabi-companion/observation.json", "utf8")));
const jpeg = Buffer.from([255, 216, 255, 217]).toString("base64");
function observation(startedAt: number, endedAt: number, value = 1000): CompanionObservation {
  const pcm = Buffer.alloc((endedAt - startedAt) * 32);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i);
  return { sequence: 1, capturedAt: endedAt, source: "window", jpeg,
    window: { id: "game:1", title: "Example", processName: "example.exe" },
    audio: { startedAt, endedAt, pcm: pcm.toString("base64"), status: "ready", missingMs: 0, suppressedMs: 0 },
    interval: { startedAt, endedAt, frameTimes: [startedAt + 1, endedAt], sampleCount: 5, coverageStartedAt: startedAt + 1, jpeg } };
}

test("interval validation rejects unordered, excessive and wrong-boundary panels", () => {
  const row = observation(1000, 3000);
  assert.deepEqual(validateCompanionInterval(row, 1000), Buffer.from(jpeg, "base64"));
  assert.throws(() => validateCompanionInterval(row, 2000), /interval/);
  row.interval!.frameTimes.reverse();
  assert.throws(() => validateCompanionInterval(row, 1000), /interval/);
  assert.throws(() => readCompanionObservationPolicy({ ...policy, storyboardFrames: 100 }), /policy/);
});

test("incremental audio trims uncertain-write overlap, freezes exact WAV and never replays consumed PCM", () => {
  const audio = new CompanionIntervalAudio();
  const first = observation(1000, 3000);
  audio.append(audio.validate(first), 1000, 3000);
  audio.append(audio.validate(observation(2000, 4000, 2000)), 1000, 4000);
  const frozen = audio.freeze(1000, 4000);
  assert.equal(frozen.missingMs, 0);
  assert.equal(frozen.wav!.length, 44 + 3000 * 32);
  assert.equal(frozen.wav!.readUInt32LE(24), 16000);
  assert.equal(frozen.wav!.readInt16LE(44 + 1999 * 32), 1000);
  assert.equal(frozen.wav!.readInt16LE(44 + 2000 * 32), 2000);
  assert.equal(audio.freeze(4000, 5000).wav, null);
  assert.equal(audio.freeze(4000, 5000).missingMs, 1000);
  const bad = observation(5000, 6000); bad.audio!.pcm = "AA==";
  assert.throws(() => audio.validate(bad), /PCM16/);
});

test("silent or excluded audio reports coverage without hallucinating a transcript", () => {
  const audio = new CompanionIntervalAudio(), row = observation(1000, 3000, 0);
  row.audio!.suppressedMs = 500; row.audio!.missingMs = 200;
  audio.append(audio.validate(row), 1000, 3000);
  const frozen = audio.freeze(1000, 3000);
  assert.equal(frozen.wav, null); assert.equal(frozen.status, "silent");
  assert.equal(frozen.suppressedMs, 500); assert.equal(frozen.missingMs, 200);
});

test("review pairs the frozen interval with ASR while newer screen observations continue", async t => {
  let now = 1000, release!: (text: string) => void;
  const deliveries: { text: string; frame: Buffer | null }[] = [];
  const service = new CompanionActivity({ observationPolicy: policy, now: () => now,
    presets: [{ id: "watch", label: "Watch", labelEn: "Watch", guidance: "observe", reviewSeconds: 25, replyAgeSeconds: 180 }],
    context: async () => "# Example persona", changed: () => {}, reaction: () => {}, speak: async () => {}, cancelSpeech: async () => {}, save: async () => {},
    transcribe: async (_id, wav) => { assert.equal(wav.length, 44 + 2000 * 32); return new Promise(resolve => { release = resolve; }); },
    deliver: async (_session, review) => { deliveries.push(review); } });
  t.after(() => service.dispose());
  const session = (await service.start("example", { requestId: "interval-001", gatewayId: "route", presetId: "watch", title: "",
    autoReview: false, voice: false, saveSummary: false, observationOwner: "desktop" })).session!;
  now = 3000;
  service.observe("example", session.id, 1, observation(1000, 3000));
  const pending = service.review("example", session.id, 1, "");
  assert.equal(service.snapshot("example").session!.observationStartedAt, 3000);
  now = 5000;
  service.observe("example", session.id, 1, { ...observation(3000, 5000), sequence: 2 });
  release("First interval spoken line"); await pending;
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].text, /First interval spoken line/);
  assert.match(deliveries[0].text, /"startedAt":1000,"endedAt":3000/);
  assert.doesNotMatch(deliveries[0].text, /"endedAt":5000/);
});

test("a foreground switch cancels pending ASR and prevents delivery from the old scene", async t => {
  let now = 1000, release!: (text: string) => void, signal!: AbortSignal, sent = 0;
  const service = new CompanionActivity({ observationPolicy: policy, now: () => now,
    presets: [{ id: "watch", label: "Watch", labelEn: "Watch", guidance: "observe", reviewSeconds: 25, replyAgeSeconds: 180 }],
    context: async () => "# Example persona", changed: () => {}, reaction: () => {}, speak: async () => {}, cancelSpeech: async () => {}, save: async () => {},
    transcribe: async (_id, _wav, cancellation) => { signal = cancellation; return new Promise(resolve => { release = resolve; }); },
    deliver: async () => { sent++; } });
  t.after(() => service.dispose());
  const session = (await service.start("example", { requestId: "interval-002", gatewayId: "route", presetId: "watch", title: "",
    autoReview: false, voice: false, saveSummary: false, observationOwner: "desktop" })).session!;
  now = 3000; service.observe("example", session.id, 1, observation(1000, 3000));
  const pending = service.review("example", session.id, 1, "");
  now = 4000;
  service.observe("example", session.id, 1, { sequence: 2, capturedAt: now, source: "window", jpeg,
    window: { id: "second:2", title: "Other", processName: "other.exe" } });
  assert.equal(signal.aborted, true);
  release("obsolete audio"); await pending;
  assert.equal(sent, 0);
  assert.equal(service.snapshot("example").session!.revision, 2);
});
