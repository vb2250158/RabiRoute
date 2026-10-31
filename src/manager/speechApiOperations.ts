import { constants as bufferConstants } from "node:buffer";
import type { ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiHttpProxyDefinition, ApiHttpProxyInput, ApiSchema } from "./apiOperationContract.js";
import type { SpeechApiAdmission, SpeechApiContext } from "./speechApiContext.js";
import { SpeechEventStreamOwner } from "./speechEventOperation.js";
import { speechControlErrorStatus, speechControlErrorMessage } from "./speechControl.js";
import { SpeechRuntimeControlError } from "./speechRuntimeControl.js";
import { SpeechModelManagerError } from "./speechModelManager.js";
import { SpeechModelSettingsError } from "./speechModelSettings.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import { proxyTunnel, tunnelHeaders } from "../peerTunnel/http.js";
import { TUNNEL_STREAM_LIMITS } from "../peerTunnel/session.js";
import type { LocalSpeechResponse } from "../speech/localSpeechClient.js";
import type { ManagerSpeechControl } from "./speechControl.js";

const ignored = { type: "object" } as const;
const jsonError = { type: "object", required: ["code", "message"], additionalProperties: true, properties: { code: { const: -1 }, message: { type: "string" } } } as const;
const jsonSuccess = { type: "object", required: ["code", "data"], additionalProperties: false, properties: { code: { const: 0 }, data: {} } } as const;
const jsonResponse = { mediaType: "application/json", schema: { anyOf: [jsonSuccess, jsonError] } } as const;
const binaryResponse = { mediaType: "*/*", binary: { maxBytes: bufferConstants.MAX_LENGTH }, alternatives: [jsonResponse] } as const;
const first = (input: Pick<ApiOperationInput, "query">, key: string) => { const value = input.query[key]; return Array.isArray(value) ? value[0] : value; };
const value = (input: Pick<ApiOperationInput, "query">, key: string, fallback = "") => first(input, key) || fallback;
const optionalNumber = (input: Pick<ApiOperationInput, "query">, key: string) => Object.hasOwn(input.query, key) ? Number(first(input, key)) : undefined;
const nativeBody = (fields: readonly string[]): ApiSchema => ({ anyOf: [{ type: "object", additionalProperties: true, properties: Object.fromEntries(fields.map(key => [key, { description: "Consumed, coerced and validated by the original speech owner. Preserve native optional/default semantics." }])) }, { not: { type: "object" } }] });
const microphoneFields = ["streamingEnabled", "device", "sampleRate", "chunkMs", "preRollMs", "recordThreshold", "transcribeThreshold", "adaptiveThreshold", "adaptiveMultiplier", "adaptiveMargin", "silenceMs", "minUtteranceMs", "maxUtteranceMs", "inputGain", "asrModel", "language", "prompt", "suppressDuringPlayback", "bargeInMode", "bargeInConfirmMs"];
type Normal = { id: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; fields?: readonly string[]; query?: readonly string[]; error?: number; bytes?: boolean; sse?: boolean; raw?: boolean };
const normal: readonly Normal[] = [
  { id: "events", method: "GET", path: "/events", sse: true },
  { id: "status", method: "GET", path: "/status", error: 500 },
  { id: "selection-reader.read", method: "GET", path: "/selection-reader/settings" },
  { id: "selection-reader.write", method: "PUT", path: "/selection-reader/settings", fields: ["enabled", "readAloudEnabled", "advanced", "model"], error: 500 },
  { id: "models", method: "GET", path: "/models", query: ["computeDeviceId"] },
  { id: "personas", method: "GET", path: "/personas" },
  { id: "speakers.list", method: "GET", path: "/speakers", query: ["sessionId"] },
  { id: "speakers.create", method: "POST", path: "/speakers", fields: ["displayName", "aliases"], error: 400 },
  { id: "speakers.update", method: "PATCH", path: "/speakers/:speakerId", fields: ["displayName", "aliases"], error: 400 },
  { id: "speakers.delete", method: "DELETE", path: "/speakers/:speakerId", error: 400 },
  { id: "speaker-bindings.write", method: "PUT", path: "/speaker-bindings", fields: ["sessionId", "recordId", "speakerLabel", "speakerId"], error: 400 },
  { id: "speaker-identities.write", method: "PUT", path: "/speaker-identities", fields: ["sessionId", "recordId", "speakerLabel", "speakerId", "displayName", "aliases"], error: 400 },
  { id: "speaker-bindings.delete", method: "DELETE", path: "/speaker-bindings", query: ["sessionId", "recordId", "speakerLabel"], error: 400 },
  { id: "playback.status", method: "GET", path: "/playback/status" },
  { id: "audio-streams.status", method: "GET", path: "/audio-streams" },
  { id: "audio-streams.events", method: "GET", path: "/audio-streams/events", query: ["limit", "clientId", "sourceDeviceId", "beforeSequence"] },
  { id: "audio-streams.token", method: "POST", path: "/audio-streams/token", error: 409 },
  { id: "audio-streams.selection", method: "PUT", path: "/audio-streams/selection", fields: ["source", "clientId"], error: 400 },
  { id: "playback.volume", method: "PUT", path: "/playback/volume", fields: ["volume"], error: 400 },
  { id: "records.list", method: "GET", path: "/records", query: ["limit", "kind", "sessionId", "routeId", "since", "until", "sourceDeviceId", "before"] },
  { id: "records.audio", method: "GET", path: "/records/:recordId/audio", bytes: true },
  { id: "microphone.status", method: "GET", path: "/microphone/status" },
  { id: "microphone.settings", method: "PUT", path: "/microphone/settings", fields: microphoneFields, error: 400 },
  { id: "microphone.reconcile", method: "POST", path: "/microphone/reconcile", error: 500 },
  { id: "microphone.devices", method: "GET", path: "/microphone/devices" },
  { id: "microphone.start", method: "POST", path: "/microphone/start", fields: microphoneFields, error: 400 },
  { id: "microphone.stop", method: "POST", path: "/microphone/stop" },
  { id: "playback.stop", method: "POST", path: "/playback/stop" },
  { id: "tts", method: "POST", path: "/tts", query: ["computeDeviceId"], fields: ["model", "input", "voice", "responseFormat", "speed", "language", "instructions", "sampleRate", "play", "sessionId", "routeId"], bytes: true },
  { id: "asr", method: "POST", path: "/asr", raw: true, bytes: true },
  { id: "messages.list", method: "GET", path: "/messages", query: ["recordId", "limit", "sourceDeviceId", "messageAdapterType", "before"] },
  { id: "messages.accept", method: "POST", path: "/messages", fields: ["processingPolicy", "routeId", "routeProfileId", "recordId", "text", "sessionId", "source", "transport", "channelType", "messageAdapterType", "sourceDeviceId", "sourceDeviceName", "sourceDeviceKind", "sourceDeviceTrust", "sourceStreamId", "sourceHostId", "sourceHostName", "sampleRate", "recordedAt", "startedAt", "completedAt", "ingestedAt", "audioFormat", "channels", "peak", "rms", "provider", "model", "language", "duration", "segments", "gatewayId"] }
];
type Proxy = { id: string; method: "GET" | "PATCH" | "POST"; path: string };
const proxies: readonly Proxy[] = [
  { id: "runtime.start", method: "POST", path: "/runtime/start" }, { id: "runtime.stop", method: "POST", path: "/runtime/stop" },
  { id: "model-management.read", method: "GET", path: "/model-management" },
  { id: "model-management.runtime.install", method: "POST", path: "/model-management/runtime/install" },
  { id: "model-management.models.install", method: "POST", path: "/model-management/models/:modelId/install" },
  { id: "model-management.settings.read", method: "GET", path: "/model-management/settings" },
  { id: "model-management.settings.write", method: "PATCH", path: "/model-management/settings" }
];
const success = (data: unknown, status = 200): ApiOperationResult => ({ status, body: { code: 0, data } });
const bytes = (result: LocalSpeechResponse): ApiOperationResult => ({ status: result.status, ...([204, 304].includes(result.status) ? {} : { body: result.body }), headers: { "content-type": result.contentType, "content-length": String(result.body.byteLength), ...result.headers } });

