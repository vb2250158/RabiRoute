import { rolePanelMessageSchema } from "./rolePanelMessageContract.js";
import { normalizeRolePanelAttachments,
  ROLE_PANEL_DEFAULT_READ_LIMIT, type RolePanelTimelineMessage } from "../rolePanelTimeline.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { errorResponsePresentation } from "../shared/errorPresentation.js";
import { deliverRolePanelMessage, RolePanelDeliveryError, type RolePanelDelivery, type RolePanelDeliveryOptions } from "./rolePanelDelivery.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";
import type { ApiOperationDefinition, ApiSchema } from "./apiOperationContract.js";
import { LOCAL_AGENT_MESSAGE_TIMEOUT_MS } from "./localAgentMessageProcess.js";

export type RolePanelOperationsOwner = {
  runtimes(): { get(id: string): GatewayRuntime | undefined; values(): Iterable<GatewayRuntime> };
  roleId(runtime: GatewayRuntime): string;
  assertLocalOwner(runtime: GatewayRuntime): void;
  deliver: RolePanelDelivery;
  timelineAppender(): RolePanelDeliveryOptions["appendTimeline"];
  readMessages(roleId: string, limit: number, signal?: AbortSignal): Promise<RolePanelTimelineMessage[]>;
};
const empty = { type: "object", additionalProperties: false } as const;
// JSON.stringify historically projected non-finite legacy timestamps to null.
const projectMessage = (message: RolePanelTimelineMessage) => ({ ...message, time: Number.isFinite(message.time) ? message.time : null });
const errorSchema: ApiSchema = { type: "object", required: ["code", "message"], additionalProperties: true, properties: { code: { const: -1 }, message: { type: "string" } } };
const sendErrorSchema = (uncertain: boolean): ApiSchema => ({ type: "object", required: ["code", "status", "message", "commitState", ...(uncertain ? ["uncertain", "messageId", "replyContext"] : [])], additionalProperties: true, properties: {
  code: { const: -1 }, status: { const: "failed" }, message: { type: "string" }, commitState: { const: uncertain ? "uncertain" : "not_started" },
  ...(uncertain ? { uncertain: { const: true }, messageId: { type: "string" }, replyContext: { type: "object", additionalProperties: true } } : {})
} });

