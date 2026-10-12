export class MediaServiceChangedError extends Error {
  constructor() { super("服务电脑已切换，旧响应已忽略。"); }
}

export function createMediaServiceClient(target: () => string, fetchImpl: typeof fetch = (...args) => fetch(...args)) {
  let revision = 0;
  async function fetchManager(pathname: string, init?: RequestInit): Promise<Response> {
    const deviceId = target();
    const expectedRevision = revision;
    const compute = pathname === "/api/speech/models" || pathname === "/api/speech/tts";
    const suffix = compute ? `?computeDeviceId=${encodeURIComponent(deviceId)}` : "";
    const response = await fetchImpl(pathname + suffix, init);
    if (deviceId !== target() || expectedRevision !== revision) throw new MediaServiceChangedError();
    return new Proxy(response, {get(object,key) {
      const value = Reflect.get(object,key,object);
      if (typeof value !== "function") return value;
      if (["json","text","blob","arrayBuffer"].includes(String(key))) return async (...args: unknown[]) => {
        const body = await value.apply(object,args);
        if (deviceId !== target() || expectedRevision !== revision) throw new MediaServiceChangedError();
        return body;
      };
      return value.bind(object);
    }});
  }
  return {
    invalidate() { revision++; },
    selectionRevision() { return revision; },
    fetchManager,
    async request<T>(route: string, init?: RequestInit): Promise<T> {
      const pathname = route.split("?")[0];
      const method = (init?.method || "GET").toUpperCase();
      const compute = pathname === "/status" || pathname.startsWith("/models") || pathname.startsWith("/runtime/") || (method === "POST" && ["/jobs", "/assets"].includes(pathname));
      const deviceId = target(), expectedRevision = revision;
      const suffix = compute && deviceId ? `${route.includes("?") ? "&" : "?"}computeDeviceId=${encodeURIComponent(deviceId)}` : "";
      // Workspace requests stay local; the backend invokes peer compute.
      const response = await fetchImpl(`/api/video${route}${suffix}`, init);
      let body: T & { message?: string; error?: string };
      try { body = await response.json(); }
      catch { throw new Error(`服务电脑未提供此媒体接口（HTTP ${response.status}）。`); }
      if (compute && (deviceId !== target() || expectedRevision !== revision)) throw new MediaServiceChangedError();
      if (!response.ok) throw new Error(body.message || body.error || `媒体服务请求失败（HTTP ${response.status}）。`);
      return body;
    }
  };
}
