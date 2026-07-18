import type {
  SpeechAudioInputsPayload,
  SpeechControlEnvelope,
  SpeechMessageAccepted,
  SpeechMessageCommand,
  SpeechMicrophoneStartCommand,
  SpeechMicrophoneStatus,
  SpeechModelsPayload,
  SpeechPersonasPayload,
  SpeechPlaybackStatus,
  SpeechRuntimeStatus,
  SpeechSynthesisCommand
} from "@shared/speechControlContract";

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
  playbackStatus: (): Promise<SpeechPlaybackStatus> => managerData("/api/speech/playback/status"),
  microphoneStatus: (): Promise<SpeechMicrophoneStatus> => managerData("/api/speech/microphone/status"),
  microphoneDevices: (): Promise<SpeechAudioInputsPayload> => managerData("/api/speech/microphone/devices"),
  startMicrophone: (command: SpeechMicrophoneStartCommand): Promise<SpeechMicrophoneStatus> => managerData(
    "/api/speech/microphone/start",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    }
  ),
  stopMicrophone: (): Promise<SpeechMicrophoneStatus> => managerData("/api/speech/microphone/stop", { method: "POST" }),
  stopPlayback: (): Promise<SpeechPlaybackStatus> => managerData("/api/speech/playback/stop", { method: "POST" }),
  submitTranscript: (command: SpeechMessageCommand): Promise<SpeechMessageAccepted> => managerData(
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
  async transcribe(blob: Blob, name: string, model: string, language?: string): Promise<SpeechTranscriptionResult> {
    const form = new FormData();
    form.append("file", blob, name);
    form.append("model", model);
    if (language) form.append("language", language);
    form.append("response_format", "verbose_json");
    const response = await fetch("/api/speech/asr", { method: "POST", body: form });
    if (!response.ok) throw await responseError(response);
    return await response.json() as SpeechTranscriptionResult;
  }
};
