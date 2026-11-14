import { createAiuiAssistantRuntime } from "../../../../../packages/assistant-runtime/src/aiui-runtime.js";
import { createVoiceInteraction } from "../../../../../packages/assistant-runtime/src/voice-interaction.js";
import { createAssistantCapture } from "./assistantCapture";
import { createAssistantPlayback } from "./assistantPlayback";
import { createRolePanelAssistant, type AssistantReply, type AssistantAdmission } from "./rolePanelAssistant";
import { createSpeechControlClient } from "../../../io.rabiroute.manager.speech/web/speech/speechControlClient";
import type { SpeechPersona } from "@shared/speechControlContract";

export type DesktopAssistantSelection = { gatewayId: string; persona: SpeechPersona; asrModel: string; ttsModel: string };
export type DesktopAssistantEvent =
  | { type: "input"; text: string }
  | { type: "reply"; reply: AssistantReply }
  | { type: "admission"; admission: AssistantAdmission }
  | { type: "capture"; state: "starting" | "listening" | "stopped" }
  | { type: "status"; text: string }
  | { type: "error"; error: unknown };

/** One voice owner, a native first-layer Agent and two host I/O adapters. No model/tool loop is reimplemented here. */
export function createDesktopAssistant(selection: DesktopAssistantSelection, ports: {
  fetch: typeof fetch; openEvents(path: string): EventSource; onEvent(event: DesktopAssistantEvent): void;
}) {
  if (!selection.gatewayId || !selection.persona.voiceReady || !selection.asrModel || !selection.ttsModel)
    throw new Error("ASSISTANT_SELECTION_NOT_READY");
  let closed = false, visible = true, outputAllowed = true;
  const report = (error: unknown) => { if (!closed) ports.onEvent({ type: "error", error }); };
  const client = createSpeechControlClient(ports.fetch);
  const playbackListeners = new Set<(value: { jobs?: readonly Record<string, unknown>[] }) => void>();
  const speechEvents = ports.openEvents("/api/speech/events");
  const roleEvents = ports.openEvents("/api/events");
  const acceptPlayback = (value: { jobs?: readonly Record<string, unknown>[] }) => {
    if (!closed) for (const listener of [...playbackListeners]) listener(value);
  };
  speechEvents.addEventListener("playback_changed", event => {
    try { acceptPlayback(JSON.parse((event as MessageEvent).data)); } catch (error) { report(error); }
  });
  speechEvents.addEventListener("ready", () => {
    // One event-driven snapshot also recovers a terminal job missed during reconnect. No polling loop.
    void client.playbackStatus().then(acceptPlayback).catch(report);
  });
  const tts = createAssistantPlayback({ client, voice: selection.persona.id, model: selection.ttsModel,
    speed: selection.persona.speed, language: selection.persona.language, instructions: selection.persona.instructions,
    routeId: selection.gatewayId, onError: report,
    subscribe: listener => { playbackListeners.add(listener); return () => playbackListeners.delete(listener); }
  });
  const asr = createAssistantCapture({ transcribe: (blob, signal) => client.transcribe(blob, "utterance.wav", selection.asrModel,
    selection.persona.language, undefined, selection.gatewayId, signal) });
  const runtime = createAiuiAssistantRuntime({ asr, tts, onCleanupError: report });
  const voice = createVoiceInteraction({ runtime, onError: report,
    // The host FIFO includes synthesis and queue wait. Timeout is failure, never a played receipt.
    playback: { playbackTimeoutMs: duration => Math.max(duration, 120_000) },
    onInput: input => { ports.onEvent({ type: "input", text: input.text }); return assistant.send(input.text); },
    onEvent: event => {
      if (closed) return;
      if (event.type === "speech-interrupted" && event.reason === "manual") ports.onEvent({ type: "status", text: "朗读已停止，文字回复会保留" });
      if (event.type === "playback" && event.event.type === "error") report(event.event.error);
      if (event.type === "listening") {
        if (event.event.type === "starting" || event.event.type === "listening") ports.onEvent({ type: "capture", state: event.event.type });
        if (event.event.type === "ended" || event.event.type === "paused") ports.onEvent({ type: "capture", state: "stopped" });
        if (event.event.type === "ended" && event.event.reason !== "end") report(event.event.error
          || new Error("麦克风未能启动，请检查权限或重新开启麦克风。"));
      }
    }
  });
  const assistant = createRolePanelAssistant({ roleId: selection.persona.id, gatewayId: selection.gatewayId, voice,
    onReply: reply => ports.onEvent({ type: "reply", reply }), onError: report,
    onAdmission: admission => ports.onEvent({ type: "admission", admission }),
    async send(command) {
      const response = await ports.fetch("/api/role-panel/messages", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...command, expectedRoleId: selection.persona.id })
      });
      const result = await response.json();
      if (!response.ok && !(result.uncertain && result.messageId)) throw new Error(result.message || `HTTP ${response.status}`);
      return result;
    }
  });
  roleEvents.addEventListener("role_panel_message", event => {
    try { assistant.receive(JSON.parse((event as MessageEvent).data)); } catch (error) { report(error); }
  });
  roleEvents.addEventListener("open", () => {
    void ports.fetch(`/api/roles/${encodeURIComponent(selection.persona.id)}/role-panel/messages?limit=120`).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      for (const message of payload.messages ?? []) if (message.direction === "assistant" && message.status === "sent")
        assistant.receive({ ...message, messageId: message.id });
    }).catch(report);
  });
  roleEvents.onerror = () => { if (!closed) ports.onEvent({ type: "status", text: "消息连接重连中；已提交的任务继续执行" }); };
  speechEvents.onerror = () => { if (!closed) ports.onEvent({ type: "status", text: "语音状态连接重连中" }); };
  return Object.freeze({
    activate: () => !closed && visible ? voice.activate({ continuous: true, interimResults: true }) : null,
    setVisible(value: boolean) {
      if (closed) return;
      visible = value;
      voice.setOutputEnabled(visible && outputAllowed);
      if (!visible) voice.pauseListening();
    },
    setOutputEnabled(value: boolean) {
      if (closed) return;
      outputAllowed = value;
      voice.setOutputEnabled(visible && outputAllowed);
    },
    pauseVoice() {
      if (closed) return;
      outputAllowed = false;
      voice.setOutputEnabled(false);
      voice.pauseListening();
    },
    submitText: (text: string) => voice.submitText(text),
    interrupt: () => voice.interruptSpeech("manual"),
    getState: () => voice.getState(),
    async dispose() {
      if (closed) return;
      closed = true;
      assistant.dispose(); voice.dispose(); runtime.dispose();
      speechEvents.close(); roleEvents.close(); playbackListeners.clear();
      await tts.dispose();
    }
  });
}
