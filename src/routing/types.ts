import type {
  GroupMessageRecord,
  HeartbeatEventRecord,
  ManualTriggerRecord,
  PrivateMessageRecord,
  RolePanelMessageRecord,
  WeComMessageRecord,
  VoiceTranscriptEventRecord
} from "../history.js";

export type ForwardRouteKind =
  | "private"
  | "group_message"
  | "direct_at"
  | "direct_reply"
  | "indirect_reply"
  | "heartbeat"
  | "manual_trigger"
  | "role_panel_message"
  | "voice_transcript"
  | "wecom_message";

export type ForwardLogKind = "private" | "group_mention" | "heartbeat" | "manual_trigger" | "role_panel_message" | "voice_transcript" | "wecom_message";

export type ForwardRecord =
  | GroupMessageRecord
  | PrivateMessageRecord
  | HeartbeatEventRecord
  | ManualTriggerRecord
  | RolePanelMessageRecord
  | WeComMessageRecord
  | VoiceTranscriptEventRecord;

export type ForwardTemplateValues = Record<string, string | number | undefined>;
