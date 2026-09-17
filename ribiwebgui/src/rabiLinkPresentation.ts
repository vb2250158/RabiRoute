import type { MetaPayload } from "./types";

export type RabiLinkTab = "home" | "agents" | "config";
export function rabiLinkTab(value: unknown): RabiLinkTab {
  return value === "agents" || value === "config" ? value : "home";
}

/** The Relay management page lives at /manage on the configured server origin.
 * Never carry credentials, query strings or fragments into a browser navigation. */
export function rabiLinkManagementUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return "";
    return new URL("/manage", url.origin).href;
  } catch { return ""; }
}

export type RabiLinkDraft = ReturnType<typeof rabiLinkDraftFromMeta>;
export function rabiLinkDraftFromMeta(meta: MetaPayload) {
  const relay = meta.rabiLinkRelay;
  return {
    rabiName: meta.rabiName || meta.computerName || "",
    maxFileMiB: meta.agentUploads?.maxFileMiB ?? 2048,
    enabled: relay?.enabled === true,
    url: relay?.url || "",
    token: "",
    deviceId: relay?.deviceId || meta.computerName || "",
    claimWaitMs: relay?.claimWaitMs ?? 60000,
    replyIdleTimeoutMs: relay?.replyIdleTimeoutMs ?? 60000,
    speechProxyEnabled: relay?.speechProxyEnabled === true,
    speechServiceUrl: relay?.speechServiceUrl || ""
  };
}

export function rabiLinkIdentityPatch(draft: RabiLinkDraft) {
  const { rabiName, maxFileMiB, token, ...relay } = draft;
  return {
    rabiName,
    agentUploads: { maxFileMiB: Number(maxFileMiB) },
    rabiLinkRelay: {
      ...relay,
      claimWaitMs: Number(relay.claimWaitMs),
      replyIdleTimeoutMs: Number(relay.replyIdleTimeoutMs),
      ...(token.trim() ? { token: token.trim() } : {})
    }
  };
}
