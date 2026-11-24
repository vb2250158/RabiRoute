import type { RabiLinkRelayGlobalConfig } from "../manager/globalConfig.js";
import { rabiLinkModelScope } from "./rabiLinkModelServices.js";

export function publicRabiLinkRelayConfig(config: RabiLinkRelayGlobalConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    url: config.url,
    deviceId: config.deviceId,
    claimWaitMs: config.claimWaitMs,
    replyIdleTimeoutMs: config.replyIdleTimeoutMs,
    speechServiceUrl: config.speechServiceUrl,
    provideModelServices: config.provideModelServices !== false,
    modelScope: rabiLinkModelScope(config.modelScope),
    ...(config.speechServiceMode ? { speechServiceMode: config.speechServiceMode } : {}),
    tokenConfigured: Boolean(config.token)
  };
}
