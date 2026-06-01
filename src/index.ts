import { WebSocketServer } from "ws";
import path from "node:path";
import { buildReply } from "./commands.js";
import { config, isTargetGroup } from "./config.js";
import { appendGroupMessage, appendPrivateMessage, readGroupMessages, type GroupMessageRecord, type PrivateMessageRecord } from "./history.js";
import { sendGroupMessage, sendPrivateMessage } from "./napcat.js";
import { askQClaw } from "./qclaw.js";

type OneBotEvent = {
  post_type?: string;
  message_type?: string;
  group_id?: number;
  user_id?: number;
  time?: number;
  message_id?: number | string;
  raw_message?: string;
  message?: unknown;
  self_id?: number;
  sender?: {
    nickname?: string;
    card?: string;
  };
};

type OneBotMessageSegment = {
  type?: string;
  data?: Record<string, unknown>;
};

type GroupRoute = {
  kind: "direct_at" | "direct_reply" | "indirect_reply";
};

function textFromEvent(event: OneBotEvent): string {
  if (typeof event.raw_message === "string") {
    return event.raw_message;
  }

  if (typeof event.message === "string") {
    return event.message;
  }

  return "";
}

function messageSegments(event: OneBotEvent): OneBotMessageSegment[] {
  return Array.isArray(event.message) ? event.message as OneBotMessageSegment[] : [];
}

function segmentValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function hasStructuredAtSelf(event: OneBotEvent): boolean {
  const segments = messageSegments(event);
  if (segments.length === 0) {
    return false;
  }

  return segments.some((segment) => {
    if (segment.type !== "at") {
      return false;
    }

    const qq = segmentValue(segment.data?.qq);
    return !event.self_id || qq === String(event.self_id) || qq === "all";
  });
}

function hasReplySegment(event: OneBotEvent): boolean {
  return messageSegments(event).some((segment) => segment.type === "reply") || textFromEvent(event).includes("[回复消息]");
}

function replyMessageId(event: OneBotEvent): string | null {
  const replySegment = messageSegments(event).find((segment) => segment.type === "reply");
  const structuredId = segmentValue(replySegment?.data?.id);
  if (structuredId) {
    return structuredId;
  }

  const match = textFromEvent(event).match(/\[CQ:reply,id=([^\],]+)[^\]]*\]/);
  return match?.[1] ?? null;
}

function contentMentionsBot(content: string, selfId?: number): boolean {
  if (selfId && content.includes(`[CQ:at,qq=${selfId}]`)) {
    return true;
  }

  if (content.includes(`@${config.botNickname}`)) {
    return true;
  }

  return !selfId && content.includes("[CQ:at,");
}

function findRepliedGroupMessage(event: OneBotEvent): GroupMessageRecord | null {
  if (!event.group_id) {
    return null;
  }

  const id = replyMessageId(event);
  if (!id) {
    return null;
  }

  return readGroupMessages()
    .slice()
    .reverse()
    .find((message) => message.groupId === event.group_id && String(message.messageId) === id) ?? null;
}

function repliedMessageMentionsBot(event: OneBotEvent): boolean {
  const repliedMessage = findRepliedGroupMessage(event);
  return repliedMessage ? contentMentionsBot(repliedMessage.rawMessage, event.self_id) : false;
}

function getGroupRoute(event: OneBotEvent): GroupRoute | null {
  const content = textFromEvent(event);
  const mentionsBotByText = contentMentionsBot(content, event.self_id);
  const mentionsBotBySegment = hasStructuredAtSelf(event);
  const isReply = hasReplySegment(event);

  if (isReply && (mentionsBotBySegment || mentionsBotByText)) {
    return { kind: "direct_reply" };
  }

  if (isReply && repliedMessageMentionsBot(event)) {
    return { kind: "indirect_reply" };
  }

  if (mentionsBotBySegment || mentionsBotByText) {
    return { kind: "direct_at" };
  }

  return null;
}

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function commonTemplateValues(record: GroupMessageRecord | PrivateMessageRecord): Record<string, string | number | undefined> {
  const sender = record.senderName || record.userId;
  const isGroup = "groupId" in record;
  const targetId = isGroup ? record.groupId : record.userId;
  const targetType = isGroup ? "group" : "private";
  return {
    time: formatTime(record.time),
    sender,
    senderName: record.senderName,
    userId: record.userId,
    groupId: isGroup ? record.groupId : undefined,
    targetType,
    targetId,
    messageTarget: isGroup ? `群 ${targetId}` : `私聊 ${targetId}`,
    message: record.rawMessage,
    rawMessage: record.rawMessage,
    messageId: record.messageId,
    botNickname: config.botNickname,
    dataDir: config.dataDir,
    groupLogPath: path.join(config.dataDir, "group-messages.jsonl"),
    privateLogPath: path.join(config.dataDir, "private-messages.jsonl")
  };
}

function isSelfMessage(event: OneBotEvent): boolean {
  return Boolean(event.self_id && event.user_id === event.self_id);
}

function logActivity(kind: string, details: string): void {
  console.log(`[${new Date().toLocaleString("zh-CN", { hour12: false })}] [${kind}] ${details}`);
}

