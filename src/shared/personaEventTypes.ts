export const RECORDING_CAPTURE_TYPES = [
  { value: "microphone", title: "麦克风", english: "Microphone", icon: "mdi-microphone", routeKind: "recording_microphone" },
  { value: "screen", title: "屏幕", english: "Screen", icon: "mdi-monitor", routeKind: "recording_screen" },
  { value: "window", title: "前台窗口", english: "Foreground window", icon: "mdi-application-outline", routeKind: "recording_window" },
  { value: "camera", title: "摄像头", english: "Camera", icon: "mdi-camera-outline", routeKind: "recording_camera" },
  { value: "homeAssistant", title: "Home Assistant 活动", english: "Home Assistant activity", icon: "mdi-home-assistant", routeKind: "recording_home_assistant" },
  { value: "mobile", title: "手机记录", english: "Phone recordings", icon: "mdi-cellphone", routeKind: "recording_mobile" },
  { value: "systemAudio", title: "电脑播放", english: "System playback", icon: "mdi-volume-high", routeKind: "recording_system_audio" },
  { value: "session", title: "采集状态", english: "Capture status", icon: "mdi-record-circle-outline", routeKind: "recording_session" }
] as const;

export type CaptureEventRouteKind = typeof RECORDING_CAPTURE_TYPES[number]["routeKind"];
export function isCaptureEventRouteKind(value: string): value is CaptureEventRouteKind {
  return RECORDING_CAPTURE_TYPES.some(type => type.routeKind === value);
}

export const VOICE_RECEIVED_ROUTE_KIND = "voice_received";

export function requiresExplicitEventRule(value: string): boolean {
  return value === VOICE_RECEIVED_ROUTE_KIND || isCaptureEventRouteKind(value);
}

export const MESSAGE_EVENT_CATEGORIES = [
  { value: "napcat", title: "QQ (NapCat / OneBot)", english: "QQ (NapCat / OneBot)", icon: "mdi-qqchat", routeKinds: ["direct_at", "direct_reply", "indirect_reply", "group_message", "private"] },
  { value: "qqbot", title: "QQ 官方机器人", english: "Official QQ Bot", icon: "mdi-robot-outline", routeKinds: ["qqbot_private", "qqbot_group", "qqbot_channel", "qqbot_dm", "qqbot_event"] },
  { value: "weixin", title: "个人微信 / Weixin", english: "Weixin", icon: "mdi-wechat", routeKinds: ["weixin_message"] },
  { value: "wecom", title: "企业微信 / WeCom", english: "WeCom", icon: "mdi-account-group", routeKinds: ["wecom_message"] },
  { value: "feishu", title: "飞书 / Feishu", english: "Feishu", icon: "mdi-message-text-outline", routeKinds: ["feishu_message"] },
  { value: "xiaomiHome", title: "米家 / Xiaomi Home", english: "Xiaomi Home", icon: "mdi-home-automation", routeKinds: ["xiaomi_home_event"] },
  { value: "speech", title: "语音服务", english: "Speech service", icon: "mdi-microphone", routeKinds: ["voice_transcript"] },
  { value: "rolePanel", title: "角色面板 / 桌面入口", english: "Persona panel / desktop", icon: "mdi-desktop-classic", routeKinds: ["role_panel_message", "manual_trigger"] },
  { value: "wearable", title: "智能手表/手环", english: "Wearables", icon: "mdi-watch", routeKinds: ["wearable_health_alert"] },
  { value: "rabilink", title: "RabiLink", english: "RabiLink", icon: "mdi-link-variant", routeKinds: ["rabilink"] },
  { value: "schedule", title: "定时任务", english: "Scheduled tasks", icon: "mdi-calendar-clock-outline", routeKinds: ["heartbeat"] },
  { value: "webhook", title: "通用 Webhook / 其他", english: "Webhook / Other", icon: "mdi-webhook", routeKinds: [] }
] as const;

export type MessageEventCategory = typeof MESSAGE_EVENT_CATEGORIES[number]["value"];
export function messageEventCategory(routeKind: string, adapter?: string): MessageEventCategory | undefined {
  if (routeKind === "plan_feedback" || requiresExplicitEventRule(routeKind)) return;
  if (routeKind === "voice_transcript" && adapter === "webhook") return "webhook";
  return MESSAGE_EVENT_CATEGORIES.find(category => category.routeKinds.some(kind => kind === routeKind))?.value ?? "webhook";
}
