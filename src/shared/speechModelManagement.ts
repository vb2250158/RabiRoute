export type SpeechManagedModelCapability = "tts" | "asr" | "speaker";
export type SpeechManagedModelRuntime = "core" | "isolated";
export type SpeechManagedModelStatus = "not_downloaded" | "downloaded" | "failed" | "downloading";

export type SpeechManagedModel = {
  alias: string;
  capability: SpeechManagedModelCapability;
  name: string;
  family: string;
  source: string;
  sourceUrl: string;
  sizeGiB?: number;
  runtime: SpeechManagedModelRuntime;
  purposeZh: string;
  purposeEn: string;
  status: SpeechManagedModelStatus;
  downloaded: boolean;
  lastError?: string;
};

export type SpeechModelManagementJob = {
  id: string;
  kind: "runtime" | "model";
  modelAlias?: string;
  state: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  message: string;
  error?: string;
};

export type SpeechModelManagementSnapshot = {
  platformSupported: boolean;
  dependenciesInstalled: boolean;
  windowsHostInstalled: boolean;
  catalogVersion: number;
  models: SpeechManagedModel[];
  activeJob?: SpeechModelManagementJob;
  lastJob?: SpeechModelManagementJob;
};
