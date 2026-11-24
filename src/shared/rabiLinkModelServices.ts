export const rabiLinkModelServices = ["tts", "asr", "workbench"] as const;
export type RabiLinkModelService = typeof rabiLinkModelServices[number];
export type RabiLinkModelScope = Record<RabiLinkModelService, boolean>;
export type RabiLinkModelSettings = {
  provideModelServices?: boolean;
  modelScope?: Partial<RabiLinkModelScope>;
};

export function rabiLinkModelScope(scope?: Partial<RabiLinkModelScope>): RabiLinkModelScope {
  return { tts: scope?.tts !== false, asr: scope?.asr !== false, workbench: scope?.workbench !== false };
}

export function providesRabiLinkModel(settings: RabiLinkModelSettings, service: RabiLinkModelService): boolean {
  return settings.provideModelServices !== false && settings.modelScope?.[service] !== false;
}

export function rabiLinkSpeechModelRequest(path: string): "tts" | "asr" | "catalog" | undefined {
  let pathname = new URL(path, "http://localhost").pathname;
  try { pathname = decodeURIComponent(pathname).replace(/\/+$/, ""); }
  catch { return; }
  if (["/v1/audio/speech", "/api/speech/tts"].includes(pathname)) return "tts";
  if (["/v1/audio/transcriptions", "/v1/archive/transcriptions", "/v1/audio-streams/rabilink/start", "/api/speech/asr"].includes(pathname)) return "asr";
  if (["/v1/capabilities", "/api/speech/models", "/v1/models"].includes(pathname) || pathname.startsWith("/v1/models/")) return "catalog";
}

export function allowsRabiLinkSpeechModelRequest(settings: RabiLinkModelSettings, path: string): boolean {
  const service = rabiLinkSpeechModelRequest(path);
  if (service === "catalog") return providesRabiLinkModel(settings, "tts") || providesRabiLinkModel(settings, "asr");
  return !service || providesRabiLinkModel(settings, service);
}

export function isNewRabiLinkWorkbenchModelRequest(pathname: string, method: string): boolean {
  const route = pathname.replace(/\/+$/, "");
  return route.startsWith("/api/video/models/")
    || route === "/api/video/models"
    || route.startsWith("/api/video/compute/runtime/")
    || ["/api/video/compute/status", "/api/video/compute/events"].includes(route)
    || (method === "POST" && ["/api/video/compute/jobs", "/api/video/compute/assets"].includes(route));
}
