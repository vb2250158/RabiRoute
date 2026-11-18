import type { PersonaAutomationRuleDefinition } from "../../../../../ribiwebgui/src/types";
import { MESSAGE_EVENT_CATEGORIES, RECORDING_CAPTURE_TYPES } from "../../../../shared/personaEventTypes";

// Shared by the rule list and editor so every category has the same meaning.
export const automationEndpoints: Array<{ value: string; title: string; english: string; icon: string; routeKinds: string[] }> = [
  ...MESSAGE_EVENT_CATEGORIES.map(category => ({ ...category, routeKinds: [...category.routeKinds] })),
  ...RECORDING_CAPTURE_TYPES.map(type => ({ ...type, routeKinds: [type.routeKind] }))
];

export function automationEndpoint(rule: PersonaAutomationRuleDefinition): string {
  if (rule.trigger.type === "schedule") return "schedule";
  const kinds = rule.trigger.routeKinds ?? [];
  const endpointType = "endpointType" in rule.trigger ? rule.trigger.endpointType : undefined;
  // Persisted rules keep their filters; only the retired display category is mapped.
  const currentEndpointType = endpointType === "fennenote" ? "speech" : endpointType;
  const explicit = automationEndpoints.find(option => option.value === currentEndpointType);
  // Empty kinds match all messages, including legacy rules without an endpoint.
  if (explicit && explicit.value !== "schedule"
    && (explicit.routeKinds.length === 0 || kinds.some(kind => explicit.routeKinds.includes(kind)))) return explicit.value;
  return automationEndpoints.find(option => option.value !== "schedule"
    && option.routeKinds.some(kind => kinds.includes(kind)))?.value ?? "webhook";
}
