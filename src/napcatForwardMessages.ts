import {
  getForwardMessage,
  type ForwardMessageNode,
  type NapCatEndpoint,
  type OneBotMessage,
  type OneBotMessageSegment
} from "./napcat.js";

export type ResolvedForwardMessageNode = {
  time?: number;
  messageId?: number | string;
  userId?: number | string;
  senderName?: string;
  rawMessage: string;
};

export type ResolvedForwardMessage = {
  forwardId: string;
  nodes: ResolvedForwardMessageNode[];
};

export type EnrichedNapCatMessage = {
  rawMessage: string;
  originalRawMessage?: string;
  forwardedMessages?: ResolvedForwardMessage[];
  errors: Array<{ forwardId: string; message: string }>;
};

const maxForwardNodes = 100;
const maxRenderedForwardLength = 30_000;

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function segments(message: unknown): OneBotMessageSegment[] {
  return Array.isArray(message) ? message as OneBotMessageSegment[] : [];
}

function forwardIdFromSegment(segment: OneBotMessageSegment): string {
  if (segment.type !== "forward") {
    return "";
  }
  return stringValue(segment.data?.id ?? segment.data?.message_id ?? segment.data?.resid);
}

export function forwardMessageIdsForTest(message: unknown, rawMessage = ""): string[] {
  const ids = segments(message).map(forwardIdFromSegment).filter(Boolean);
  const cqPattern = /\[CQ:forward,[^\]]*(?:id|message_id|resid)=([^,\]]+)[^\]]*\]/g;
  for (const match of rawMessage.matchAll(cqPattern)) {
    if (match[1]) {
      ids.push(match[1]);
    }
  }
  return [...new Set(ids)];
}

function mediaLabel(type: string, data: Record<string, unknown>): string {
  const summary = stringValue(data.summary ?? data.name ?? data.file);
  const url = stringValue(data.url);
  const detail = [summary, url].filter(Boolean).join(" ");
  const labels: Record<string, string> = {
    image: "图片",
    video: "视频",
    record: "语音",
    file: "文件",
    json: "JSON卡片",
    xml: "XML卡片",
    face: "表情",
    reply: "回复",
    at: "@"
  };
  return `[${labels[type] ?? type}${detail ? `: ${detail}` : ""}]`;
}

export function renderOneBotMessageForTest(message: OneBotMessage | undefined, rawMessage = ""): string {
  if (typeof message === "string") {
    return message;
  }

  const rendered = segments(message).map((segment) => {
    if (segment.type === "text") {
      return stringValue(segment.data?.text);
    }
    if (segment.type === "forward") {
      const id = forwardIdFromSegment(segment);
      return `[合并转发${id ? `: ${id}` : ""}]`;
    }
    return mediaLabel(segment.type, segment.data ?? {});
  }).join("").trim();

  return rendered || rawMessage;
}

function normalizeForwardNode(node: ForwardMessageNode): ResolvedForwardMessageNode {
  return {
    time: node.time,
    messageId: node.message_id,
    userId: node.user_id ?? node.sender?.user_id,
    senderName: node.sender?.card || node.sender?.nickname,
    rawMessage: renderOneBotMessageForTest(node.message, node.raw_message ?? "")
  };
}

export function renderResolvedForwardMessagesForTest(messages: ResolvedForwardMessage[]): string {
  const lines: string[] = [];
  for (const item of messages) {
    lines.push(`[合并转发消息 id=${item.forwardId}，共 ${item.nodes.length} 条]`);
    item.nodes.forEach((node, index) => {
      const timestamp = node.time ? new Date(node.time * 1000).toISOString() : "时间未知";
      const sender = node.senderName || (node.userId != null ? String(node.userId) : "未知发送者");
      lines.push(`${index + 1}. ${timestamp} | ${sender} | ${node.rawMessage || "[空消息]"}`);
    });
  }
  const rendered = lines.join("\n");
  return rendered.length > maxRenderedForwardLength
    ? `${rendered.slice(0, maxRenderedForwardLength)}\n[合并转发内容过长，已截断]`
    : rendered;
}

export async function enrichNapCatMessage(
  message: unknown,
  rawMessage: string,
  endpoint: NapCatEndpoint
): Promise<EnrichedNapCatMessage> {
  const forwardIds = forwardMessageIdsForTest(message, rawMessage);
  if (forwardIds.length === 0) {
    return { rawMessage, errors: [] };
  }

  const forwardedMessages: ResolvedForwardMessage[] = [];
  const errors: EnrichedNapCatMessage["errors"] = [];
  for (const forwardId of forwardIds) {
    try {
      const result = await getForwardMessage(forwardId, endpoint);
      forwardedMessages.push({
        forwardId,
        nodes: result.messages.slice(0, maxForwardNodes).map(normalizeForwardNode)
      });
    } catch (error) {
      errors.push({
        forwardId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const rendered = renderResolvedForwardMessagesForTest(forwardedMessages);
  return {
    rawMessage: rendered ? `${rawMessage}\n\n${rendered}` : rawMessage,
    originalRawMessage: rawMessage,
    forwardedMessages: forwardedMessages.length > 0 ? forwardedMessages : undefined,
    errors
  };
}
