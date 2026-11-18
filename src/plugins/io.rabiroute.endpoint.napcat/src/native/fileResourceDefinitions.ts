import type { MessageEndpointManagedAttachmentReference } from "@rabiroute/plugin-sdk";
export const managedNativeAttachmentReferenceSchema = {
    oneOf: [
        { type: "object", additionalProperties: false, required: ["fileId", "fileSha256"], properties: {
                fileId: { type: "string", minLength: 1, maxLength: 256 }, fileSha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" }
            } },
        { type: "object", additionalProperties: false, required: ["planAttachment"], properties: {
                planAttachment: { type: "object", additionalProperties: false, required: ["roleId", "planId", "attachmentId"], properties: {
                        roleId: { type: "string", minLength: 1 }, planId: { type: "string", minLength: 1 }, attachmentId: { type: "string", minLength: 1 }
                    } }
            } }
    ]
};
export type ManagedNativeAttachmentReference = MessageEndpointManagedAttachmentReference;
export const nativeFileReferenceSchema = {
    type: "object", additionalProperties: false, required: ["id", "action", "deliveryId", "bytes", "sha256", "name"], properties: {
        id: { type: "string", pattern: "^[a-f0-9]{64}$" }, action: { enum: ["download_file", "upload_file_stream"] },
        deliveryId: { type: "string", minLength: 1, maxLength: 200 }, bytes: { type: "integer", minimum: 0 },
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, name: { type: "string" }
    }
};
export const nativeFileInputReferenceSchema = { type: "object", additionalProperties: false, required: ["nativeFile"], properties: {
        nativeFile: { type: "object", additionalProperties: false, required: ["id", "action", "deliveryId"], properties: {
                id: { type: "string", pattern: "^[a-f0-9]{64}$" }, action: { enum: ["download_file", "upload_file_stream"] },
                deliveryId: { type: "string", minLength: 1, maxLength: 200 }
            } }
    } };
export const nativeFileResourceParameters = {
    download_file: {
        type: "object", additionalProperties: false, required: ["attachment"], properties: {
            attachment: managedNativeAttachmentReferenceSchema
        }
    },
    upload_file_stream: {
        type: "object", additionalProperties: false, required: ["attachment"], properties: {
            attachment: managedNativeAttachmentReferenceSchema,
            fileRetentionMs: { type: "integer", minimum: 0, maximum: 2147483647 }
        }
    },
    create_flash_task: {
        type: "object", additionalProperties: false, required: ["attachments"], properties: {
            attachments: { type: "array", minItems: 1, items: { oneOf: [managedNativeAttachmentReferenceSchema, nativeFileInputReferenceSchema] } },
            name: { type: "string" }
        }
    }
};
