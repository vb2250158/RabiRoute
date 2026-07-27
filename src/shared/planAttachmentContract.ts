export const PLAN_MAX_ATTACHMENTS = 8;
export const PLAN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const PLAN_ATTACHMENTS_MAX_BYTES = 25 * 1024 * 1024;
export const PLAN_ATTACHMENT_REQUEST_MAX_BYTES = 36 * 1024 * 1024;

export type PlanAttachmentKind = "file" | "image" | "video";

export type PlanAttachment = {
  id: string;
  kind: PlanAttachmentKind;
  name: string;
  path: string;
  size: number;
  mimeType?: string;
  sha256: string;
};

export type PlanAttachmentInput = {
  id?: string;
  name?: string;
  path?: string;
  mimeType?: string;
  contentBase64?: string;
};

export type PlanAttachmentPresentation = Omit<PlanAttachment, "path">;
