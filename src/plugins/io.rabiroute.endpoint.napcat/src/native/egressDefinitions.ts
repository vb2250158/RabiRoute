import type { MessageEndpointSendVariant, MessageEndpointVariantMedia } from "@rabiroute/plugin-sdk";
export type NativeEgressFamily = "notice" | "ai-record" | "text-forward" | "source-forward" | "flash" | "album-comment" | "online-file" | "album-image" | "online-folder";
type FamilyDefinition = Pick<MessageEndpointSendVariant, "dataSchema" | "receiptMode" | "readText" | "readMedia" | "allowEmptyText" | "description">;
const numericId = { type: "string", pattern: "^[1-9][0-9]{0,15}$" };
const text = { type: "string", minLength: 1 };
const sourceSchema = { type: "object", additionalProperties: false, required: ["kind", "targetId", "messageId"], properties: {
        kind: { enum: ["group", "private"] }, targetId: numericId, messageId: { type: "string", pattern: "^-?[0-9]{1,20}$" }
    } };
const attachmentSchema = { type: "object", additionalProperties: false, required: ["fileId", "fileSha256"], properties: {
        fileId: { type: "string", minLength: 1, maxLength: 256 }, fileSha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" }
    } };
const acknowledgement = "The original OneBot action acknowledgement is recorded through agent.send. It does not certify visible delivery or a platform message ID.";
function managedAttachment(data: Readonly<Record<string, unknown>>, kind: "image" | "file"): MessageEndpointVariantMedia {
    return { attachments: [{ kind, ...(data.attachment as {
                    fileId: string;
                    fileSha256: string;
                }) }] };
}
const families: Readonly<Record<NativeEgressFamily, FamilyDefinition>> = {
    notice: {
        description: `Text-only group notice. ${acknowledgement}`, receiptMode: "ack-only",
        dataSchema: { type: "object", additionalProperties: false, required: ["content"], properties: {
                content: text, pinned: { type: "integer", enum: [0, 1] }, confirmRequired: { type: "integer", enum: [0, 1] },
                showEditCard: { type: "integer", enum: [0, 1] }, tipWindowType: { type: "integer", minimum: 0, maximum: 2 }
            } },
        readText: data => String(data.content)
    },
    "ai-record": {
        description: `Group AI voice. Native message_id=0 is never treated as a sent message. ${acknowledgement}`, receiptMode: "ack-only",
        dataSchema: { type: "object", additionalProperties: false, required: ["character", "text"], properties: {
                character: { type: "string", minLength: 1, maxLength: 256 }, text
            } },
        readText: data => String(data.text), readMedia: () => ({ kinds: ["voice"] })
    },
    "text-forward": {
        description: "Caller-authored text nodes use the actual selected bot author. Arbitrary OneBot segments and spoofed node senders are not supported by this shape.",
        receiptMode: "message", dataSchema: { type: "object", additionalProperties: false, required: ["nodes"], properties: {
                nodes: { type: "array", minItems: 1, maxItems: 100, items: text }
            } },
        readText: data => (data.nodes as string[]).join("\n\n")
    },
    "source-forward": {
        description: `An exact source message is compared to the text/media snapshot admitted by agent.send. Only text, image, voice and file segments are supported. ${acknowledgement}`,
        receiptMode: "ack-only", allowEmptyText: true,
        dataSchema: { type: "object", additionalProperties: false, required: ["source", "text", "mediaKinds"], properties: {
                source: sourceSchema, text: { type: "string" }, mediaKinds: { type: "array", uniqueItems: true, items: { enum: ["image", "voice", "file"] } }
            } },
        readText: data => String(data.text), readMedia: data => ({ kinds: data.mediaKinds as ("image" | "voice" | "file")[] })
    },
    flash: {
        description: `Only a fileset from the exact selected native message is used. Native errCode=0 is required. ${acknowledgement}`,
        receiptMode: "ack-only", allowEmptyText: true,
        dataSchema: { type: "object", additionalProperties: false, required: ["source"], properties: { source: sourceSchema } },
        readText: () => "", readMedia: () => ({ kinds: ["file"] })
    },
    "album-comment": {
        description: `The published native result is opaque; its fields are not interpreted as proof of a persisted or visible comment. ${acknowledgement}`,
        receiptMode: "ack-only", dataSchema: { type: "object", additionalProperties: false, required: ["albumId", "imageId", "content"], properties: {
                albumId: text, imageId: text, content: text
            } },
        readText: data => String(data.content)
    },
    "online-file": {
        description: `A leased managed single file is SHA-verified, staged through the native file owner, then sent to a private peer. No Manager path is treated as a native path. ${acknowledgement}`,
        receiptMode: "ack-only", allowEmptyText: true,
        dataSchema: { type: "object", additionalProperties: false, required: ["attachment"], properties: { attachment: attachmentSchema } },
        readText: () => "", readMedia: data => managedAttachment(data, "file")
    },
    "online-folder": {
        description: `Only an authenticated native directory reference from the original WebUI File owner is accepted. Its selected OneBot configuration, current source identity and directory snapshot are rechecked under the original lifecycle lease. The native directory is not an immutable OS snapshot. ${acknowledgement}`,
        receiptMode: "ack-only", allowEmptyText: true,
        dataSchema: { type: "object", additionalProperties: false, required: ["directoryRef"], properties: {
                directoryRef: { type: "string", minLength: 1, maxLength: 256 }, folderName: { type: "string", maxLength: 255 }
            } },
        readText: data => typeof data.folderName === "string" ? data.folderName : "",
        readMedia: () => ({ kinds: ["file"] })
    },
    "album-image": {
        description: `Only a SHA-verified leased managed image is supplied as native base64. Opaque upload data does not certify album visibility. ${acknowledgement}`,
        receiptMode: "ack-only", dataSchema: { type: "object", additionalProperties: false, required: ["attachment", "albumId", "albumName"], properties: {
                attachment: attachmentSchema, albumId: text, albumName: text
            } },
        readText: data => String(data.albumName), readMedia: data => managedAttachment(data, "image")
    }
};
export const napcatNativeEgressDefinitions: readonly {
    action: string;
    family: NativeEgressFamily;
    targets: readonly ("group" | "private")[];
}[] = [
    { action: "_send_group_notice", family: "notice", targets: ["group"] },
    { action: "send_group_ai_record", family: "ai-record", targets: ["group"] },
    { action: "send_forward_msg", family: "text-forward", targets: ["group", "private"] },
    { action: "send_private_forward_msg", family: "text-forward", targets: ["private"] },
    { action: "send_group_forward_msg", family: "text-forward", targets: ["group"] },
    { action: "forward_friend_single_msg", family: "source-forward", targets: ["group", "private"] },
    { action: "forward_group_single_msg", family: "source-forward", targets: ["group", "private"] },
    { action: "send_flash_msg", family: "flash", targets: ["group", "private"] },
    { action: "do_group_album_comment", family: "album-comment", targets: ["group"] },
    { action: "send_online_file", family: "online-file", targets: ["private"] },
    { action: "send_online_folder", family: "online-folder", targets: ["private"] },
    { action: "upload_image_to_qun_album", family: "album-image", targets: ["group"] }
];
export function nativeEgressVariant(definition: typeof napcatNativeEgressDefinitions[number]): MessageEndpointSendVariant {
    return Object.freeze({ ...families[definition.family], type: `napcat.native-${definition.action}`, contractVersion: 1,
        operation: `sendNative_${definition.action}`,
        paramsSchema: { type: "object", additionalProperties: false, required: ["target", "instanceId"], properties: {
                target: { enum: definition.targets }, groupId: numericId, userId: numericId, instanceId: { type: "string", minLength: 1, maxLength: 256 }
            } }
    });
}
