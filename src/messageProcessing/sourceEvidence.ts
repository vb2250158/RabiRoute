import fs from "node:fs";
import path from "node:path";
import { readGroupMessages, readPrivateMessages, type MessageAttachmentRecord } from "../history.js";
import type { PendingMessageGroup } from "../messageGrouping.js";

export type MessageProcessingSourceAttachmentEvidence = {
  id: string;
  messageId: string;
  kind: MessageAttachmentRecord["kind"];
  name: string;
  mimeType?: string;
  size?: number;
  path?: string;
  status: MessageAttachmentRecord["status"];
  error?: string;
};

export type MessageGroupSourceEvidence = {
  replyChainMessageIds: string[];
  attachments: MessageProcessingSourceAttachmentEvidence[];
  readyImagePaths: string[];
};

type RecordLike = Record<string, unknown>;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function replyIds(record: RecordLike): string[] {
  const output = new Set<string>();
  for (const key of ["repliedMessageId", "replyToMessageId"]) {
    const value = text(record[key]);
    if (value) output.add(value);
  }
  for (const match of text(record.rawMessage).matchAll(/\[CQ:reply,([^\]]+)\]/gi)) {
    const id = String(match[1] || "").match(/(?:^|,)id=([^,\]]+)/)?.[1];
    if (id) output.add(id);
  }
  return [...output];
}

function attachmentEvidence(record: RecordLike, messageId: string): MessageProcessingSourceAttachmentEvidence[] {
  const raw = Array.isArray(record.attachments) ? record.attachments : [];
  const attachments: MessageProcessingSourceAttachmentEvidence[] = raw.flatMap((value, index): MessageProcessingSourceAttachmentEvidence[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Partial<MessageAttachmentRecord>;
    const kind: MessageProcessingSourceAttachmentEvidence["kind"] = item.kind === "video" || item.kind === "audio" || item.kind === "file" ? item.kind : "image";
    const status = item.status === "ready" && item.path && fs.existsSync(item.path) ? "ready" as const : "unavailable" as const;
    return [{
      id: text(item.id) || `${messageId}:${kind}:${index + 1}`,
      messageId,
      kind,
      name: text(item.name) || `${kind}-${index + 1}`,
      mimeType: text(item.mimeType) || undefined,
      size: Number.isFinite(Number(item.size)) ? Number(item.size) : undefined,
      path: status === "ready" ? path.resolve(String(item.path)) : undefined,
      status,
      error: status === "unavailable" ? text(item.error) || "附件记录存在，但本地文件不可读。" : undefined
    }];
  });
  const imageCount = [...text(record.rawMessage).matchAll(/\[CQ:image\b[^\]]*\]/gi)].length;
  const recordedImageCount = attachments.filter((item) => item.kind === "image").length;
  for (let index = recordedImageCount; index < imageCount; index += 1) {
    attachments.push({
      id: `${messageId}:image:${index + 1}`,
      messageId,
      kind: "image",
      name: `image-${index + 1}`,
      mimeType: undefined,
      size: undefined,
      path: undefined,
      status: "unavailable",
      error: "QQ 图片没有保存为本地附件，Agent 不能据此推断图片内容。"
    });
  }
  return attachments;
}

export function collectMessageGroupSourceEvidence(group: PendingMessageGroup, dataDir: string): MessageGroupSourceEvidence {
  const currentRecords = group.items.map((item) => item.payload.record as RecordLike);
  const sourceIds = new Set(currentRecords.map((record) => text(record.messageId)).filter(Boolean));
  const history = [...readGroupMessages(dataDir), ...readPrivateMessages(dataDir)] as unknown as RecordLike[];
  const byId = new Map<string, RecordLike>();
  for (const record of history) {
    const messageId = text(record.messageId);
    if (messageId) byId.set(messageId, record);
  }
  const replyChainMessageIds: string[] = [];
  const records = [...currentRecords];
  const queued = new Set<string>([
    ...(group.replyToMessageId ? [group.replyToMessageId] : []),
    ...currentRecords.flatMap(replyIds)
  ].map(text).filter(Boolean));
  const visited = new Set<string>(sourceIds);
  for (let depth = 0; depth < 10 && queued.size > 0; depth += 1) {
    const batch = [...queued];
    queued.clear();
    for (const messageId of batch) {
      if (visited.has(messageId)) continue;
      visited.add(messageId);
      replyChainMessageIds.push(messageId);
      const record = byId.get(messageId);
      if (!record) continue;
      records.push(record);
      for (const next of replyIds(record)) if (!visited.has(next)) queued.add(next);
    }
  }
  const attachments = records.flatMap((record) => {
    const messageId = text(record.messageId) || "unknown-message";
    return attachmentEvidence(record, messageId);
  });
  const deduped = [...new Map(attachments.map((item) => [item.id, item])).values()];
  return {
    replyChainMessageIds,
    attachments: deduped,
    readyImagePaths: [...new Set(deduped
      .filter((item) => item.kind === "image" && item.status === "ready" && item.path)
      .map((item) => item.path!))]
  };
}
