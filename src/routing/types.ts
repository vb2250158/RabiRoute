import type { CaptureEventRouteKind } from "../shared/personaEventTypes.js";
import type {
  GroupMessageRecord,
  HeartbeatEventRecord,
  ManualTriggerRecord,
  PlanFeedbackMessageRecord,
  PrivateMessageRecord,
  QqBotMessageRecord,
  RolePanelMessageRecord,
  FeishuMessageRecord,
  WeComMessageRecord,
  WeixinMessageRecord,
  VoiceTranscriptEventRecord
} from "../history.js";

export type ForwardRouteKind =
  | "private"
  | "qqbot_private"
  | "qqbot_group"
  | "qqbot_channel"
  | "qqbot_dm"
  | "qqbot_event"
  | "group_message"
  | "direct_at"
  | "direct_reply"
  | "indirect_reply"
  | "heartbeat"
  | "manual_trigger"
  | "role_panel_message"
  | "plan_feedback"
  | "voice_transcript"
  | "rabilink"
  | "wearable_health_alert"
  | "wecom_message"
  | "weixin_message"
  | "feishu_message"
  | "xiaomi_home_event"
  | CaptureEventRouteKind;

export type ForwardLogKind = "private" | "group_mention" | "heartbeat" | "manual_trigger" | "role_panel_message" | "plan_feedback" | "voice_transcript" | "rabilink" | "wearable_health_alert" | "wecom_message" | "weixin_message" | "feishu_message" | "xiaomi_home_event";

export interface MessageGroupForwardMetadata {
  messageGroupId?: string;
  messageGroupMessageIds?: string[];
}

export type ForwardRecord = (
  | GroupMessageRecord
  | PrivateMessageRecord
  | QqBotMessageRecord
  | HeartbeatEventRecord
  | ManualTriggerRecord
  | RolePanelMessageRecord
  | PlanFeedbackMessageRecord
  | WeComMessageRecord
  | FeishuMessageRecord
  | WeixinMessageRecord
  | VoiceTranscriptEventRecord
) & MessageGroupForwardMetadata;

export type ForwardTemplateValues = Record<string, string | number | undefined>;
