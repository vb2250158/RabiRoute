import type http from "node:http";
import { requestLocalSpeech, requestLocalSpeechJson } from "../speech/localSpeechClient.js";
import { AllDayRecordingService, AllDayRecordingStore, recordingOperation, type RecordingAuthorization, type RecordingSample } from "./allDayRecording.js";
import type { AllDayEvent } from "../shared/allDayRecording.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
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
  const repairReads = options.runRead ? undefined : new ManagerReadWorkerPool({maxConcurrency:1,maxQueue:32,timeoutMs:600_000});
  const store = new AllDayRecordingStore(options.roleDirectory, options.hostId, options.mobileRoot, {
    scan: async (directory,day) => {
      const input:AllDayReadJob={kind:"scan",directory,day,mobileRoot:options.mobileRoot,mobileDeviceIds:[]};
      return options.runRead ? await options.runRead(input) as AllDayEvent[] : repairReads!.run<AllDayEvent[]>({type:"all_day_recording_read",input});
    },
    committed: (role,event,bytes,complete) => reads.committed(role,event,bytes,complete)
  });
  reads = new AllDayRecordingReadModel({directory:role=>store.directory(role),mobileRoot:options.mobileRoot,settings:role=>store.settings(role),
    run:(input,signal)=>options.runRead ? options.runRead(input,signal) : managerKnowledgePageWorkerPool.run({type:"all_day_recording_read",input},{signal,timeoutMs:60_000}),
    ready:(role,event)=>options.readChanged?.(role,event)});
  async function speech<T>(endpoint: string, body?: unknown, authorize?: RecordingAuthorization): Promise<T> {
    const result = await recordingOperation(authorize, () => requestLocalSpeechJson<T & { detail?: string }>(options.speechUrl(), endpoint, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }, { timeoutMs: 30_000 }));
    if (result.status !== 200) throw new Error(result.data.detail || `Capture service HTTP ${result.status}`);
    return result.data;
  }
  const service = new AllDayRecordingService(store, {
    changed: options.changed,
    prepare: options.ensureSpeech,
    stopCapture: async (sessionId, authorize) => { await speech("/v1/all-day/capture/stop", { sessionId }, authorize); },
    renewCapture: async sessionId => { await speech("/v1/all-day/capture/renew", { sessionId }); },
    startMicrophone: async (sessionId, authorize) => (await speech<{ audioSessionId: string }>("/v1/all-day/microphone/start", { sessionId }, authorize)).audioSessionId,
    stopMicrophone: async (sessionId, authorize) => { await speech("/v1/all-day/microphone/stop", { sessionId }, authorize); },
    audioFile: async (recordId, authorize) => {
      const reply = await recordingOperation(authorize, () => requestLocalSpeech(options.speechUrl(), `/v1/records/${encodeURIComponent(recordId)}/audio`, {}, { timeoutMs: 15_000 }));
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
          if (row.session_id !== sessionId || row.kind !== "asr" || row.source_device_kind !== "pc_microphone") continue;
          const startedAt = Number(row.time) * 1000;
          const transcriptionState = ["pending","processing","ready","empty","error"].includes(String(row.transcription_state)) ? row.transcription_state as AllDayEvent["transcriptionState"] : "ready";
          events.set(String(row.id), { id: `speech:${row.id}`, speechRecordId: String(row.id), startedAt, endedAt: startedAt + Math.max(0, Number(row.duration) || 0) * 1000, source: "microphone", deviceId: options.hostId, kind: "audio", text: String(row.text || ""), state: "saved", transcriptionState });
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
    async dispose() {reads.dispose();await Promise.all([service.dispose(),repairReads?.stop()]);},
    repairIndex: (roleId: string, day: string) => { void store.repairIndex(roleId,day,error => { if(!error) reads.invalidate(roleId,day); options.indexChanged?.(roleId,day,!!error); }); },
    async audio(recordId: string, authorize?: RecordingAuthorization) {
    return recordingOperation(authorize, () => requestLocalSpeech(options.speechUrl(), `/v1/records/${encodeURIComponent(recordId)}/audio`, {}, { timeoutMs: 15_000 }));
  } };
}

export function allDayRecordingHandler(runtime: ReturnType<typeof createAllDayRecording>, options: {
  local(request: http.IncomingMessage): boolean;
  readOnly(): boolean;
  readBody(request: http.IncomingMessage): Promise<unknown>;
}) {
  return (request: http.IncomingMessage, url: URL, response: http.ServerResponse): boolean => {
    const match = /^\/(?:api\/)?roles\/([^/]+)\/all-day-recording(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return false;
    let authorize: RecordingAuthorization | undefined;
    const send = (status: number, data: unknown, fence = true) => {
      if (response.writableEnded || response.destroyed) return;
      if (fence) authorize?.();
      const body = JSON.stringify(data);
      if (fence) authorize?.();
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      if (fence) authorize?.();
      response.end(body);
    };
    void (async () => {
      // Capture the original principal, never reinterpret a revoked Agent as local.
      const lease = assertTrustedLanAgentPrincipal(request);
      authorize = () => {
        if (lease) {
          if (assertTrustedLanAgentPrincipal(request) !== lease) throw new Error("Recording authorization was replaced");
        } else if (!localModelSettingsRequestAllowed(request) || !options.local(request) || request.headers["x-rabilink-tunnel-local"]) {
          throw new Error("Recording authorization denied");
        }
        if (request.method !== "GET" && options.readOnly()) throw new Error("Read only");
      };
      authorize();
      const roleId = decodeURIComponent(match[1]);
      if (!roleId || roleId.length > 128 || /[\\/\x00-\x1f]/.test(roleId) || roleId === "." || roleId === "..") throw new Error("Invalid persona");
      const action = match[2] || "";
      if (request.method !== "GET" && !String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) { send(415, { code: -1, message: "Use application/json for recording controls" }); return; }
      let data: unknown;
      if (request.method === "GET" && !action) data = { ...await runtime.service.snapshot(roleId,authorize), devices: await runtime.store.mobileDevices(authorize) };
      else if (request.method === "GET" && action === "recent") data = await runtime.reads.recent(roleId);
      else if (request.method === "GET" && action === "catalog") {
        const day = url.searchParams.get("day") ?? undefined;
        if(url.searchParams.get("refresh")==="1") runtime.reads.invalidate(roleId,day);
        data = await runtime.reads.catalog(roleId,day);
        if(url.searchParams.get("summary")==="1") data={...data as object,events:[]};
      }
      else if (request.method === "POST" && /^index-repair\/\d{4}-\d{2}-\d{2}$/.test(action)) {
        runtime.repairIndex(roleId,action.split("/")[1]); data = { queued: true };
      }
      else if (request.method === "GET" && action === "page") {
        const direction = url.searchParams.get("direction");
        if (direction !== "older" && direction !== "newer") throw new Error("Invalid event direction");
        data = await runtime.reads.page(roleId, direction, { time: Number(url.searchParams.get("time")), id: url.searchParams.get("id") || "" }, url.searchParams.get("source") || "all", 100, url.searchParams.get("type") || "all");
      }
      else if (request.method === "GET" && action === "events") data = await runtime.reads.timeline(roleId, Number(url.searchParams.get("since")), Number(url.searchParams.get("until")));
      else if (request.method === "PUT" && action === "settings") { data = await runtime.service.configure(roleId, await recordingOperation(authorize, () => options.readBody(request)),authorize); runtime.reads.invalidate(roleId); }
      else if (request.method === "POST" && action === "start") data = await runtime.service.start(roleId,authorize);
      else if (request.method === "POST" && action === "stop") data = await runtime.service.stop(roleId,false,authorize);
      else if (request.method === "GET" && /^media\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.(jpg|wav)$/.test(action)) {
        const [, day, file] = action.split("/");
        const extension = file.slice(-3);
        const pending=new AbortController(),cancel=()=>pending.abort();response.once("close",cancel);
        let body:Buffer;
        try {body=await runtime.reads.media(roleId, day, file.slice(0, -4), extension,pending.signal);}
        finally {response.removeListener("close",cancel);}
        if(response.destroyed) return;
        authorize();
        response.writeHead(200, { "content-type": extension === "wav" ? "audio/wav" : "image/jpeg", "cache-control": "private, no-store" }); authorize(); response.end(body); return;
      } else if (request.method === "GET" && action === "audio") {
        const since = Number(url.searchParams.get("since")), until = Number(url.searchParams.get("until"));
        const timeline = await runtime.reads.timeline(roleId,since,until);
        const event = timeline.events.find(row => row.id === url.searchParams.get("id"));
        if(!event && (timeline.loading || timeline.pendingDays.length)) {send(409,{code:-1,message:"Recording history is loading; retry playback when ready"});return;}
        if (event?.mobileMedia) {
          // The private resource owner is the event's authenticated phone, not the public Agent.
          const bytes = await recordingOperation(authorize, () => runtime.mobileAudio(event.mobileMedia!.owner, event.mobileMedia!.chunks, authorize));
          authorize(); response.writeHead(200, { "content-type": "audio/wav", "cache-control": "private, no-store" }); authorize(); response.end(bytes); return;
        }
        if (!event?.speechRecordId) { send(404, { code: -1, message: "Recording not found" }); return; }
        const audio = await runtime.audio(event.speechRecordId, authorize);
        authorize(); response.writeHead(audio.status, { "content-type": audio.contentType, "cache-control": "private, no-store" }); authorize(); response.end(audio.body); return;
      } else { send(405, { code: -1, message: "Unsupported recording operation" }); return; }
      authorize();
      send(200, { code: 0, data });
    })().catch(error => {
      try { if (!authorize) throw error; authorize(); }
      catch { if (response.headersSent) response.destroy(); else send(403, { code: -1, message: "Recording authorization denied" }, false); return; }
      send(400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    });
    return true;
  };
}
