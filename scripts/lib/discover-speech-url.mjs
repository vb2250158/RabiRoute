import { discoverManagerIdentity } from "./discover-manager-url.mjs";

function serviceUrl(value, published = false) {
  const url = new URL(String(value).trim());
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.port === "0" || url.search || url.hash || (published && !["127.0.0.1", "localhost", "::1"].includes(host))) {
    throw new Error("RabiSpeech requires an HTTP(S) service URL without credentials; discovered services must be local.");
  }
  return url.toString().replace(/\/$/, "");
}

/** Resolve the current Speech owner through an identity-verified Manager, never a port guess. */
export async function discoverSpeechServiceUrl(options = {}) {
  if (options.explicit?.trim()) return serviceUrl(options.explicit);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const discover = options.discoverManagerIdentity ?? discoverManagerIdentity;
  const identity = await discover({ explicit: options.managerUrl, fetch: fetchImpl });
  const response = await fetchImpl(`${identity.managerBaseUrl}/api/speech/status`, {
    redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 5000)
  });
  if (!response.ok) throw new Error(`RabiSpeech owner query failed (HTTP ${response.status}).`);
  const body = await response.json();
  if (body?.code !== 0 || body.data?.state !== "online" || !body.data.configuredUrl) {
    throw new Error("RabiSpeech has no online service address; start it in Rabi or provide an explicit service URL.");
  }
  const url = serviceUrl(body.data.configuredUrl, true);
  const current = await discover({ explicit: identity.managerBaseUrl, fetch: fetchImpl });
  if (current.managerBaseUrl !== identity.managerBaseUrl
    || current.applicationGenerationId !== identity.applicationGenerationId
    || current.managerInstanceId !== identity.managerInstanceId) {
    throw new Error("Manager identity changed while resolving RabiSpeech; retry discovery.");
  }
  return url;
}
