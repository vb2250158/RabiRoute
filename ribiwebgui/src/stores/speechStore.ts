import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  SpeechAudioInput,
  SpeechMessageAccepted,
  SpeechMessageCommand,
  SpeechMicrophoneStartCommand,
  SpeechMicrophoneStatus,
  SpeechModel,
  SpeechPersona,
  SpeechPlaybackStatus,
  SpeechRuntimeStatus,
  SpeechSynthesisCommand
} from "@shared/speechControlContract";
import {
  speechControlClient,
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
  const playback = ref<SpeechPlaybackStatus | null>(null);
  const microphone = ref<SpeechMicrophoneStatus | null>(null);
  const audioInputs = ref<SpeechAudioInput[]>([]);
  const loading = ref(false);
  const error = ref("");
  const listening = computed(() => microphone.value?.running === true);
  const playbackBusy = computed(() => Boolean(playback.value?.current));

  let subscribers = 0;
  let statusTimer = 0;
  let playbackTimer = 0;
  let microphoneTimer = 0;
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

  async function refreshAll(): Promise<void> {
    await Promise.all([
      refreshStatus(),
      refreshModels(),
      refreshPersonas(),
      refreshAudioInputs(),
      refreshMicrophone(),
      refreshPlayback()
    ]);
  }

  function startPolling(): void {
    if (microphoneTimer) return;
    statusTimer = window.setInterval(() => void refreshStatus().catch(rememberError), 15_000);
    playbackTimer = window.setInterval(() => void refreshPlayback().catch(rememberError), 1_000);
    microphoneTimer = window.setInterval(() => void refreshMicrophone().catch(rememberError), 400);
  }

  function stopPolling(): void {
    window.clearInterval(statusTimer);
    window.clearInterval(playbackTimer);
    window.clearInterval(microphoneTimer);
    statusTimer = 0;
    playbackTimer = 0;
    microphoneTimer = 0;
  }

  async function acquire(): Promise<() => void> {
    subscribers += 1;
    if (subscribers === 1) {
      await refreshAll().catch(cause => {
        rememberError(cause);
      });
      startPolling();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      subscribers = Math.max(0, subscribers - 1);
      if (subscribers === 0) stopPolling();
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

  function submitTranscript(command: SpeechMessageCommand): Promise<SpeechMessageAccepted> {
    return speechControlClient.submitTranscript(command);
  }

  async function synthesize(command: SpeechSynthesisCommand): Promise<SpeechSynthesisResult> {
    const result = await speechControlClient.synthesize(command);
    if (command.play) await refreshPlayback();
    return result;
  }

  function transcribe(blob: Blob, name: string, model: string, language?: string): Promise<SpeechTranscriptionResult> {
    return speechControlClient.transcribe(blob, name, model, language);
  }

  return {
    status,
    models,
    personas,
    playback,
    microphone,
    audioInputs,
    loading,
    error,
    listening,
    playbackBusy,
    acquire,
    refreshStatus,
    refreshModels,
    refreshPersonas,
    refreshAudioInputs,
    refreshMicrophone,
    refreshPlayback,
    startMicrophone,
    stopMicrophone,
    stopPlayback,
    submitTranscript,
    synthesize,
    transcribe
  };
});
