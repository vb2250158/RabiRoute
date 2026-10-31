import { ROLE_PANEL_ATTACHMENT_KINDS, ROLE_PANEL_DIRECTIONS, ROLE_PANEL_MESSAGE_STATUSES } from "../rolePanelTimeline.js";

const attachmentSchema = { type: "object", required: ["kind"], additionalProperties: false, properties: {
  kind: { enum: ROLE_PANEL_ATTACHMENT_KINDS }, name: { type: "string" }, path: { type: "string" }, url: { type: "string" }, size: { type: "number", minimum: 0 }
} } as const;
export const rolePanelMessageSchema = { type: "object", required: ["id", "time", "roleId", "direction", "sender", "text", "attachments", "status"], additionalProperties: true, properties: {
  id: { type: "string" }, time: { anyOf: [{ type: "number" }, { type: "null" }] }, roleId: { type: "string" }, gatewayId: { type: "string" }, routeProfileId: { type: "string" },
  direction: { enum: ROLE_PANEL_DIRECTIONS }, sender: { type: "string" }, text: { type: "string" }, attachments: { type: "array", items: attachmentSchema },
  status: { enum: ROLE_PANEL_MESSAGE_STATUSES }, replyContext: { type: "object", additionalProperties: true }
} } as const;
