import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useSpeechStore } from "../src/stores/speechStore";
import { speechControlClient } from "../src/speech/speechControlClient";

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
