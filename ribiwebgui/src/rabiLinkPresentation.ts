import type { MetaPayload } from "./types";
import { rabiLinkModelScope, rabiLinkModelServices } from "@shared/rabiLinkModelServices";

export type RabiLinkTab = "home" | "agents" | "computer" | "config";
export function rabiLinkTab(value: unknown): RabiLinkTab {
  return value === "agents" || value === "computer" || value === "config" ? value : "home";
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
    provideModelServices: relay?.provideModelServices !== false,
    modelScope: rabiLinkModelScope(relay?.modelScope),
    url: relay?.url || "",
    token: "",
    deviceId: relay?.deviceId || meta.computerName || "",
    claimWaitMs: relay?.claimWaitMs ?? 60000,
    replyIdleTimeoutMs: relay?.replyIdleTimeoutMs ?? 60000,
    speechServiceUrl: relay?.speechServiceUrl || "",
    speechServiceMode: relay?.speechServiceMode ?? (relay?.speechServiceUrl && relay.speechServiceUrl.replace(/\/+$/, "") !== "http://127.0.0.1:8781" ? "configured" : "managed") as "managed" | "configured"
  };
}

export function rabiLinkIdentityPatch(draft: RabiLinkDraft, baseline?: RabiLinkDraft) {
  const { rabiName, maxFileMiB, token, ...relay } = draft;
  const changedServices = rabiLinkModelServices.filter(id => relay.modelScope[id] !== baseline?.modelScope[id]);
  return {
    rabiName: baseline?.rabiName === rabiName ? undefined : rabiName,
    agentUploads: baseline?.maxFileMiB === maxFileMiB ? undefined : { maxFileMiB: Number(maxFileMiB) },
    rabiLinkRelay: {
      enabled: baseline?.enabled === relay.enabled ? undefined : relay.enabled,
      url: baseline?.url === relay.url ? undefined : relay.url,
      deviceId: baseline?.deviceId === relay.deviceId ? undefined : relay.deviceId,
      provideModelServices: baseline?.provideModelServices === relay.provideModelServices ? undefined : relay.provideModelServices,
      ...(changedServices.length ? { modelScope: Object.fromEntries(changedServices.map(id => [id, relay.modelScope[id]])) } : {}),
      claimWaitMs: baseline?.claimWaitMs === relay.claimWaitMs ? undefined : Number(relay.claimWaitMs),
      replyIdleTimeoutMs: baseline?.replyIdleTimeoutMs === relay.replyIdleTimeoutMs ? undefined : Number(relay.replyIdleTimeoutMs),
      speechServiceUrl: baseline?.speechServiceUrl === relay.speechServiceUrl ? undefined : relay.speechServiceUrl,
      speechServiceMode: baseline?.speechServiceMode === relay.speechServiceMode && baseline?.speechServiceUrl === relay.speechServiceUrl ? undefined : relay.speechServiceMode,
      ...(token.trim() ? { token: token.trim() } : {})
    }
  };
}

export async function saveRabiLinkIdentity(meta: MetaPayload, patch: object) {
  const response = await fetch("/api/rabi/identity", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0 || !body.data) throw new Error(body.message || "保存失败");
  const { token: _token, ...relay } = body.data.rabiLinkRelay || {};
  meta.rabiName = body.data.rabiName;
  meta.rabiGuid = body.data.rabiGuid;
  meta.agentUploads = body.data.agentUploads;
  meta.rabiLinkRelay = relay;
}
