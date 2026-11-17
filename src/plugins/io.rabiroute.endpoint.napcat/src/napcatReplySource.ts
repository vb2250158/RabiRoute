import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { recordDataMutationAudit } from "@rabiroute/host-api/observability/dataMutationAudit";
import { readExactQqMessage } from "./manager/qqMessageRoutes.js";
import { qqMessageMedia, readQqMedia } from "./manager/qqMessageMedia.js";
import { QQ_READ_LIMITS } from "./manager/qqReadContract.js";

/** Internal provider operation. Endpoint and audit directory come from the send owner. */
export async function readReplySource(input: {
  endpoint: { httpUrl: string; accessToken: string }; groupId: string; messageId: string;
  instanceId: string; dataDir: string;
}, transport?: typeof fetch): Promise<Record<string, unknown>> {
  const signal = AbortSignal.timeout(QQ_READ_LIMITS.mediaTimeoutMs);
  const current = () => signal.throwIfAborted();
  const row = await readExactQqMessage({ endpoint: input.endpoint, kind: "group", target: input.groupId,
    messageId: input.messageId, signal, current, transport });
  const attachments = [];
  for (const [index, media] of qqMessageMedia(row.message ?? row.raw_message).entries()) {
    if (media.kind !== "image") continue;
    const bytes = await readQqMedia(input.endpoint, media, signal, transport);
    current();
    const directory = path.join(input.dataDir, "napcat-media", "reply-source", createHash("sha256")
      .update(JSON.stringify([input.instanceId, input.groupId, input.messageId])).digest("hex"));
    const imagePath = path.join(directory, `${createHash("sha256").update(bytes).digest("hex")}.image`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(imagePath, bytes);
    recordDataMutationAudit({ group: "napcat", event: "reply_source_image_written", owner: "napcat-reply-source",
      action: "store-reply-source-image", target: { type: "reply-source-image", id: "managed-image" },
      dataSource: { kind: "file", id: "napcat-media/reply-source" }, outcome: "committed" });
    attachments.push({ id: `${input.messageId}:image:${index + 1}`, kind: "image", status: "ready", path: imagePath });
  }
  current();
  return { messageId: input.messageId, groupId: input.groupId, instanceId: input.instanceId,
    segments: Array.isArray(row.message) ? row.message : undefined,
    rawMessage: typeof row.message === "string" ? row.message : row.raw_message, attachments };
}
