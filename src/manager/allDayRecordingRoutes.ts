import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { watchAllDaySpeechEvents } from "./allDaySpeechEvents.js";
import { requestLocalSpeech, requestLocalSpeechJson } from "../speech/localSpeechClient.js";
import { AllDayRecordingService, AllDayRecordingStore, recordingOperation, type RecordingAuthorization, type RecordingSample } from "./allDayRecording.js";
import type { AllDayEvent } from "../shared/allDayRecording.js";
import { AllDayRecordingReadModel, type AllDayReadReady } from "./allDayRecordingReadModel.js";
import { managerKnowledgePageWorkerPool, ManagerReadWorkerPool } from "./managerReadWorkerPool.js";
import type { AllDayReadJob } from "./allDayRecordingReadStorage.js";

export function createAllDayRecording(options: {
  roleDirectory(roleId: string): string;
  hostId: string;
  mobileRoot: string;
  speechUrl(): string;
  ensureSpeech?(): Promise<void>;
  changed(roleId: string): void;
  indexChanged?(roleId: string, day: string, failed: boolean): void;
  readChanged?(roleId: string, event: AllDayReadReady): void;
  runRead?(job: AllDayReadJob, signal?: AbortSignal): Promise<unknown>;
  mobileAudio(owner: string, chunks: string[], authorize?: RecordingAuthorization): Promise<Buffer>;
}) {
  let reads: AllDayRecordingReadModel;
  // Reconstruction has its own one-worker queue, still within the global budget.
  // Unrelated startup catalogs must not delay a requested recording day.
  const repairReads = options.runRead ? undefined : new ManagerReadWorkerPool({maxConcurrency:1,maxQueue:32,timeoutMs:getTimeoutMs("backend.manager.allDayRecordingRoutes.createAllDayRecording.timeoutMs", 600_000)});
  const store = new AllDayRecordingStore(options.roleDirectory, options.hostId, options.mobileRoot, {
    scan: async (directory,day) => {
      const input:AllDayReadJob={kind:"scan",directory,day,mobileRoot:options.mobileRoot,mobileDeviceIds:[]};
      return options.runRead ? await options.runRead(input) as AllDayEvent[] : repairReads!.run<AllDayEvent[]>({type:"all_day_recording_read",input});
    },
    committed: (role,event,bytes,complete) => reads.committed(role,event,bytes,complete)
  });
  reads = new AllDayRecordingReadModel({directory:role=>store.directory(role),mobileRoot:options.mobileRoot,settings:role=>store.settings(role),
    run:(input,signal)=>options.runRead ? options.runRead(input,signal) : managerKnowledgePageWorkerPool.run({type:"all_day_recording_read",input},{signal,timeoutMs:getTimeoutMs("backend.manager.allDayRecordingRoutes.run.managerKnowledgePageWorkerPool.run.timeoutMs", 60_000)}),
    ready:(role,event)=>options.readChanged?.(role,event)});
  async function speech<T>(endpoint: string, body?: unknown, authorize?: RecordingAuthorization): Promise<T> {
    const result = await recordingOperation(authorize, () => requestLocalSpeechJson<T & { detail?: string }>(options.speechUrl(), endpoint, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }, { timeoutMs: getTimeoutMs("backend.manager.allDayRecordingRoutes.speech.requestLocalSpeechJson.timeoutMs", 30_000) }));
    if (result.status !== 200) throw new Error(result.data.detail || `Capture service HTTP ${result.status}`);
    return result.data;
  }
  function microphoneEvent(row: Record<string, unknown>, sessionId: string): AllDayEvent | null {
    if (row.session_id !== sessionId || row.kind !== "asr" || row.source_device_kind !== "pc_microphone") return null;
    const startedAt = Number(row.time) * 1000;
    if (!Number.isFinite(startedAt)) throw new Error("Speech record has no capture timestamp");
    const transcriptionState = ["pending","processing","ready","empty","error"].includes(String(row.transcription_state)) ? row.transcription_state as AllDayEvent["transcriptionState"] : "ready";
    return { id: `speech:${row.id}`, speechRecordId: String(row.id), startedAt, endedAt: startedAt + Math.max(0, Number(row.duration) || 0) * 1000,
      source: "microphone", deviceId: options.hostId, kind: "audio", text: String(row.text || ""), state: "saved", transcriptionState };
  }
  const service = new AllDayRecordingService(store, {
    watchAudio: (changed, failed) => watchAllDaySpeechEvents(options.speechUrl, changed, failed),
    audioRecord: async (id, sessionId) => microphoneEvent(await speech<Record<string, unknown>>(`/v1/records/${encodeURIComponent(id)}`), sessionId),
    changed: options.changed,
    prepare: options.ensureSpeech,
    stopCapture: async (sessionId, authorize) => { await speech("/v1/all-day/capture/stop", { sessionId }, authorize); },
    renewCapture: async sessionId => { await speech("/v1/all-day/capture/renew", { sessionId }); },
    renewMicrophone: async sessionId => { await speech("/v1/all-day/microphone/renew", { sessionId }); },
    startMicrophone: async (sessionId, authorize) => (await speech<{ audioSessionId: string }>("/v1/all-day/microphone/start", { sessionId }, authorize)).audioSessionId,
    stopMicrophone: async (sessionId, authorize) => { await speech("/v1/all-day/microphone/stop", { sessionId }, authorize); },
    audioFile: async (recordId, authorize) => {
      const reply = await recordingOperation(authorize, () => requestLocalSpeech(options.speechUrl(), `/v1/records/${encodeURIComponent(recordId)}/audio`, {}, { timeoutMs: getTimeoutMs("backend.manager.allDayRecordingRoutes.audioFile.requestLocalSpeech.timeoutMs", 15_000) }));
      if (reply.status !== 200) throw new Error(`Recording audio unavailable (${reply.status})`);
      return reply.body;
    },
    capture: async (settings, sessionId, authorize) => (await speech<{ samples: RecordingSample[] }>("/v1/all-day/capture", { ...settings, sessionId }, authorize)).samples,
    audio: async (since, until, sessionId, authorize) => {
      const events = new Map<string, AllDayEvent>();
      let before: number | undefined;
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ kind: "asr", session_id: sessionId, since: String(since / 1000), until: String(until / 1000), limit: "1000" });
        if (before !== undefined) query.set("before", String(before));
        const data = await speech<{ data: Array<Record<string, unknown>> }>(`/v1/records?${query}`, undefined, authorize);
        const rows = data.data;
        for (const row of rows) {
          const event = microphoneEvent(row, sessionId);
          if (event) events.set(event.id, event);
        }
        if (rows.length < 1000) return [...events.values()];
        const earliest = Math.min(...rows.map(row => Number(row.time)));
        if (!Number.isFinite(earliest) || before !== undefined && earliest >= before) throw new Error("Audio history cursor did not advance; recording coverage is incomplete");
        before = earliest;
      }
      throw new Error("Audio history exceeds this query budget; recording coverage is incomplete");
    }
  });
  return { service, store, reads, mobileAudio: options.mobileAudio,
    async dispose() {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => reads.dispose()),
        Promise.resolve().then(() => service.dispose()),
        Promise.resolve().then(() => repairReads?.stop())
      ]);
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      try { await store.waitForRepairs(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Recording owner cleanup failed.");
    },
    repairIndex: (roleId: string, day: string) => { const originalDirectory=store.directory(roleId); void store.repairIndex(roleId,day,error => { if(store.directory(roleId)!==originalDirectory) return; if(!error) reads.invalidate(roleId,day); options.indexChanged?.(roleId,day,!!error); }); },
    async audio(recordId: string, authorize?: RecordingAuthorization) {
    return recordingOperation(authorize, () => requestLocalSpeech(options.speechUrl(), `/v1/records/${encodeURIComponent(recordId)}/audio`, {}, { timeoutMs: getTimeoutMs("backend.manager.allDayRecordingRoutes.audio.requestLocalSpeech.timeoutMs", 15_000) }));
  } };
}
