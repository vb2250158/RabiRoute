import type { RabiLinkHomeDevice } from "../../../../../ribiwebgui/src/rabiLinkHomeClient";

/** A RabiLink phone as the device list needs it: identity plus a display name. */
export type PhoneDevice = RabiLinkHomeDevice & { displayName: string };

/** Retain saved phone links from the former computer/phone tab layout. */
export function phoneDeepLink(query: Record<string, unknown>): string {
  if (typeof query.phoneId === "string") return query.phoneId;
  return query.deviceType === "phone" && typeof query.deviceId === "string" ? query.deviceId : "";
}
