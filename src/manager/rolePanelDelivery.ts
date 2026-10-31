import {
  createRolePanelMessageId,
  type RolePanelAttachment,
  type RolePanelTimelineAppendResult,
  type RolePanelTimelineMessage
} from "../rolePanelTimeline.js";
import {
  ROLE_PANEL_ADAPTER_TYPE,
  ROLE_PANEL_ROUTE_KIND,
  ROLE_PANEL_TARGET_TYPE
} from "../shared/rolePanelMessage.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";

export type RolePanelDelivery = (
  runtime: GatewayRuntime,
  messageId: string,
  text: string,
  attachments: RolePanelAttachment[],
  replyContext: Record<string, unknown>
) => Promise<void>;

export type RolePanelDeliveryOptions = {
  runtime: GatewayRuntime;
  roleId: string;
  sender: string;
  text: string;
  attachments: RolePanelAttachment[];
  messageIdPrefix: string;
  replyContext?: Record<string, unknown>;
  deliver: RolePanelDelivery;
  appendTimeline: (
    roleId: string,
    message: RolePanelTimelineMessage
  ) => Promise<RolePanelTimelineAppendResult>;
};

export type RolePanelDeliveryResult = {
  status: "delivered";
  roleId: string;
  messageId: string;
  timelineRecorded: boolean;
  message?: RolePanelTimelineMessage;
  replyContext: Record<string, unknown>;
};

export class RolePanelDeliveryError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly messageId: string,
    readonly replyContext: Record<string, unknown>
  ) {
    super(message);
  }
}

function timelineMessage(
  options: RolePanelDeliveryOptions,
  messageId: string,
  replyContext: Record<string, unknown>,
  status: "sent" | "failed",
  route: Readonly<{ gatewayId: string; routeProfileId: string }>
): RolePanelTimelineMessage {
  return {
    id: messageId,
    time: Math.floor(Date.now() / 1000),
    roleId: options.roleId,
    gatewayId: route.gatewayId,
    routeProfileId: route.routeProfileId,
    direction: "user",
    sender: options.sender,
    text: options.text,
    attachments: options.attachments,
    status,
    replyContext
  };
}

export async function deliverRolePanelMessage(options: RolePanelDeliveryOptions): Promise<RolePanelDeliveryResult> {
  const messageId = createRolePanelMessageId(options.messageIdPrefix);
  const routeProfileId = options.runtime.definition.routeProfiles?.[0]?.id ?? options.runtime.definition.id;
  const route = Object.freeze({ gatewayId: options.runtime.definition.id, routeProfileId });
  const replyContext: Record<string, unknown> = {
    ...options.replyContext,
    runtimeRouteId: route.gatewayId,
    gatewayId: route.gatewayId,
    routeProfileId,
    routeKind: ROLE_PANEL_ROUTE_KIND,
    targetType: ROLE_PANEL_TARGET_TYPE,
    adapterType: ROLE_PANEL_ADAPTER_TYPE,
    messageId,
    roleId: options.roleId
  };

  try {
    await options.deliver(options.runtime, messageId, options.text, options.attachments, replyContext);
  } catch (error) {
    try {
      await options.appendTimeline(options.roleId, timelineMessage(options, messageId, replyContext, "failed", route));
    } catch {
      // The handler failure remains authoritative when the audit timeline is unavailable.
    }
    throw new RolePanelDeliveryError(
      502,
      error instanceof Error ? error.message : String(error),
      messageId,
      replyContext
    );
  }

  let message: RolePanelTimelineMessage | undefined;
  try {
    message = (await options.appendTimeline(
      options.roleId,
      timelineMessage(options, messageId, replyContext, "sent", route)
    )).message;
  } catch {
    // The handler already accepted the turn. A timeline failure must not invite a duplicate retry.
  }
  return {
    status: "delivered",
    roleId: options.roleId,
    messageId,
    timelineRecorded: Boolean(message),
    message,
    replyContext
  };
}
