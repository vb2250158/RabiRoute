import type { SpeechMessageCommand } from "../shared/speechControlContract.js";

export type HostSpeechIdentity = {
  rabiGuid: string;
  rabiName?: string;
  fallbackHostName: string;
};

export function hostOwnedSpeechMessageCommand(
  body: SpeechMessageCommand & { gatewayId?: string },
  host: HostSpeechIdentity
): SpeechMessageCommand {
  return {
    ...body,
    routeId: body.routeId || body.gatewayId || null,
    sourceHostId: String(host.rabiGuid || "").trim(),
    sourceHostName: String(host.rabiName || host.fallbackHostName || "").trim()
  };
}
