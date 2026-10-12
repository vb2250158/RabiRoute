import type { OriginalQqFileBinding } from "./agentDeliveryVerification.js";

const bindingFields = ["routeProfileId", "instanceId", "groupId", "sentFileId", "selfId", "bindingRevision"] as const;
export type OriginalBindingMissingField = typeof bindingFields[number];
export type OriginalAgentSendBindingObservation = Readonly<
  | { state: "present"; binding: OriginalQqFileBinding }
  | { state: "missing"; missingFields: readonly OriginalBindingMissingField[] }
  | { state: "conflict" }
>;
const validText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
  && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

/** Only the original history owner's upload record can supply these fields.
 * The caller must first match its ORIGINAL deliveryId and internal request digest.
 * No nested request, current account, filename, or summary is a binding source. */
export function projectOriginalAgentSendBinding(
  data: Readonly<Record<string, unknown>>,
  expected: Readonly<{ deliveryId: string; deliveryRequestDigest: string; routeId: string; groupId: string; instanceId?: string }>
): OriginalAgentSendBindingObservation {
  if (data.deliveryId !== expected.deliveryId || data.deliveryRequestDigest !== expected.deliveryRequestDigest
    || data.ok !== true || data.status !== "sent") return { state: "conflict" };
  const missingFields = bindingFields.filter(field => data[field] === undefined || data[field] === null || data[field] === "");
  // Wrongly typed or contradictory fields are not missing evidence.
  if (bindingFields.some(field => !missingFields.includes(field) && !validText(data[field]))
    || (!missingFields.includes("routeProfileId") && data.routeProfileId !== expected.routeId)
    || (!missingFields.includes("groupId") && data.groupId !== expected.groupId)
    || (expected.instanceId && !missingFields.includes("instanceId") && data.instanceId !== expected.instanceId)
    || (!missingFields.includes("groupId") && !/^[1-9][0-9]{0,15}$/.test(String(data.groupId)))
    || (!missingFields.includes("selfId") && !/^[1-9][0-9]{0,15}$/.test(String(data.selfId)))
    || (data.folderId !== undefined && (typeof data.folderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(data.folderId)))) {
    return { state: "conflict" };
  }
  if (missingFields.length) return { state: "missing", missingFields };
  return { state: "present", binding: Object.freeze({
    routeId: data.routeProfileId as string, instanceId: data.instanceId as string, groupId: data.groupId as string,
    platformFileId: data.sentFileId as string, selfId: data.selfId as string, bindingRevision: data.bindingRevision as string,
    ...(data.folderId === undefined ? {} : { folderId: data.folderId as string })
  }) };
}

/** Whitelist missing field names again at the public diagnostic boundary. */
export function safeOriginalBindingMissingFields(value: readonly unknown[]): OriginalBindingMissingField[] {
  return bindingFields.filter(field => value.includes(field));
}