export function createRolePanelOperations(owner: RolePanelOperationsOwner): readonly ApiOperationDefinition[] {
  return [{ contract: {
    operationId: "manager.role-panel.messages.list", aliases: ["persona:GET:/api/roles/:roleId/role-panel/messages"], contractVersion: "1.0.0",
    method: "GET", pathTemplate: "/api/roles/:roleId/role-panel/messages", exposure: "public", transport: "http", description: "Read the original role-panel timeline through its read owner; the first limit query value is used.",
    request: { path: { type: "object", required: ["roleId"], properties: { roleId: { type: "string" } }, additionalProperties: false },
      query: { type: "object", properties: { limit: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } }, additionalProperties: true }, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "roleId", "messages"], additionalProperties: false, properties: {
      code: { const: 0 }, roleId: { type: "string" }, messages: { type: "array", items: rolePanelMessageSchema }
    } } }, "400": { mediaType: "application/json", schema: errorSchema }, "503": { mediaType: "application/json", schema: errorSchema } },
    effects: { mode: "read", description: "Reads the selected role's original timeline; it does not dispatch or replay a message." },
    recovery: { strategy: "repeatable-read", description: "Repeat the same read after worker recovery. A missing row does not prove that a previous delivery was not accepted." },
    validators: [{ id: "role-panel-read-normalization", description: `The original role ID sanitizer selects the role. The first limit uses native Number coercion, defaults to ${ROLE_PANEL_DEFAULT_READ_LIMIT} when non-finite or non-positive, and retains native timeline slicing and legacy-row normalization.` }]
  }, handler: async input => {
    const roleId = sanitizeRoleId(input.path.roleId);
    if (!roleId) return { status: 400, body: errorResponsePresentation({ code: -1, message: "Missing role id." }, 400) };
    const raw = Number(input.url.searchParams.get("limit") || String(ROLE_PANEL_DEFAULT_READ_LIMIT));
    try { const messages = await owner.readMessages(roleId, Number.isFinite(raw) && raw > 0 ? raw : ROLE_PANEL_DEFAULT_READ_LIMIT, input.signal);
      return { status: 200, body: { code: 0, roleId, messages: messages.map(projectMessage) } }; }
    catch (error) { return { status: 503, body: errorResponsePresentation({ code: -1, message: error instanceof Error ? error.message : "Role panel timeline is unavailable." }, 503) }; }
  } }, { contract: {
    operationId: "manager.role-panel.messages.send", contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/role-panel/messages", exposure: "public", transport: "http",
    description: "Use the original local-persona role-panel delivery owner. Omitted gatewayId retains the existing first-configured-gateway selection; every new request creates a new message ID.",
    request: { path: empty, query: { type: "object" }, headers: { type: "object" }, body: { kind: "json", maxBytes: 0, allowAnyContentType: true, emptyValue: {},
      schema: { type: "object", properties: { gatewayId: true, text: true, attachments: true }, additionalProperties: true } } },
    responses: { "202": { mediaType: "application/json", schema: { type: "object", required: ["code", "status", "roleId", "messageId", "timelineRecorded", "replyContext"], additionalProperties: false, properties: {
      code: { const: 0 }, status: { const: "delivered" }, roleId: { type: "string" }, messageId: { type: "string" }, timelineRecorded: { type: "boolean" }, message: rolePanelMessageSchema, replyContext: { type: "object", additionalProperties: true }
    } } }, "400": { mediaType: "application/json", schema: sendErrorSchema(false) }, "502": { mediaType: "application/json", schema: sendErrorSchema(true) } },
    effects: { mode: "agent-delivery", description: "Dispatches through the original local Agent delivery child and records the original route's timeline. Handler acceptance is separate from completion of the Agent's business task." },
    recovery: { strategy: "inspect-original-request-no-replay", receiptPath: "/api/roles/:roleId/role-panel/messages", description: "There is no request-level idempotency. Preserve returned messageId/replyContext and inspect the original timeline. Timeout, failure, a missing row or timelineRecorded=false must not trigger automatic resubmission; accepted delivery is never retried to repair an audit failure." },
    validators: [
      { id: "role-panel-target-and-payload", description: "Retain native gateway sanitization and first-entry fallback, local-persona object ownership, String(text || '').trim(), and attachment normalization. At least text or one normalized attachment is required. Capture the original timeline owner before dispatch." },
      { id: "role-panel-child-and-audit", description: `The original child budget is ${LOCAL_AGENT_MESSAGE_TIMEOUT_MS}ms after spawn. Cancellation requests termination, then waits for actual process/stdio close and accepted log callbacks; audit completion remains owned after HTTP disconnect. Original route identity is retained across awaits.` }
    ]
  }, handler: async input => {
    try {
      const body = input.body as Record<string, unknown>, gatewayId = sanitizeRoleId(body.gatewayId), runtimes = owner.runtimes();
      const runtime = gatewayId ? runtimes.get(gatewayId) : runtimes.values()[Symbol.iterator]().next().value;
      if (!runtime) throw new Error(gatewayId ? `Gateway not found: ${gatewayId}` : "No gateway is configured.");
      owner.assertLocalOwner(runtime);
      const text = String(body.text || "").trim(), attachments = normalizeRolePanelAttachments(body.attachments);
      if (!text && attachments.length === 0) throw new Error("Missing role panel message text or attachment.");
      let appendTimeline: RolePanelDeliveryOptions["appendTimeline"];
      try { appendTimeline = owner.timelineAppender(); }
      catch (error) { appendTimeline = async () => { throw error; }; }
      const result = await deliverRolePanelMessage({ runtime, roleId: owner.roleId(runtime), sender: "本地用户", text, attachments,
        messageIdPrefix: "role-panel-user", deliver: owner.deliver, appendTimeline });
      return { status: 202, body: { code: 0, ...result, ...(result.message ? { message: projectMessage(result.message) } : {}) } };
    } catch (error) {
      const delivery = error instanceof RolePanelDeliveryError;
      const status = delivery ? error.statusCode : 400;
      return { status, body: errorResponsePresentation({ code: -1, status: "failed", message: error instanceof Error ? error.message : String(error),
        commitState: delivery ? "uncertain" : "not_started", ...(delivery ? { uncertain: true, messageId: error.messageId, replyContext: error.replyContext } : {}) }, status) };
    }
  } }];
}
