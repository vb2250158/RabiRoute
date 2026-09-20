import type http from "node:http";
import { requestLocalSpeech, requestLocalSpeechJson } from "../speech/localSpeechClient.js";
import { AllDayRecordingService, AllDayRecordingStore, type RecordingSample } from "./allDayRecording.js";
import type { AllDayEvent } from "../shared/allDayRecording.js";

export function createAllDayRecording(options: {
  roleDirectory(roleId: string): string;
  hostId: string;
  mobileRoot: string;
  speechUrl(): string;
  changed(roleId: string): void;
  mobileAudio(owner: string, chunks: string[]): Promise<Buffer>;
}) {
  const store = new AllDayRecordingStore(options.roleDirectory, options.hostId, options.mobileRoot);
  async function speech<T>(endpoint: string, body?: unknown): Promise<T> {
    const result = await requestLocalSpeechJson<T & { detail?: string }>(options.speechUrl(), endpoint, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }, { timeoutMs: 30_000 });
    if (result.status !== 200) throw new Error(result.data.detail || `Capture service HTTP ${result.status}`);
    return result.data;
  }
  const service = new AllDayRecordingService(store, {
    changed: options.changed,
    startMicrophone: async sessionId => (await speech<{ audioSessionId: string }>("/v1/all-day/microphone/start", { sessionId })).audioSessionId,
    stopMicrophone: async sessionId => { await speech("/v1/all-day/microphone/stop", { sessionId }); },
    audioFile: async recordId => {
      const reply = await requestLocalSpeech(options.speechUrl(), `/v1/records/${encodeURIComponent(recordId)}/audio`, {}, { timeoutMs: 15_000 });
      if (reply.status !== 200) throw new Error(`Recording audio unavailable (${reply.status})`);
      return reply.body;
    },
    capture: async (settings, sessionId) => (await speech<{ samples: RecordingSample[] }>("/v1/all-day/capture", { ...settings, sessionId })).samples,
    audio: async (since, until, sessionId) => {
      const events = new Map<string, AllDayEvent>();
      let before: number | undefined;
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ kind: "asr", session_id: sessionId, since: String(since / 1000), until: String(until / 1000), limit: "1000" });
        if (before !== undefined) query.set("before", String(before));
        const data = await speech<{ data: Array<Record<string, unknown>> }>(`/v1/records?${query}`);
        const rows = data.data;
        for (const row of rows) {
          if (row.session_id !== sessionId || row.kind !== "asr" || row.source_device_kind !== "pc_microphone") continue;
          const startedAt = Number(row.time) * 1000;
          events.set(String(row.id), { id: `speech:${row.id}`, speechRecordId: String(row.id), startedAt, endedAt: startedAt + Math.max(0, Number(row.duration) || 0) * 1000, source: "microphone", deviceId: options.hostId, kind: "audio", text: String(row.text || ""), state: "saved" });
        }
        if (rows.length < 1000) return [...events.values()];
        const earliest = Math.min(...rows.map(row => Number(row.time)));
        if (!Number.isFinite(earliest) || before !== undefined && earliest >= before) throw new Error("Audio history cursor did not advance; recording coverage is incomplete");
        before = earliest;
      }
      throw new Error("Audio history exceeds this query budget; recording coverage is incomplete");
    }
  });
  return { service, store, mobileAudio: options.mobileAudio, async audio(recordId: string) {
    return requestLocalSpeech(options.speechUrl(), `/v1/records/${encodeURIComponent(recordId)}/audio`, {}, { timeoutMs: 15_000 });
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
    const send = (status: number, data: unknown) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(data));
    };
    void (async () => {
      const roleId = decodeURIComponent(match[1]);
      if (!roleId || roleId.length > 128 || /[\\/\x00-\x1f]/.test(roleId) || roleId === "." || roleId === "..") throw new Error("Invalid persona");
      // Capture controls and private raw media are local-host only, never a device proxy.
      if (!options.local(request) || request.headers["x-rabilink-tunnel-local"]) { send(403, { code: -1, message: "Open all-day recording on this computer" }); return; }
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}` && request.headers.origin !== `https://${request.headers.host}`) { send(403, { code: -1, message: "Cross-origin recording access denied" }); return; }
      const action = match[2] || "";
      if (request.method !== "GET" && options.readOnly()) { send(403, { code: -1, message: "Read only" }); return; }
      if (request.method !== "GET" && !String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) { send(415, { code: -1, message: "Use application/json for recording controls" }); return; }
      let data: unknown;
      if (request.method === "GET" && !action) data = { ...await runtime.service.snapshot(roleId), devices: await runtime.store.mobileDevices() };
      else if (request.method === "GET" && action === "events") data = { events: await runtime.store.timeline(roleId, Number(url.searchParams.get("since")), Number(url.searchParams.get("until"))) };
      else if (request.method === "PUT" && action === "settings") data = await runtime.service.configure(roleId, await options.readBody(request));
      else if (request.method === "POST" && action === "start") data = await runtime.service.start(roleId);
      else if (request.method === "POST" && action === "stop") data = await runtime.service.stop(roleId);
      else if (request.method === "GET" && /^media\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.(jpg|wav)$/.test(action)) {
        const [, day, file] = action.split("/");
        const extension = file.slice(-3);
        const body = await runtime.store.media(roleId, day, file.slice(0, -4), extension);
        response.writeHead(200, { "content-type": extension === "wav" ? "audio/wav" : "image/jpeg", "cache-control": "private, no-store" }); response.end(body); return;
      } else if (request.method === "GET" && action === "audio") {
        const since = Number(url.searchParams.get("since")), until = Number(url.searchParams.get("until"));
        const event = (await runtime.store.timeline(roleId, since, until)).find(row => row.id === url.searchParams.get("id"));
        if (event?.mobileMedia) {
          const bytes = await runtime.mobileAudio(event.mobileMedia.owner, event.mobileMedia.chunks);
          response.writeHead(200, { "content-type": "audio/wav", "cache-control": "private, no-store" }); response.end(bytes); return;
        }
        if (!event?.speechRecordId) { send(404, { code: -1, message: "Recording not found" }); return; }
        const audio = await runtime.audio(event.speechRecordId);
        response.writeHead(audio.status, { "content-type": audio.contentType, "cache-control": "private, no-store" }); response.end(audio.body); return;
      } else { send(405, { code: -1, message: "Unsupported recording operation" }); return; }
      send(200, { code: 0, data });
    })().catch(error => send(400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  };
}
