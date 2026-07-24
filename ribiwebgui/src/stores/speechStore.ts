import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  SpeechAudioInput,
  SpeechAudioStreamSelectionCommand,
  SpeechAudioStreamStatus,
  SpeechMessageCommand,
  SpeechMessageResult,
  SpeechMicrophoneStartCommand,
  SpeechMicrophoneSettingsCommand,
  SpeechMicrophoneStatus,
  SpeechModel,
  SpeechPersona,
  SpeechPlaybackStatus,
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
import {
  speechControlClient,
  type SpeechRecordsQuery,
  type SpeechSynthesisResult,
  type SpeechTranscriptionResult
} from "../speech/speechControlClient";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useSpeechStore = defineStore("speech-control", () => {
  const status = ref<SpeechRuntimeStatus | null>(null);
  const models = ref<SpeechModel[]>([]);
  const personas = ref<SpeechPersona[]>([]);
  const records = ref<SpeechRecord[]>([]);
  const speakerRegistry = ref<SpeechSpeakerRegistry | null>(null);
  const playback = ref<SpeechPlaybackStatus | null>(null);
  const microphone = ref<SpeechMicrophoneStatus | null>(null);
  const audioInputs = ref<SpeechAudioInput[]>([]);
  const audioStream = ref<SpeechAudioStreamStatus | null>(null);
  const recordsVersion = ref(0);
  const loading = ref(false);
  const recordsLoading = ref(false);
  const speakersLoading = ref(false);
  const error = ref("");
  const listening = computed(() => microphone.value?.running === true);
  const playbackBusy = computed(() => Boolean(playback.value?.current));

  let subscribers = 0;
  let eventSource: EventSource | null = null;
  let readyReceived = false;
  let microphoneRefreshing = false;
  let playbackRefreshing = false;

  function rememberError(cause: unknown): void {
    error.value = messageOf(cause);
  }

  async function refreshStatus(): Promise<void> {
    loading.value = true;
    try {
      status.value = await speechControlClient.status();
      error.value = "";
    } finally {
      loading.value = false;
    }
  }

  async function refreshModels(): Promise<void> {
    models.value = (await speechControlClient.models()).models;
  }

  async function refreshPersonas(): Promise<void> {
    personas.value = (await speechControlClient.personas()).personas;
  }

  async function refreshRecords(query: SpeechRecordsQuery = {}): Promise<void> {
    recordsLoading.value = true;
    try {
      records.value = (await speechControlClient.records(query)).records;
    } finally {
      recordsLoading.value = false;
    }
  }

  async function refreshSpeakers(sessionId?: string): Promise<void> {
    speakersLoading.value = true;
    try {
      speakerRegistry.value = await speechControlClient.speakers(sessionId);
    } finally {
      speakersLoading.value = false;
    }
  }

  async function createSpeaker(command: SpeechSpeakerProfileCreateCommand): Promise<SpeechSpeakerProfile> {
    const created = await speechControlClient.createSpeaker(command);
    await refreshSpeakers();
    return created;
  }

  async function updateSpeaker(
    speakerId: string,
    command: SpeechSpeakerProfileUpdateCommand
  ): Promise<SpeechSpeakerProfile> {
    const updated = await speechControlClient.updateSpeaker(speakerId, command);
    await refreshSpeakers();
    return updated;
  }

  async function deleteSpeaker(speakerId: string): Promise<SpeechSpeakerProfileDeleteResult> {
    const deleted = await speechControlClient.deleteSpeaker(speakerId);
    await refreshSpeakers();
    return deleted;
  }

  async function bindSpeaker(command: SpeechSpeakerBindingCommand): Promise<SpeechSpeakerBinding> {
    const binding = await speechControlClient.bindSpeaker(command);
    await refreshSpeakers();
    return binding;
  }

  async function unbindSpeaker(sessionId: string, recordId: string, speakerLabel: string): Promise<SpeechSpeakerBinding> {
    const binding = await speechControlClient.unbindSpeaker(sessionId, recordId, speakerLabel);
    await refreshSpeakers();
    return binding;
  }

  async function refreshAudioInputs(): Promise<void> {
    audioInputs.value = (await speechControlClient.microphoneDevices()).devices;
  }

  async function refreshMicrophone(): Promise<void> {
    if (microphoneRefreshing) return;
    microphoneRefreshing = true;
    try {
      microphone.value = await speechControlClient.microphoneStatus();
    } finally {
      microphoneRefreshing = false;
    }
  }

  async function refreshPlayback(): Promise<void> {
    if (playbackRefreshing) return;
    playbackRefreshing = true;
    try {
      playback.value = await speechControlClient.playbackStatus();
    } finally {
      playbackRefreshing = false;
    }
  }

  async function refreshAudioStreams(): Promise<void> {
    audioStream.value = (await speechControlClient.audioStreams()).audioStream;
  }

  async function selectAudioStream(command: SpeechAudioStreamSelectionCommand): Promise<SpeechAudioStreamStatus> {
    audioStream.value = await speechControlClient.selectAudioStream(command);
    await refreshMicrophone();
    return audioStream.value;
  }

  async function audioStreamToken(): Promise<string> {
    return (await speechControlClient.audioStreamToken()).token;
  }

  async function updateMicrophoneSettings(command: SpeechMicrophoneSettingsCommand): Promise<SpeechMicrophoneStatus> {
    microphone.value = await speechControlClient.updateMicrophoneSettings(command);
    return microphone.value;
  }

  async function reconcileMicrophone(): Promise<SpeechMicrophoneStatus> {
    microphone.value = await speechControlClient.reconcileMicrophone();
    return microphone.value;
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([
      refreshStatus(),
      refreshModels(),
      refreshPersonas(),
      refreshAudioInputs(),
      refreshAudioStreams(),
      refreshMicrophone(),
      refreshPlayback()
    ]);
  }

  function startEvents(): void {
    if (eventSource) return;
    eventSource = new EventSource("/api/speech/events");
    eventSource.addEventListener("ready", () => {
      error.value = "";
      if (!readyReceived) {
        readyReceived = true;
        return;
      }
      recordsVersion.value += 1;
      void Promise.all([
        refreshStatus(),
        refreshAudioStreams(),
        refreshMicrophone(),
        refreshPlayback()
      ]).catch(rememberError);
    });
    eventSource.addEventListener("microphone_level", (raw) => {
      if (!microphone.value) return;
      try {
        const data = JSON.parse((raw as MessageEvent).data || "{}");
        microphone.value = {
          ...microphone.value,
          level: Number(data.level) || 0,
          noiseFloor: Number(data.noise_floor) || 0,
          dynamicThreshold: Number(data.dynamic_threshold) || 0,
          state: String(data.state || microphone.value.state),
          utteranceActive: data.utterance_active === true,
          levelHistory: [...microphone.value.levelHistory.slice(-119), Number(data.level) || 0]
        };
      } catch {
        // A malformed telemetry event is ignored; the next state event refreshes the snapshot.
      }
    });
    eventSource.addEventListener("microphone_event", () => {
      void Promise.all([refreshMicrophone(), refreshStatus()]).catch(rememberError);
    });
    eventSource.addEventListener("playback_changed", () => {
      void refreshPlayback().catch(rememberError);
    });
    eventSource.addEventListener("audio_stream_changed", () => {
      void Promise.all([refreshAudioStreams(), refreshMicrophone()]).catch(rememberError);
    });
    eventSource.addEventListener("records_changed", () => {
      recordsVersion.value += 1;
    });
    eventSource.onerror = () => {
      error.value = "语音事件流暂时断开，浏览器正在重连。";
    };
  }

  function stopEvents(): void {
    eventSource?.close();
    eventSource = null;
    readyReceived = false;
  }

  async function acquire(): Promise<() => void> {
    subscribers += 1;
    if (subscribers === 1) {
      await refreshAll().catch(cause => {
        rememberError(cause);
      });
      startEvents();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      subscribers = Math.max(0, subscribers - 1);
      if (subscribers === 0) stopEvents();
    };
  }

  async function startMicrophone(command: SpeechMicrophoneStartCommand): Promise<SpeechMicrophoneStatus> {
    microphone.value = await speechControlClient.startMicrophone(command);
    return microphone.value;
  }

  async function stopMicrophone(): Promise<SpeechMicrophoneStatus> {
    microphone.value = await speechControlClient.stopMicrophone();
    return microphone.value;
  }

  async function stopPlayback(): Promise<SpeechPlaybackStatus> {
    playback.value = await speechControlClient.stopPlayback();
    return playback.value;
  }

  async function setPlaybackVolume(volume: number): Promise<SpeechPlaybackStatus> {
    playback.value = await speechControlClient.setPlaybackVolume({ volume });
    return playback.value;
  }

  function submitTranscript(command: SpeechMessageCommand): Promise<SpeechMessageResult> {
    return speechControlClient.submitTranscript(command);
  }

  async function synthesize(command: SpeechSynthesisCommand): Promise<SpeechSynthesisResult> {
    const result = await speechControlClient.synthesize(command);
    if (command.play) await refreshPlayback();
    return result;
  }

  async function transcribe(
    blob: Blob,
    name: string,
    model: string,
    language?: string,
    sessionId?: string,
    routeId?: string
  ): Promise<SpeechTranscriptionResult> {
    const result = await speechControlClient.transcribe(blob, name, model, language, sessionId, routeId);
    return result;
  }

  return {
    status,
    models,
    personas,
    records,
    speakerRegistry,
    playback,
    microphone,
    audioInputs,
    audioStream,
    recordsVersion,
    loading,
    recordsLoading,
    speakersLoading,
    error,
    listening,
    playbackBusy,
    acquire,
    refreshStatus,
    refreshModels,
    refreshPersonas,
    refreshRecords,
    refreshSpeakers,
    refreshAudioInputs,
    refreshAudioStreams,
    selectAudioStream,
    audioStreamToken,
    updateMicrophoneSettings,
    reconcileMicrophone,
    refreshMicrophone,
    refreshPlayback,
    startMicrophone,
    stopMicrophone,
    stopPlayback,
    setPlaybackVolume,
    submitTranscript,
    createSpeaker,
    updateSpeaker,
    deleteSpeaker,
    bindSpeaker,
    unbindSpeaker,
    synthesize,
    transcribe
  };
});
