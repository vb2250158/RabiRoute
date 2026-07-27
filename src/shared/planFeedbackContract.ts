export const PLAN_FEEDBACK_MAX_ATTACHMENTS = 8;
export const PLAN_FEEDBACK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const PLAN_FEEDBACK_ATTACHMENTS_MAX_BYTES = 25 * 1024 * 1024;
export const PLAN_FEEDBACK_REQUEST_MAX_BYTES = 36 * 1024 * 1024;

export type PlanFeedbackAttachmentKind = "file" | "image";

export type PlanFeedbackAttachment = {
  kind: PlanFeedbackAttachmentKind;
  name: string;
  path: string;
  size: number;
  mimeType?: string;
  sha256: string;
};

export type PlanFeedbackAttachmentUpload = {
  kind?: PlanFeedbackAttachmentKind;
  name: string;
  mimeType?: string;
  contentBase64: string;
};
