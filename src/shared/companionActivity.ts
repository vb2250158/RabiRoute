export const COMPANION_ACTIVITY_KINDS = ["play", "watch", "work", "other", "uncertain"] as const;
export type CompanionActivityKind = typeof COMPANION_ACTIVITY_KINDS[number];
export type CompanionPreset = {
  id: string; label: string; labelEn: string; reviewSeconds: number; replyAgeSeconds: number;
  reactionAgeSeconds?: number; guidance: string; activityKind?: Exclude<CompanionActivityKind, "uncertain">;
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
};
export type CompanionNote = { at: number; speaker: "user" | "assistant"; text: string };
export type CompanionSession = {
  id: string; roleId: string; gatewayId: string; presetId: string; title: string;
  status: "active" | "paused" | "ended"; revision: number; startedAt: number; endedAt?: number;
  pauseReason?: "capture_lost" | "user";
  lastObservationAt: number | null; positionSeconds: number | null; subtitle: string;
  autoReview: boolean; voice: boolean; saveSummary: boolean; notes: CompanionNote[];
  review: { id: string; status: "dispatching" | "delivered" | "replied" | "failed" | "expired"; error?: string } | null;
  error: string;
  observationOwner: "desktop" | "browser";
  window: CompanionObservation["window"] | null;
  activityKind: CompanionActivityKind;
  version: number;
};
export type CompanionResumeIntent = Pick<CompanionSession, "gatewayId" | "presetId" | "title" | "autoReview" | "voice" | "saveSummary"> & { observationOwner: "desktop" };
export type CompanionSnapshot = { presets: CompanionPreset[]; session: CompanionSession | null; resumeIntent?: CompanionResumeIntent | null };
