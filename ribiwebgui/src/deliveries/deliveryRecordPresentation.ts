import { deliveryRecordCopy, deliveryStateLabels, type DeliveryRecordLocale } from "./deliveryRecordCopy";
import { agentInstanceDisplayName, type AgentInstance } from "@shared/agentInstance";

export function deliveryComputerOptions(instances: AgentInstance[], locale: DeliveryRecordLocale, selectedNodeId = "") {
  const copy = deliveryRecordCopy(locale);
  const options = [{ title: copy.hostComputer, value: "" }, ...instances.filter(instance => !instance.local).map(instance => ({
    title: `${agentInstanceDisplayName(instance)} · ${instance.connected ? copy.online : copy.offline}`, value: instance.instanceId
  }))];
  if (selectedNodeId && !options.some(option => option.value === selectedNodeId)) {
    options.push({ title: `${copy.selectedComputer} · ${selectedNodeId}`, value: selectedNodeId });
  }
  return options;
}

/** Labels describe the owner's state; HTTP status and reply policy are never delivery evidence. */
export function deliveryStatePresentation(state: string, locale: DeliveryRecordLocale) {
  const colors: Record<string, string> = { local_accepted: "info", queued: "info", sending: "info", awaiting_confirmation: "warning", received: "success", blocked: "warning", failed: "error", cancelled: "grey" };
  return { label: deliveryStateLabels[locale][state] || deliveryRecordCopy(locale).unknownState, color: colors[state] || "grey" };
}

export function deliveryEndpointLabel(endpoint: { kind?: string; instanceId?: string; nodeId?: string; provider?: string; sessionId?: string }, locale: DeliveryRecordLocale): string {
  return [endpoint.instanceId || endpoint.nodeId || endpoint.kind, endpoint.provider, endpoint.sessionId].filter(Boolean).join(" · ") || deliveryRecordCopy(locale).unknown;
}

export function deliveryTimeLabel(value: string | undefined, locale: DeliveryRecordLocale): string {
  if (!value) return deliveryRecordCopy(locale).unknown;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}
