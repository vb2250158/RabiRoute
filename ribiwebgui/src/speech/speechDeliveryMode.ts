import type { SpeechPushMode } from "@shared/gatewayConfigModel";

export const SPEECH_ROUTE_AUTO_SUBMIT = true;

export function speechPushModeForHotDelivery(enabled: boolean): SpeechPushMode {
  return enabled ? "hot" : "keyword";
}

export function hotDeliveryEnabled(mode: SpeechPushMode | undefined): boolean {
  return mode !== "keyword";
}
