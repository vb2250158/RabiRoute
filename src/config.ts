import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const defaultGroupNotificationTemplate = [
  "QQ 消息更新提醒：群聊里有人 @ 了机器人。",
  "时间：{time}",
  "目标：{messageTarget}",
  "群号：{groupId}",
  "发送者：{sender}",
  "消息：{message}",
  "",
  "请在需要时读取 {groupLogPath} 查看上下文。"
].join("\n");

export const defaultGroupAtNotificationTemplate = defaultGroupNotificationTemplate;
export const defaultGroupDirectReplyNotificationTemplate = defaultGroupNotificationTemplate.replace("群聊里有人 @ 了机器人", "群聊里有人直接回复机器人");
export const defaultGroupIndirectReplyNotificationTemplate = defaultGroupNotificationTemplate.replace("群聊里有人 @ 了机器人", "群聊里有人回复了一条提到机器人的消息");

export const defaultPrivateNotificationTemplate = [
  "QQ 消息更新提醒：收到一条私聊消息。",
  "时间：{time}",
  "目标：{messageTarget}",
  "发送者：{sender}",
  "QQ：{userId}",
  "消息：{message}",
  "",
  "请在需要时读取 {privateLogPath} 查看上下文。"
].join("\n");

export const config = {
  napcatHttpUrl: process.env.NAPCAT_HTTP_URL ?? "http://127.0.0.1:3000",
  napcatAccessToken: process.env.NAPCAT_ACCESS_TOKEN ?? "",
  gatewayPort: Number(process.env.GATEWAY_PORT ?? "8789"),
  codexAppServerUrl: process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4500",
  codexDirectNotify: process.env.CODEX_DIRECT_NOTIFY === "1",
  codexDesktopIpcNotify: process.env.CODEX_DESKTOP_IPC_NOTIFY !== "0",
  codexThreadName: process.env.CODEX_THREAD_NAME ?? "QQ 消息监听",
  codexCwd: process.env.CODEX_CWD ?? "C:\\Data\\CottonProject\\PangHu",
  targetGroupId: process.env.TARGET_GROUP_ID ?? "",
  botNickname: process.env.BOT_NICKNAME ?? "胖虎助手",
  dataDir: path.resolve(rootDir, process.env.DATA_DIR ?? "./data"),
  groupNotificationTemplate: process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupNotificationTemplate,
  groupAtNotificationTemplate: process.env.GROUP_AT_NOTIFICATION_TEMPLATE || process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupAtNotificationTemplate,
  groupDirectReplyNotificationTemplate: process.env.GROUP_DIRECT_REPLY_NOTIFICATION_TEMPLATE || process.env.GROUP_REPLY_NOTIFICATION_TEMPLATE || process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupDirectReplyNotificationTemplate,
  groupIndirectReplyNotificationTemplate: process.env.GROUP_INDIRECT_REPLY_NOTIFICATION_TEMPLATE || process.env.GROUP_NICKNAME_NOTIFICATION_TEMPLATE || process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupIndirectReplyNotificationTemplate,
  privateNotificationTemplate: process.env.PRIVATE_NOTIFICATION_TEMPLATE || defaultPrivateNotificationTemplate
};

export function isTargetGroup(groupId: number | string | undefined): boolean {
  if (!groupId) {
    return false;
  }

  return !config.targetGroupId || String(groupId) === config.targetGroupId;
}