async function handleGroupMessage(event: OneBotEvent): Promise<void> {
  if (!event.group_id || !event.user_id || !isTargetGroup(event.group_id)) {
    return;
  }
  if (isSelfMessage(event)) {
    return;
  }

  const record: GroupMessageRecord = {
    time: event.time ?? Math.floor(Date.now() / 1000),
    groupId: event.group_id,
    userId: event.user_id,
    rawMessage: textFromEvent(event),
    messageId: event.message_id,
    senderName: event.sender?.card || event.sender?.nickname
  };

  appendGroupMessage(record);

  // Handle simple built-in commands first
  const builtinReply = buildReply(record);
  if (builtinReply) {
    await sendGroupMessage({
      groupId: record.groupId,
      message: builtinReply
    });
    return;
  }

  // Only process AI for messages that mention the bot
  const route = getGroupRoute(event);
  if (!route) {
    return;
  }

  const mentionedText = record.rawMessage
    .replace(/\[CQ:at,qq=\d+\]/g, "")
    .replace(new RegExp(`@${config.botNickname}`, "g"), "")
    .trim();

  if (!mentionedText) {
    await sendGroupMessage({
      groupId: record.groupId,
      message: "我在听～有什么可以帮你的？"
    });
    return;
  }

  logActivity("group_mention", `群 ${record.groupId} ${record.senderName || record.userId}: ${mentionedText.slice(0, 60)}`);

  try {
    const aiReply = await askQClaw(mentionedText, record.userId, {
      senderName: record.senderName,
      isGroup: true,
      groupId: record.groupId
    });

    // Split long messages for QQ
    const maxLen = 1500;
    if (aiReply.length <= maxLen) {
      await sendGroupMessage({
        groupId: record.groupId,
        message: aiReply
      });
    } else {
      const parts = splitLongMessage(aiReply, maxLen);
      for (const part of parts) {
        await sendGroupMessage({
          groupId: record.groupId,
          message: part
        });
      }
    }
  } catch (error) {
    logActivity("error", `QClaw request failed: ${error instanceof Error ? error.message : String(error)}`);
    await sendGroupMessage({
      groupId: record.groupId,
      message: "抱歉，我暂时处理不了这条消息～"
    });
  }
}

async function handlePrivateMessage(event: OneBotEvent): Promise<void> {
  if (!event.user_id) {
    return;
  }
  if (isSelfMessage(event)) {
    return;
  }

  const record: PrivateMessageRecord = {
    time: event.time ?? Math.floor(Date.now() / 1000),
    userId: event.user_id,
    rawMessage: textFromEvent(event),
    messageId: event.message_id,
    senderName: event.sender?.nickname
  };

  appendPrivateMessage(record);

  // Handle simple commands
  const content = record.rawMessage.trim();
  if (content === "/ping" || content === "ping") {
    await sendPrivateMessage({
      userId: record.userId,
      message: `${config.botNickname} 私聊在线`
    });
    return;
  }

  if (!content) {
    return;
  }

  logActivity("private", `私聊 ${record.senderName || record.userId}: ${content.slice(0, 60)}`);

  try {
    const aiReply = await askQClaw(content, record.userId, {
      senderName: record.senderName,
      isGroup: false
    });

    const maxLen = 1500;
    if (aiReply.length <= maxLen) {
      await sendPrivateMessage({
        userId: record.userId,
        message: aiReply
      });
    } else {
      const parts = splitLongMessage(aiReply, maxLen);
      for (const part of parts) {
        await sendPrivateMessage({
          userId: record.userId,
          message: part
        });
      }
    }
  } catch (error) {
    logActivity("error", `QClaw request failed: ${error instanceof Error ? error.message : String(error)}`);
    await sendPrivateMessage({
      userId: record.userId,
      message: "抱歉，我暂时处理不了你的消息～"
    });
  }
}

function splitLongMessage(text: string, maxLen: number): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Try to split at a natural boundary
    const chunk = remaining.slice(0, maxLen);
    const lastNewline = chunk.lastIndexOf("\n");
    const lastPeriod = chunk.lastIndexOf("。");
    const splitAt = lastNewline > maxLen * 0.7 ? lastNewline
      : lastPeriod > maxLen * 0.7 ? lastPeriod + 1
      : maxLen;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) {
    parts.push(remaining);
  }
  return parts;
}

const server = new WebSocketServer({
  host: "127.0.0.1",
  port: config.gatewayPort
});

server.on("connection", (socket, request) => {
  console.log(`NapCat connected from ${request.socket.remoteAddress}`);

  socket.on("message", async (data) => {
    try {
      const event = JSON.parse(data.toString()) as OneBotEvent;
      if (event.post_type === "message" && event.message_type === "group") {
        await handleGroupMessage(event);
      }
      if (event.post_type === "message" && event.message_type === "private") {
        await handlePrivateMessage(event);
      }
    } catch (error) {
      console.error("Failed to handle event", error);
    }
  });
});

server.on("listening", () => {
  console.log(`NapCatQClawGateway listening on ws://127.0.0.1:${config.gatewayPort}`);
  console.log(`QClaw Gateway: ${config.qclawGatewayUrl}`);
  console.log(`NapCat HTTP API: ${config.napcatHttpUrl}`);
  console.log(`Bot nickname: ${config.botNickname}`);
  console.log(config.targetGroupId ? `Target group: ${config.targetGroupId}` : "Target group: all groups");
});
