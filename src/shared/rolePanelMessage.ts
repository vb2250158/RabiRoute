export const ROLE_PANEL_ROUTE_KIND = "role_panel_message" as const;
export const ROLE_PANEL_TARGET_TYPE = "role_panel" as const;
export const ROLE_PANEL_ADAPTER_TYPE = "rolePanel" as const;

export type PersonaMessageReplyContext = {
  crossPersona: true;
  sourcePersonaId: string;
  sourcePersonaName: string;
  sourceRouteId: string;
  targetPersonaId: string;
  targetRouteId: string;
  personaConversationId: string;
  inReplyToPersonaMessageId?: string;
  personaMessageHopCount: number;
  personaMessageMaxHops: number;
};

export function isPersonaMessageReplyContext(value: unknown): value is PersonaMessageReplyContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return context.crossPersona === true
    && typeof context.sourcePersonaId === "string"
    && typeof context.sourceRouteId === "string"
    && typeof context.targetPersonaId === "string"
    && typeof context.targetRouteId === "string"
    && typeof context.personaConversationId === "string"
    && Number.isInteger(context.personaMessageHopCount);
}

export function personaMessageSenderName(value: unknown): string {
  if (!isPersonaMessageReplyContext(value)) return "本地用户";
  return String(value.sourcePersonaName || value.sourcePersonaId || "其它人格");
}
