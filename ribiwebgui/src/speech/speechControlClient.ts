import type {
  SpeechAudioInputsPayload,
  SpeechAudioStreamSelectionCommand,
  SpeechAudioStreamsPayload,
  SpeechControlEnvelope,
  SpeechMessageCommand,
  SpeechMessageResult,
  SpeechMicrophoneStartCommand,
  SpeechMicrophoneSettingsCommand,
  SpeechMicrophoneStatus,
  SpeechModelsPayload,
  SpeechPersonasPayload,
  SpeechPlaybackStatus,
  SpeechPlaybackVolumeCommand,
  SpeechRecord,
  SpeechRuntimeStatus,
  SpeechSpeakerBinding,
  SpeechSpeakerBindingCommand,
  SpeechSpeakerProfile,
  SpeechSpeakerProfileCreateCommand,
  SpeechSpeakerProfileDeleteResult,
  SpeechSpeakerProfileUpdateCommand,
  SpeechSpeakerRegistry,
  SpeechSynthesisCommand
} from "@shared/speechControlContract";

export type SpeechRecordsQuery = {
  limit?: number;
  kind?: "asr" | "tts";
  sessionId?: string;
  routeId?: string;
  since?: number;
  until?: number;
};

export type SpeechRecordsPayload = { records: SpeechRecord[] };

export type SpeechTranscriptionResult = {
  text: string;
  language?: string;
  duration?: number;
  segments?: unknown[];
  words?: unknown[];
};

export type SpeechSynthesisResult = {
  audio?: Blob;
  playbackJob?: string;
};

async function responseError(response: Response): Promise<Error> {
  const text = await response.text();
  if (!text) return new Error(`HTTP ${response.status}`);
  try {
    const value = JSON.parse(text) as { message?: unknown; detail?: unknown };
    return new Error(String(value.message || value.detail || text));
  } catch {
    return new Error(text);
  }
}

async function managerData<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(pathname, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let body: SpeechControlEnvelope<T>;
  try {
    body = JSON.parse(text) as SpeechControlEnvelope<T>;
  } catch {
    throw new Error(text || `HTTP ${response.status}`);
  }
  if (!response.ok || body.code !== 0) {
    throw new Error(body.code === -1 ? body.message : `HTTP ${response.status}`);
  }
  return body.data;
}

