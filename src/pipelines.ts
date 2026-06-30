import type { MessageAdapterType } from "./adapters/messageAdapter.js";

export type OutputAdapterType = "qq" | "codex" | "file" | "console" | "tts" | "webhook" | "fennenote" | "wecom" | "none";
export type PromptOutputMode = "qq_text" | "voice_short" | "markdown" | "json" | "plain_text";

export type PipelinePresetId = "qq_chat" | "wecom_chat" | "voice_chat" | "webhook_task";

export type PipelineDefinition = {
  id?: string;
  name?: string;
  inputAdapter?: MessageAdapterType;
  outputAdapter?: OutputAdapterType;
  outputPipeline?: string;
  promptOutputMode?: PromptOutputMode;
  ttsProvider?: string;
  ttsVoice?: string;
  ttsWorkerUrl?: string;
  ttsPlay?: boolean;
  preventFeedbackLoop?: boolean;
  replyToSource?: boolean;
};

export type ResolvedPipeline = Required<Pick<PipelineDefinition,
  "id" | "name" | "outputAdapter" | "outputPipeline" | "promptOutputMode" | "ttsProvider" |
  "ttsVoice" | "ttsWorkerUrl"
>> & {
  inputAdapter?: MessageAdapterType;
  ttsPlay: boolean;
  preventFeedbackLoop: boolean;
  replyToSource: boolean;
};

export const pipelinePresets: Record<PipelinePresetId, ResolvedPipeline> = {
  qq_chat: {
    id: "qq_chat",
    name: "QQ chat",
    inputAdapter: "napcat",
    outputAdapter: "qq",
    outputPipeline: "qq",
    promptOutputMode: "qq_text",
    ttsProvider: "",
    ttsVoice: "",
    ttsWorkerUrl: "",
    ttsPlay: false,
    preventFeedbackLoop: true,
    replyToSource: true
  },
  wecom_chat: {
    id: "wecom_chat",
    name: "WeCom chat",
    inputAdapter: "wecom",
    outputAdapter: "wecom",
    outputPipeline: "wecom",
    promptOutputMode: "markdown",
    ttsProvider: "",
    ttsVoice: "",
    ttsWorkerUrl: "",
    ttsPlay: false,
    preventFeedbackLoop: true,
    replyToSource: true
  },
  voice_chat: {
    id: "voice_chat",
    name: "Voice chat",
    inputAdapter: "webhook",
    outputAdapter: "fennenote",
    outputPipeline: "fennenote",
    promptOutputMode: "voice_short",
    ttsProvider: "oumuq",
    ttsVoice: "",
    ttsWorkerUrl: "http://127.0.0.1:8793/api/fennenote/playback",
    ttsPlay: true,
    preventFeedbackLoop: true,
    replyToSource: false
  },
  webhook_task: {
    id: "webhook_task",
    name: "Webhook task",
    inputAdapter: "webhook",
    outputAdapter: "file",
    outputPipeline: "file",
    promptOutputMode: "markdown",
    ttsProvider: "",
    ttsVoice: "",
    ttsWorkerUrl: "",
    ttsPlay: false,
    preventFeedbackLoop: false,
    replyToSource: false
  }
};

const fallbackPipeline: ResolvedPipeline = {
  id: "legacy",
  name: "Legacy route",
  inputAdapter: undefined,
  outputAdapter: "codex",
  outputPipeline: "codex",
  promptOutputMode: "plain_text",
  ttsProvider: "",
  ttsVoice: "",
  ttsWorkerUrl: "",
  ttsPlay: false,
  preventFeedbackLoop: false,
  replyToSource: false
};

function isMessageAdapterType(value: string): value is MessageAdapterType {
  return value === "napcat" || value === "fennenote" || value === "xiaoai" || value === "webhook" || value === "wecom" || value === "heartbeat" || value === "rolePanel" || value === "disabled";
}

function isOutputAdapterType(value: string): value is OutputAdapterType {
  return value === "qq" || value === "codex" || value === "file" || value === "console" || value === "tts" || value === "webhook" || value === "fennenote" || value === "wecom" || value === "none";
}

function isPromptOutputMode(value: string): value is PromptOutputMode {
  return value === "qq_text" || value === "voice_short" || value === "markdown" || value === "json" || value === "plain_text";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function normalizePipelineDefinition(raw: unknown): PipelineDefinition | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const item = raw as Record<string, unknown>;
  const inputAdapter = optionalString(item.inputAdapter);
  const outputAdapter = optionalString(item.outputAdapter);
  const promptOutputMode = optionalString(item.promptOutputMode);

  return {
    id: optionalString(item.id),
    name: optionalString(item.name),
    inputAdapter: inputAdapter && isMessageAdapterType(inputAdapter) ? inputAdapter : undefined,
    outputAdapter: outputAdapter && isOutputAdapterType(outputAdapter) ? outputAdapter : undefined,
    outputPipeline: optionalString(item.outputPipeline),
    promptOutputMode: promptOutputMode && isPromptOutputMode(promptOutputMode) ? promptOutputMode : undefined,
    ttsProvider: optionalString(item.ttsProvider),
    ttsVoice: optionalString(item.ttsVoice),
    ttsWorkerUrl: optionalString(item.ttsWorkerUrl),
    ttsPlay: optionalBoolean(item.ttsPlay),
    preventFeedbackLoop: optionalBoolean(item.preventFeedbackLoop),
    replyToSource: optionalBoolean(item.replyToSource)
  };
}

export function resolvePipeline(presetId?: string, overrides?: PipelineDefinition): ResolvedPipeline {
  const preset = presetId && presetId in pipelinePresets
    ? pipelinePresets[presetId as PipelinePresetId]
    : fallbackPipeline;
  const id = overrides?.id ?? preset.id;

  return {
    ...preset,
    ...overrides,
    id,
    name: overrides?.name ?? preset.name,
    inputAdapter: overrides?.inputAdapter ?? preset.inputAdapter,
    outputAdapter: overrides?.outputAdapter ?? preset.outputAdapter,
    outputPipeline: overrides?.outputPipeline ?? preset.outputPipeline,
    promptOutputMode: overrides?.promptOutputMode ?? preset.promptOutputMode,
    ttsProvider: overrides?.ttsProvider ?? preset.ttsProvider,
    ttsVoice: overrides?.ttsVoice ?? preset.ttsVoice,
    ttsWorkerUrl: overrides?.ttsWorkerUrl ?? preset.ttsWorkerUrl,
    ttsPlay: overrides?.ttsPlay ?? preset.ttsPlay,
    preventFeedbackLoop: overrides?.preventFeedbackLoop ?? preset.preventFeedbackLoop,
    replyToSource: overrides?.replyToSource ?? preset.replyToSource
  };
}
