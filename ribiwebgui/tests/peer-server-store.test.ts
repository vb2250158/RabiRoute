import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useSpeechStore } from "../src/stores/speechStore";
import { speechControlClient } from "../../src/plugins/io.rabiroute.manager.speech/web/speech/speechControlClient";
import type { SpeechRuntimeStatus } from "@shared/speechControlContract";

const online: SpeechRuntimeStatus = {
  state: "online",
  checkedAt: "",
  configuredUrl: "http://127.0.0.1:1",
  defaults: {},
  providers: { tts: [], asr: [] }
};

test("a slow status response cannot overwrite a newer refresh", async t => {
  setActivePinia(createPinia());
  let resolveOld!: (status: SpeechRuntimeStatus) => void;
  const oldStatus = new Promise<SpeechRuntimeStatus>(resolve => { resolveOld = resolve; });
  const responses = [oldStatus, Promise.resolve(online)];
  t.mock.method(speechControlClient, "status", () => responses.shift());
  const store = useSpeechStore();
  const old = store.refreshStatus(true);
  await store.refreshStatus();
  resolveOld({ ...online, state: "offline" });
  await old;
  assert.deepEqual(store.status, online);
  assert.equal(store.loading, false);
});

test("leaving during the initial check allows the next visit to read fresh status", async t => {
  setActivePinia(createPinia());
  let resolveOld!: (status: SpeechRuntimeStatus) => void;
  const offline = { ...online, state: "offline" as const };
  const oldStatus = new Promise<SpeechRuntimeStatus>(resolve => { resolveOld = resolve; });
  const responses = [oldStatus, Promise.resolve(offline)];
  const readStatus = t.mock.method(speechControlClient, "status", () => responses.shift());
  const store = useSpeechStore();
  let releaseFirst!: () => void;
  const first = store.acquire(release => { releaseFirst = release; });
  releaseFirst();
  const releaseSecond = await store.acquire();
  assert.equal(readStatus.mock.callCount(), 2);
  assert.deepEqual(store.status, offline);
  resolveOld(online);
  await first;
  assert.deepEqual(store.status, offline);
  releaseSecond();
});

test("switching servers discards pending records and speaker responses", async t => {
  setActivePinia(createPinia());
  let recordsDone!: (value: any) => void, speakersDone!: (value: any) => void;
  t.mock.method(speechControlClient,"records",()=>new Promise(resolve=>{recordsDone=resolve;}));
  t.mock.method(speechControlClient,"speakers",()=>new Promise(resolve=>{speakersDone=resolve;}));
  t.mock.method(speechControlClient,"status",async()=>({state:"offline"}));
  t.mock.method(speechControlClient,"models",async()=>({models:[]}));
  const store = useSpeechStore();
  const records = store.refreshRecords(), speakers = store.refreshSpeakers();
  await store.changeServer();
  recordsDone({records:[{id:"old-server"}]}); speakersDone({speakers:[{id:"old-server"}]});
  await Promise.all([records,speakers]);
  assert.deepEqual(store.records,[]); assert.equal(store.speakerRegistry,null);
  assert.equal(store.recordsLoading,false); assert.equal(store.speakersLoading,false);
});
