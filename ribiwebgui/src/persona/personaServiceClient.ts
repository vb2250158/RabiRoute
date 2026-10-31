import { inject, provide, type InjectionKey } from "vue";
import { managerEventSource, managerResourceUrl } from "../managerApi";
import { remotePersonaServicePath } from "./remotePersonaReference";

/** Source identity belongs to the mounted persona editor, including its async work. */
export function createPersonaService(deviceId = "", fetchImpl: typeof fetch = (...args) => fetch(...args)) {
  const path = (url: string): string => deviceId && (url === "/meta" || url.startsWith("/api/")) && !url.startsWith("/api/rabilink/peer/")
    ? remotePersonaServicePath(deviceId, url) : url;
  const scopedFetch: typeof fetch = (input, init) => {
    if (typeof input === "string") return fetchImpl(path(input), init);
    if (!deviceId) return fetchImpl(input, init);
    const url = new URL(input instanceof URL ? input.href : input.url);
    if (url.origin !== window.location.origin) return fetchImpl(input, init);
    const target = path(url.pathname + url.search);
    return fetchImpl(input instanceof Request ? new Request(new URL(target, window.location.href), input) : target, init);
  };
  return { deviceId, path, fetch: scopedFetch,
    events: (url: string) => managerEventSource(path(url)),
    resource: (url: string) => managerResourceUrl(path(url)),
    cacheKey: (roleId: string) => deviceId ? `${deviceId}:${roleId}` : roleId
  };
}

const personaServiceKey: InjectionKey<ReturnType<typeof createPersonaService>> = Symbol("persona-service");
export function providePersonaService(deviceId: string) {
  const service = createPersonaService(deviceId);
  provide(personaServiceKey, service);
  return service;
}
export function usePersonaService() { return inject(personaServiceKey, undefined) ?? createPersonaService(); }
