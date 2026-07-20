import { config } from "./config.js";
import {
  appendGroupMessageToDir,
  appendPrivateMessageToDir,
  readGroupMessages,
  readPrivateMessages,
  type GroupMessageRecord,
  type PrivateMessageRecord
} from "./history.js";
import { getMessage, type MessageInfo, type NapCatEndpoint, type OneBotMessage } from "./napcat.js";

type ReplyChainError = {
  messageId: string;
  message: string;
};

export type ResolveNapCatReplyChainResult = {
  resolvedMessageIds: string[];
  errors: ReplyChainError[];
};

type ResolveNapCatReplyChainOptions = {
  rawMessage: string;
  message?: unknown;
  currentMessageId?: string | number;
  sourceMessageType: "group" | "private";
  sourceGroupId?: number;
  sourceUserId?: number;
  selfId?: number;
  botNickname?: string;
  instanceId: string;
  endpoint: NapCatEndpoint;
  dataDir?: string;
  maxDepth?: number;
  getMessageById?: (messageId: string, endpoint: NapCatEndpoint) => Promise<MessageInfo>;
};

const DEFAULT_MAX_REPLY_DEPTH = 10;

function segmentValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function replyIds(rawMessage: string, message?: unknown): string[] {
  const ids = new Set<string>();
  if (Array.isArray(message)) {
    for (const segment of message as Array<{ type?: string; data?: Record<string, unknown> }>) {
      if (segment.type !== "reply") continue;
      const id = segmentValue(segment.data?.id);
      if (id) ids.add(id);
    }
  }

  for (const match of rawMessage.matchAll(/\[CQ:reply,([^\]]+)\]/g)) {
    const id = match[1].match(/(?:^|,)id=([^,\]]+)/)?.[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

function localMessageIndex(dataDir: string): Map<string, GroupMessageRecord | PrivateMessageRecord> {
  const index = new Map<string, GroupMessageRecord | PrivateMessageRecord>();
  for (const record of [...readGroupMessages(dataDir), ...readPrivateMessages(dataDir)]) {
    if (record.messageId != null) {
      index.set(String(record.messageId), record);
    }
  }
  return index;
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function appendResolvedMessage(
  info: MessageInfo,
  options: ResolveNapCatReplyChainOptions,
  dataDir: string
): GroupMessageRecord | PrivateMessageRecord | null {
  const messageId = info.messageId;
  const userId = numberValue(info.userId) ?? options.selfId ?? options.sourceUserId;
  if (messageId == null || userId == null) return null;

  const selfId = numberValue(info.selfId) ?? options.selfId;
  const isSelf = selfId != null && userId === selfId;
  const common = {
    time: numberValue(info.time) ?? Math.floor(Date.now() / 1000),
    userId,
    rawMessage: info.rawMessage,
    messageId,
    senderName: info.senderName,
    repliedMessageId: replyIds(info.rawMessage, info.message)[0],
    instanceId: options.instanceId,
    adapterType: "napcat",
    botUserId: selfId == null ? undefined : String(selfId),
    botNickname: options.botNickname,
    isSelf,
    lookupSource: "onebot_get_msg" as const
  };

  const messageType = info.messageType === "group" || info.messageType === "private"
    ? info.messageType
    : options.sourceMessageType;
  if (messageType === "group") {
    const groupId = numberValue(info.groupId) ?? options.sourceGroupId;
    if (groupId == null) return null;
    const record: GroupMessageRecord = { ...common, groupId };
    appendGroupMessageToDir(record, dataDir);
    return record;
  }

  const record: PrivateMessageRecord = common;
  appendPrivateMessageToDir(record, dataDir);
  return record;
}

export async function resolveNapCatReplyChain(
  options: ResolveNapCatReplyChainOptions
): Promise<ResolveNapCatReplyChainResult> {
  const dataDir = options.dataDir ?? config.memoryDataDir;
  const maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_MAX_REPLY_DEPTH);
  const getMessageById = options.getMessageById ?? ((messageId, endpoint) => getMessage(messageId, endpoint));
  const result: ResolveNapCatReplyChainResult = {
    resolvedMessageIds: [],
    errors: []
  };
  const initialReplyIds = replyIds(options.rawMessage, options.message);
  if (initialReplyIds.length === 0) return result;

  const localById = localMessageIndex(dataDir);
  const visited = new Set<string>(options.currentMessageId == null ? [] : [String(options.currentMessageId)]);
  const queue = initialReplyIds.map((messageId) => ({ messageId, depth: 0 }));

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || next.depth >= maxDepth || visited.has(next.messageId)) continue;
    visited.add(next.messageId);

    let record = localById.get(next.messageId);
    if (!record) {
      try {
        const info = await getMessageById(next.messageId, options.endpoint);
        record = appendResolvedMessage(info, options, dataDir) ?? undefined;
        if (!record) {
          throw new Error("NapCat get_msg returned an incomplete message record");
        }
        localById.set(next.messageId, record);
        result.resolvedMessageIds.push(next.messageId);
      } catch (error) {
        result.errors.push({
          messageId: next.messageId,
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
    }

    for (const replyId of replyIds(record.rawMessage)) {
      queue.push({ messageId: replyId, depth: next.depth + 1 });
    }
  }

  return result;
}

export function replyIdsForTest(rawMessage: string, message?: OneBotMessage): string[] {
  return replyIds(rawMessage, message);
}