export class SpeechApiOwner {
  readonly events = new SpeechEventStreamOwner();
  constructor(readonly context: SpeechApiContext) {}
  capture(input: Pick<ApiOperationInput, "request" | "query">, compute: boolean): SpeechApiAdmission { return this.context.capture(input.request, compute && Object.hasOwn(input.query, "computeDeviceId") ? first(input, "computeDeviceId") ?? "" : undefined); }
  failure(error: unknown, fallback = 502): ApiOperationResult { return { status: speechControlErrorStatus(error, fallback), body: { code: -1, message: speechControlErrorMessage(error) } }; }
  async run(operation: Normal, input: ApiOperationInput, admission: SpeechApiAdmission): Promise<ApiOperationResult> {
    return admission.run(async () => {
      const control = this.context.speechControl, guard = admission.guard;
      type Command<Method extends keyof ManagerSpeechControl> = ManagerSpeechControl[Method] extends (...args: infer Args) => unknown ? Args[0] : never;
      try {
        guard(); input.signal?.throwIfAborted(); let data: unknown;
        switch (operation.id) {
          case "events": return await this.events.open(input, signal => control.eventStream(signal, guard), guard);
          case "status": data = await control.status(guard); break;
          case "selection-reader.read": data = this.context.selectionSpeechSettings.read(); break;
          case "selection-reader.write": data = this.context.selectionSpeechSettings.write(input.body); break;
          case "models": data = { models: await control.models(guard) }; break;
          case "personas": data = { personas: control.personas(guard) }; break;
          case "speakers.list": data = await control.speakerRegistry(value(input, "sessionId") || undefined, guard); break;
          case "speakers.create": data = await control.createSpeakerProfile(input.body as Command<"createSpeakerProfile">, guard); break;
          case "speakers.update": data = await control.updateSpeakerProfile(input.path.speakerId!, input.body as Command<"createSpeakerProfile">, guard); break;
          case "speakers.delete": data = await control.deleteSpeakerProfile(input.path.speakerId!, guard); break;
          case "speaker-bindings.write": data = await control.bindSpeaker(input.body as Command<"bindSpeaker">, guard); break;
          case "speaker-identities.write": data = await control.identifySpeaker(input.body as Command<"identifySpeaker">, guard); break;
          case "speaker-bindings.delete": data = await control.unbindSpeaker(value(input, "sessionId"), value(input, "recordId"), value(input, "speakerLabel"), guard); break;
          case "playback.status": data = await control.playbackStatus(guard); break;
          case "audio-streams.status": data = { audioStream: await control.audioStreams(guard) }; break;
          case "audio-streams.events": data = { events: await control.audioStreamEvents({ limit: Number(value(input, "limit", "200")), clientId: value(input, "clientId") || undefined, sourceDeviceId: value(input, "sourceDeviceId") || undefined, beforeSequence: optionalNumber(input, "beforeSequence") }, guard) }; break;
          case "audio-streams.token": data = { token: await control.audioStreamToken(guard) }; break;
          case "audio-streams.selection": data = await control.selectAudioStream(input.body as Command<"selectAudioStream">, guard); break;
          case "playback.volume": data = await control.setPlaybackVolume(input.body as Command<"setPlaybackVolume">, guard); break;
          case "records.list": data = { records: await control.records({ limit: Number(value(input, "limit", "200")), kind: value(input, "kind") || undefined, sessionId: value(input, "sessionId") || undefined, routeId: value(input, "routeId") || undefined, since: optionalNumber(input, "since"), until: optionalNumber(input, "until"), sourceDeviceId: value(input, "sourceDeviceId") || undefined, before: optionalNumber(input, "before") }, guard) }; break;
          case "records.audio": { const result = await control.recordAudio(input.path.recordId!, guard); guard(); return bytes(result); }
          case "microphone.status": data = await control.microphoneStatus(guard); break;
          case "microphone.settings": data = await control.updateMicrophoneSettings(input.body as Command<"updateMicrophoneSettings">, guard); break;
          case "microphone.reconcile": data = await control.reconcileMicrophone(guard); break;
          case "microphone.devices": data = { devices: await control.microphoneDevices(guard) }; break;
          case "microphone.start": data = await control.startMicrophone(input.body as Command<"startMicrophone">, guard); break;
          case "microphone.stop": data = await control.stopMicrophone(guard); break;
          case "playback.stop": data = await control.stopPlayback(guard); break;
          case "tts": { const result = await control.synthesize(input.body as Command<"synthesize">, guard); guard(); return bytes(result); }
          case "asr": {
            const chunks: Buffer[] = []; let size = 0;
            for await (const chunk of input.request.iterator({ destroyOnReturn: false })) { const payload = Buffer.from(chunk); size += payload.length; if (size > 27 * 1024 * 1024) throw new Error("Request body too large."); chunks.push(payload); }
            guard(); const result = await control.transcribe(String(input.request.headers["content-type"] || ""), Buffer.concat(chunks), guard); guard(); return bytes(result);
          }
          case "messages.list": {
            const store = this.context.speechIngressStore, recordId = value(input, "recordId").trim();
            if (recordId) { const record = store.read(recordId); if (!record) return { status: 404, body: { code: -1, message: "Speech ingress record was not found: " + recordId } }; data = { record, deliveries: store.listDeliveryReceipts(record.id) }; }
            else { const adapter = first(input, "messageAdapterType"); const records = store.query({ limit: Math.max(1, Math.min(1000, Math.floor(Number(value(input, "limit", "200")) || 200))), sourceDeviceId: value(input, "sourceDeviceId").trim() || undefined, messageAdapterType: adapter === "rabilink" || adapter === "speech" ? adapter : undefined, before: optionalNumber(input, "before") }); data = { records, deliveriesByRecordId: Object.fromEntries(records.map(record => [record.id, store.listDeliveryReceipts(record.id)])) }; } break;
          }
          case "messages.accept": data = await control.acceptMessage(this.context.hostSpeechCommand(input.body as Command<"acceptMessage">), guard); break;
          default: throw new Error("Unknown executable speech owner action.");
        }
        guard(); return success(data);
      } catch (error) { let failure = error; try { guard(); } catch (denial) { failure = denial; } return this.failure(failure, operation.error ?? 502); }
    });
  }
  async localProxy(operation: Proxy, input: ApiHttpProxyInput, admission: SpeechApiAdmission): Promise<ApiOperationResult> {
    const guard = admission.guard, models = this.context.speechModelManager;
    return admission.run(async () => {
      guard();
      try {
        switch (operation.id) {
          case "runtime.start": return success(await this.context.speechRuntimeControl.start(guard));
          case "runtime.stop": return success(await this.context.speechRuntimeControl.stop(guard));
          case "model-management.read": return success(models.snapshot(guard));
          case "model-management.runtime.install": return success(models.installRuntime(guard), 202);
          case "model-management.models.install": return success(models.installModel(input.path.modelId!, guard), 202);
          case "model-management.settings.read":
          case "model-management.settings.write": {
            const headers = { "cache-control": "no-store" };
            if (!localModelSettingsRequestAllowed(input.request)) return { status: 403, headers, body: { code: -1, message: "模型目录设置需要有效的连接身份。" } };
            if (operation.method === "GET") return { ...success(models.directorySettings(guard)), headers };
            if (this.context.readOnly()) return { status: 423, headers, body: { code: -1, message: "Manager is read-only." } };
            const expectedGeneration = String(input.request.headers["x-rabiroute-expected-application-generation-id"] || "").trim(), expectedInstance = String(input.request.headers["x-rabiroute-expected-manager-instance-id"] || "").trim();
            if (!expectedGeneration || !expectedInstance) return { status: 400, headers, body: { code: -1, message: "Current application generation and Manager instance headers are required." } };
            const current = this.context.identity();
            if (expectedGeneration !== current.applicationGenerationId || expectedInstance !== current.managerInstanceId) return { status: 409, headers, body: { code: -1, message: "Manager lifecycle changed; reload /meta before retrying." } };
            if (!String(input.request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return { status: 415, headers, body: { code: -1, message: "Expected application/json." } };
            const body = await this.context.readProxyJson(input.request);
            if (!localModelSettingsRequestAllowed(input.request)) return { status: 403, headers, body: { code: -1, error: "LAN_AGENT_AUTHORIZATION_REVOKED", message: "Model settings authorization is no longer valid.", commitState: "not_started" } };
            if (this.context.readOnly()) return { status: 423, headers, body: { code: -1, message: "Manager is read-only.", commitState: "not_started" } };
            const after = this.context.identity();
            if (expectedGeneration !== after.applicationGenerationId || expectedInstance !== after.managerInstanceId) return { status: 409, headers, body: { code: -1, message: "Manager lifecycle changed; reload /meta before retrying.", commitState: "not_started" } };
            return { ...success(models.updateDirectorySettings(body, guard)), headers };
          }
          default: throw new Error("Unknown native speech proxy owner action.");
        }
      } catch (error) {
        guard();
        if (operation.id.startsWith("runtime.")) return { status: error instanceof SpeechRuntimeControlError ? error.status : 502, body: { code: -1, message: speechControlErrorMessage(error), ...(error instanceof SpeechRuntimeControlError && error.detail ? { detail: error.detail } : {}), ...(error instanceof SpeechRuntimeControlError && error.resolution ? { resolution: error.resolution } : {}) } };
        if (operation.id.startsWith("model-management.settings.")) return { status: error instanceof SpeechModelSettingsError || error instanceof SpeechModelManagerError ? error.status : 500, headers: { "cache-control": "no-store" }, body: { code: -1, message: error instanceof SpeechModelSettingsError || error instanceof SpeechModelManagerError ? error.message : "模型目录设置操作失败。" } };
        return { status: error instanceof SpeechModelManagerError ? error.status : 500, body: { code: -1, message: speechControlErrorMessage(error) } };
      }
    });
  }
}

export function createSpeechApiOperations(owner: SpeechApiOwner): { operations: readonly ApiOperationDefinition[]; proxies: readonly ApiHttpProxyDefinition[] } {
  const definitions = normal.map(operation => {
    const params = [...operation.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map(match => match[1]!);
    const path = { type: "object", required: params, additionalProperties: false, properties: Object.fromEntries(params.map(key => [key, { type: "string" }])) };
    const query = { type: "object", additionalProperties: true, properties: Object.fromEntries((operation.query ?? []).map(key => [key, { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "Use the first query value, preserving native empty/default and numeric conversion behavior." }])) };
    const response200 = operation.sse ? { mediaType: "text/event-stream", stream: { framing: "bytes" as const, maxFrameBytes: SpeechEventStreamOwner.maxChunkBytes, completion: "Natural upstream EOF after original reader cleanup.", cancellation: "Abort the original fetch, cancel its body reader and join actual upstream cancellation and generator completion." }, alternatives: [jsonResponse] } : operation.bytes ? binaryResponse : jsonResponse;
    const handler = (input: ApiOperationInput) => owner.run(operation, input, owner.capture(input, operation.id === "models" || operation.id === "tts"));
    return { contract: {
      operationId: "manager.speech." + operation.id, contractVersion: "1.0.0", method: operation.method, pathTemplate: "/api/speech" + operation.path, exposure: "public" as const, transport: operation.sse ? "sse" as const : "http" as const,
      description: "Invoke the original speech owner for " + operation.id + ". Device I/O, model compute, persistence and playback remain owned by the existing services.",
      request: { path, query, headers: ignored, body: operation.raw ? { kind: "multipart" as const, mediaType: "multipart/form-data", maxBytes: 27 * 1024 * 1024, allowAnyContentType: true, rules: ["Original multipart bytes, including boundary; read once, retain native transcribe content-type validation and 27 MiB limit."] } : operation.fields ? { kind: "json" as const, schema: nativeBody(operation.fields), maxBytes: 0, emptyValue: {}, allowAnyContentType: true } : { kind: "none" as const, allowIgnoredBody: true } },
      responses: { "200": response200, default: operation.bytes ? binaryResponse : jsonResponse },
      effects: { mode: operation.method === "GET" ? operation.sse ? "native-speech-events" : "native-speech-read" : "native-speech-action", description: "Original ManagerSpeechControl, selection settings and ingress store own normalization, runtime requests, Route delivery receipts and host provenance. A successful HTTP response or a playback job is not proof of completed playback, transcription delivery or physical I/O." },
      recovery: { strategy: operation.sse ? "reconnect-native-stream" : operation.method === "GET" ? "repeatable-native-read" : "inspect-native-state-no-replay", description: "Capture the original Agent authority, peer selection and compute override before body consumption. Revalidate before dispatch and result disclosure; target changes never fall back to local work. Writes retain original receipt/idempotency behavior and must not be blindly replayed after uncertainty. Raw audio remains byte-identical; SSE retains original framing without JSON reinterpretation." },
      validators: [{ id: "native-speech-owner", description: "Retain original speaker IDs, persona/voice ownership, model availability, microphone limits, host-owned message provenance and explicit user disables. There is no additional per-feature grant. JSON decoding is performed once by the common registry; native owners validate business values." }]
    }, prepare: input => { const admission = owner.capture(input, operation.id === "models" || operation.id === "tts"); return parsed => owner.run(operation, parsed, admission); }, handler } satisfies ApiOperationDefinition;
  });
  const proxyDefinitions = proxies.map(operation => {
    const params = [...operation.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map(match => match[1]!);
    return { contract: {
      operationId: "manager.speech." + operation.id, contractVersion: "1.0.0", method: operation.method, pathTemplate: "/api/speech" + operation.path, exposure: "public" as const, transport: "http" as const,
      description: "Native " + operation.id + " on the captured selected speech Manager, or its original local owner when no remote target applies. Never switch targets after failure.",
      request: { path: { type: "object", required: params, additionalProperties: false, properties: Object.fromEntries(params.map(key => [key, { type: "string" }])) }, query: ignored, headers: ignored, body: { kind: "passthrough" as const } },
      responses: { default: { mediaType: "*/*", passthrough: true as const } }, httpProxy: { wire: TUNNEL_STREAM_LIMITS, completion: "Native local owner returns or original selected-peer response stream reaches completion, with both request and response streams joined.", cancellation: "Stop original peer stream and join native cleanup; already accepted local jobs retain their original owner and immutable job ID." },
      effects: { mode: "captured-native-speech-manager", description: "The selected peer carries original raw method, target headers and body. Local runtime/model-management branches call original functional owners. Only local model-directory settings PATCH uses the original Manager JSON decoder; it preserves generation headers, connection provenance, read-only checks, revision and persistent directory validation." },
      recovery: { strategy: "inspect-original-manager-no-replay", description: "Inspect the captured Manager model-management/runtime state and original install job. HTTP 202 is acceptance only. Selected-peer failure never authorizes local installation or runtime startup; settings PATCH preserves its original lifecycle/version contract." },
      validators: [{ id: "native-speech-manager-owner", description: "Directory settings PATCH accepts exactly {modelRoot:string|null,expectedRevision:nonnegative safe integer}, with native fixed-local-disk/protected-root validation, file-lock CAS and expected application generation/Manager instance headers; other POST bodies remain ignored locally. Remote raw bytes remain owned by the native tunnel and target Manager. Native local validation and selected-peer response status/headers remain unchanged." }]
    }, handler: async input => {
      const admission = owner.capture(input, false); admission.guard();
      if (admission.selectedPeer && !admission.targetLocal) {
        try {
          const target = admission.selectedPeer, session = await target.runtime.session(target.deviceId); admission.guard(); input.assertCurrent();
          await proxyTunnel(session, "manager", input.url.pathname + input.url.search, input.request, input.response, admission.guard, { ...input, requestHeaders: tunnelHeaders(input.request.headers) }); admission.guard();
        } catch { admission.guard(); if (input.response.headersSent || input.response.destroyed) throw new Error("Original speech peer exchange failed."); const body = Buffer.from(JSON.stringify({ code: -1, message: "远端语音服务器操作失败，不会改为操作本机。" })); const headers = { "content-type": "application/json; charset=utf-8", "content-length": String(body.length) }; input.prepareResponse(502, headers); input.response.writeHead(502, headers); input.response.end(body); }
        return;
      }
      const result = await owner.localProxy(operation, input, admission); admission.guard(); input.assertCurrent();
      if (input.response.destroyed) return;
      const body = Buffer.from(JSON.stringify(result.body)); const headers = { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), ...result.headers };
      input.prepareResponse(result.status, headers); input.response.writeHead(result.status, headers); input.response.end(body);
    } } satisfies ApiHttpProxyDefinition;
  });
  const withLegacyAlias = <T extends ApiOperationDefinition | ApiHttpProxyDefinition>(definition: T): T => ({ ...definition, contract: { ...definition.contract, aliases: ["speech:" + definition.contract.method + ":" + definition.contract.pathTemplate] } });
  return { operations: definitions.map(withLegacyAlias), proxies: proxyDefinitions.map(withLegacyAlias) };
}
