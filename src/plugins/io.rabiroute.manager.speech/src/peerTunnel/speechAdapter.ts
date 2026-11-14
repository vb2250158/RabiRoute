import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import type { ManagerSpeechLocalAdapter } from "../manager/speechControl.js";
import { inspectLocalSpeechService } from "../manager/speechServiceStatus.js";
import { requestLocalSpeech, type LocalSpeechResponse } from "@rabiroute/host-api/speech/localSpeechClient";
import type { PeerTunnelRuntime } from "@rabiroute/host-api/peerTunnel/runtime";

// Device I/O and the host FIFO retain their local owner; compute uses the selected service.
export function speechUsesLocalDevice(pathname: string): boolean {
  return ["/v1/microphone", "/v1/playback", "/v1/audio-streams"].some(prefix => pathname === prefix || pathname.startsWith(prefix + "/") || pathname.startsWith(prefix + "?"));
}
export function createPeerSpeechAdapter(runtime: () => Pick<PeerTunnelRuntime, "selected" | "fetch"> | undefined, targetOverride: () => string | undefined = () => undefined, localServiceUrl?: () => string): ManagerSpeechLocalAdapter {
  const binary = async (serviceUrl: string, pathname: string, init: RequestInit = {}, timeoutMs = getTimeoutMs("backend.peerTunnel.speechAdapter.binary.timeoutMs", 190_000)): Promise<LocalSpeechResponse> => {
    const tunnel = runtime(); const selected = targetOverride() ?? (tunnel?.selected() || "");
    if (!selected || speechUsesLocalDevice(pathname)) return requestLocalSpeech(localServiceUrl?.() ?? serviceUrl, pathname, init, { timeoutMs });
    let playback = false;
    let model = "", voice = "", text = "";
    if (pathname === "/v1/audio/speech" && typeof init.body === "string") {
      const payload = JSON.parse(init.body); playback = payload.play === true; model = String(payload.model || ""); voice = String(payload.voice || ""); text = String(payload.input || "");
      init = { ...init, body: JSON.stringify({ ...payload, play: false }) };
    }
    const response = await requestLocalSpeech("https://rabispeech-peer.invalid", pathname, init, { timeoutMs,
      fetchImpl: (url, options) => tunnel!.fetch(selected, "speech", new URL(String(url)).pathname + new URL(String(url)).search, options) });
    if (playback && response.status >= 200 && response.status < 300) {
      const form = new FormData(); form.append("file", new Blob([new Uint8Array(response.body)], { type: response.contentType }), "remote.wav");
      form.append("model", model); form.append("voice", voice);
      form.append("text", text.slice(0, 4000));
      const queued = await requestLocalSpeech(localServiceUrl?.() ?? serviceUrl, "/v1/playback/audio", { method: "POST", body: form }, { timeoutMs: getTimeoutMs("backend.peerTunnel.speechAdapter.binary.requestLocalSpeech.timeoutMs", 15_000) });
      if (queued.status < 200 || queued.status >= 300) throw new Error("远端已合成，但本机播放队列未接受音频；不会重新合成。");
      const job = JSON.parse(queued.body.toString());
      response.headers["x-rabispeech-playback-job"] = String(job.id);
    }
    return response;
  };
  return {
    inspect: async serviceUrl => {
      const tunnel = runtime(); const selected = targetOverride() ?? (tunnel?.selected() || "");
      if (!selected) return inspectLocalSpeechService(localServiceUrl?.() ?? serviceUrl);
      // This URI is only a path-construction base; the injected transport always calls the selected peer.
      const status = await inspectLocalSpeechService("https://rabispeech-peer.invalid", { fetchImpl: (url, init) => tunnel!.fetch(selected, "speech", new URL(String(url)).pathname, init) });
      return { ...status, configuredUrl: "peer:" + selected };
    },
    requestBinary: binary,
    requestJson: async (serviceUrl, pathname, init, timeoutMs) => {
      const result = await binary(serviceUrl, pathname, init, timeoutMs);
      return { status: result.status, data: JSON.parse(result.body.toString() || "{}") as Record<string, unknown> };
    }
  };
}
