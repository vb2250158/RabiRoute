import type { RabiLinkRelayGlobalConfig } from "../manager/globalConfig.js";

export function publicRabiLinkRelayConfig(config: RabiLinkRelayGlobalConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    url: config.url,
    deviceId: config.deviceId,
    claimWaitMs: config.claimWaitMs,
    replyIdleTimeoutMs: config.replyIdleTimeoutMs,
    speechServiceUrl: config.speechServiceUrl,
    ...(config.speechServiceMode ? { speechServiceMode: config.speechServiceMode } : {}),
    tokenConfigured: Boolean(config.token)
  };
}