export const speechControlClient = {
  status: (): Promise<SpeechRuntimeStatus> => managerData("/api/speech/status"),
  models: (): Promise<SpeechModelsPayload> => managerData("/api/speech/models"),
  personas: (): Promise<SpeechPersonasPayload> => managerData("/api/speech/personas"),
  records: (query: SpeechRecordsQuery = {}): Promise<SpeechRecordsPayload> => {
    const search = new URLSearchParams();
    if (query.limit != null) search.set("limit", String(query.limit));
    if (query.kind) search.set("kind", query.kind);
    if (query.sessionId) search.set("sessionId", query.sessionId);
    if (query.routeId) search.set("routeId", query.routeId);
    if (query.since != null) search.set("since", String(query.since));
    if (query.until != null) search.set("until", String(query.until));
    const suffix = search.size ? `?${search.toString()}` : "";
    return managerData(`/api/speech/records${suffix}`);
  },
  speakers: (sessionId?: string): Promise<SpeechSpeakerRegistry> => {
    const search = new URLSearchParams();
    if (sessionId) search.set("sessionId", sessionId);
    const suffix = search.size ? `?${search.toString()}` : "";
    return managerData(`/api/speech/speakers${suffix}`);
  },
  createSpeaker: (command: SpeechSpeakerProfileCreateCommand): Promise<SpeechSpeakerProfile> => managerData(
    "/api/speech/speakers",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    }
  ),
  updateSpeaker: (
    speakerId: string,
    command: SpeechSpeakerProfileUpdateCommand
  ): Promise<SpeechSpeakerProfile> => managerData(
    `/api/speech/speakers/${encodeURIComponent(speakerId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    }
  ),
  deleteSpeaker: (speakerId: string): Promise<SpeechSpeakerProfileDeleteResult> => managerData(
    `/api/speech/speakers/${encodeURIComponent(speakerId)}`,
    { method: "DELETE" }
  ),
  bindSpeaker: (command: SpeechSpeakerBindingCommand): Promise<SpeechSpeakerBinding> => managerData(
    "/api/speech/speaker-bindings",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    }
  ),
  unbindSpeaker: (sessionId: string, recordId: string, speakerLabel: string): Promise<SpeechSpeakerBinding> => {
    const search = new URLSearchParams({ sessionId, recordId, speakerLabel });
    return managerData(`/api/speech/speaker-bindings?${search.toString()}`, { method: "DELETE" });
  },
  playbackStatus: (): Promise<SpeechPlaybackStatus> => managerData("/api/speech/playback/status"),
  setPlaybackVolume: (command: SpeechPlaybackVolumeCommand): Promise<SpeechPlaybackStatus> => managerData(
    "/api/speech/playback/volume",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    }
  ),
  microphoneStatus: (): Promise<SpeechMicrophoneStatus> => managerData("/api/speech/microphone/status"),
  microphoneDevices: (): Promise<SpeechAudioInputsPayload> => managerData("/api/speech/microphone/devices"),
  audioStreams: (): Promise<SpeechAudioStreamsPayload> => managerData("/api/speech/audio-streams"),
  audioStreamToken: (): Promise<{ token: string }> => managerData(
    "/api/speech/audio-streams/token",
    { method: "POST" }
  ),
  selectAudioStream: (command: SpeechAudioStreamSelectionCommand): Promise<SpeechAudioStreamsPayload["audioStream"]> => managerData(
    "/api/speech/audio-streams/selection",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    }
  ),
  startMicrophone: (command: SpeechMicrophoneStartCommand): Promise<SpeechMicrophoneStatus> => managerData(
    "/api/speech/microphone/start",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    }
  ),
  updateMicrophoneSettings: (command: SpeechMicrophoneSettingsCommand): Promise<SpeechMicrophoneStatus> => managerData(
    "/api/speech/microphone/settings",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    }
  ),
  reconcileMicrophone: (): Promise<SpeechMicrophoneStatus> => managerData(
    "/api/speech/microphone/reconcile",
    { method: "POST" }
  ),
  stopMicrophone: (): Promise<SpeechMicrophoneStatus> => managerData("/api/speech/microphone/stop", { method: "POST" }),
  stopPlayback: (): Promise<SpeechPlaybackStatus> => managerData("/api/speech/playback/stop", { method: "POST" }),
  submitTranscript: (command: SpeechMessageCommand): Promise<SpeechMessageResult> => managerData(
    "/api/speech/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    }
  ),
  async synthesize(command: SpeechSynthesisCommand): Promise<SpeechSynthesisResult> {
    const response = await fetch("/api/speech/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    });
    if (!response.ok) throw await responseError(response);
    return {
      audio: command.play ? undefined : await response.blob(),
      playbackJob: response.headers.get("x-rabispeech-playback-job") || undefined
    };
  },
  async transcribe(
    blob: Blob,
    name: string,
    model: string,
    language?: string,
    sessionId?: string,
    routeId?: string
  ): Promise<SpeechTranscriptionResult> {
    const form = new FormData();
    form.append("file", blob, name);
    form.append("model", model);
    if (language) form.append("language", language);
    if (sessionId) form.append("session_id", sessionId);
    if (routeId) form.append("route_id", routeId);
    form.append("response_format", "verbose_json");
    const response = await fetch("/api/speech/asr", { method: "POST", body: form });
    if (!response.ok) throw await responseError(response);
    return await response.json() as SpeechTranscriptionResult;
  }
};
