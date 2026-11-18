import { createHash } from "node:crypto";
import { readExactQqMessage } from "./qqMessageRoutes.js";
import { qqMessageMedia, readQqMedia } from "./qqMessageMedia.js";
import { NapcatApiError, verifyNapcatApiIdentity, type NapcatApiSelection, type NapcatApiTransportContext } from "./napcatApiTransport.js";

export const napcatApiAttachmentSourceSchema = { type: "object", additionalProperties: false,
  required: ["kind", "targetId", "messageId", "attachmentIndex"], properties: {
    kind: { enum: ["group", "private"] }, targetId: { type: "string", pattern: "^[1-9][0-9]{0,15}$" },
    messageId: { type: "string", pattern: "^-?[0-9]{1,20}$" }, attachmentIndex: { type: "integer", minimum: 0 }
  } } as const;

type Source = { kind: "group" | "private"; targetId: string; messageId: string; attachmentIndex: number };
export type NapcatApiAttachmentInput = "image-file" | "ocr-image" | "audio-message";

/** Resolve through the original exact-message/media owner. Caller URLs, host paths and arbitrary file IDs are never used. */
export async function prepareNapcatApiAttachmentParams(context: NapcatApiTransportContext, selection: NapcatApiSelection,
  parameters: Readonly<Record<string, unknown>>, mode: NapcatApiAttachmentInput, signal: AbortSignal): Promise<{
    parameters: Record<string, unknown>; digest: unknown
  }> {
  const source = parameters.attachment as Source;
  await verifyNapcatApiIdentity(context, selection, signal);
  const message = await readExactQqMessage({ endpoint: selection, kind: source.kind, target: source.targetId,
    messageId: source.messageId, signal, current: selection.assertCurrent, transport: context.transport });
  selection.assertCurrent();
  const media = qqMessageMedia(message.message)[source.attachmentIndex];
  if (!media || media.kind !== (mode === "audio-message" ? "audio" : "image")) throw new NapcatApiError(422, "QQ_API_ATTACHMENT_KIND_MISMATCH");
  const { attachment: _, ...nativeParameters } = parameters;
  if (mode === "audio-message") return { parameters: { ...nativeParameters, message_id: source.messageId },
    digest: { source, messageId: String(message.message_id) } };
  const bytes = await readQqMedia(selection, media, signal, context.transport);
  selection.assertCurrent();
  return { parameters: { ...nativeParameters, [mode === "ocr-image" ? "image" : "file"]: `base64://${bytes.toString("base64")}` },
    digest: { source, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length } };
}
