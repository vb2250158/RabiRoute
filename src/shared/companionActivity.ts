export const COMPANION_ACTIVITY_KINDS = ["play", "watch", "work", "other", "uncertain"] as const;
export type CompanionActivityKind = typeof COMPANION_ACTIVITY_KINDS[number];
export type CompanionPreset = {
  id: string; label: string; labelEn: string; reviewSeconds: number; replyAgeSeconds: number;
  reactionAgeSeconds?: number; silenceReviewSeconds?: number; guidance: string; activityKind?: Exclude<CompanionActivityKind, "uncertain">;
  allowAutomaticReplies?: boolean;
};
export type CompanionCommand = {
  sessionId: string; revision: number; action: "pause" | "resume" | "seek" | "stop" | "interrupt" | "set-mode";
  positionSeconds?: number; pauseReason?: "capture_lost"; presetId?: string;
};
export type CompanionObservation = {
  sequence: number; capturedAt: number; source: "window" | "player";
  subtitle?: string; positionSeconds?: number; paused?: boolean; jpeg?: string;
  window?: { id: string; title: string; processName: string };
  media?: { kind: "video" | "audio" | "unknown"; status: "playing" | "paused"; title: string };
  interval?: { startedAt: number; endedAt: number; frameTimes: number[]; sampleCount: number; coverageStartedAt: number; jpeg: string };
  audio?: { startedAt: number; endedAt: number; pcm: string; status: "ready" | "starting" | "unavailable"; missingMs: number; suppressedMs: number; error?: string };
};
export type CompanionObservationPolicy = {
  captureSeconds: number; uploadSeconds: number; historySeconds: number; maxFrameBytes: number;
  storyboardFrames: number; tileWidth: number; changeThreshold: number; audioUploadSeconds: number;
  transcriptionTimeoutSeconds: number; initialReviewSeconds: number;
};
export type CompanionNote = { at: number; speaker: "user" | "assistant"; text: string };
export type CompanionSession = {
  id: string; roleId: string; gatewayId: string; presetId: string; title: string;
  status: "active" | "paused" | "ended"; revision: number; startedAt: number; endedAt?: number;
  lastInteractionAt?: number;
  pauseReason?: "capture_lost" | "user";
  lastObservationAt: number | null; positionSeconds: number | null; subtitle: string;
  observationStartedAt?: number; audioThrough?: number;
  autoReview: boolean; voice: boolean; saveSummary: boolean; notes: CompanionNote[];
  participation?: { lastCommentAt: number | null; quietReplies: number };
  review: { id: string; status: "dispatching" | "delivered" | "replied" | "failed" | "expired"; error?: string; errorCode?: string;
    outcome?: "commented" | "quiet" | "comment_expired"; deliveredAt?: number; reactionExpiresAt?: number;
    observation?: { startedAt: number; endedAt: number; frameCount: number; sampleCount: number; audioStatus: string;
      transcriptCharacters: number; missingAudioMs: number; excludedPetVoiceMs: number } } | null;
  error: string;
  observationOwner: "desktop" | "browser";
  window: CompanionObservation["window"] | null;
  activityKind: CompanionActivityKind;
  version: number;
};
export type CompanionResumeIntent = Pick<CompanionSession, "gatewayId" | "presetId" | "title" | "autoReview" | "voice" | "saveSummary"> & { observationOwner: "desktop" };
export type CompanionSnapshot = { presets: CompanionPreset[]; session: CompanionSession | null; resumeIntent?: CompanionResumeIntent | null; observationPolicy?: CompanionObservationPolicy };
