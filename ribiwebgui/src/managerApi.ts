declare global {
  interface Window {
    __RABI_MANAGER_API_BASE__?: string;
    __RABI_MANAGER_FETCH_INSTALLED__?: boolean;
  }
}

const managerPathPrefixes = [
  "/api/",
  "/manager-config",
  "/meta",
  "/gateways",
  "/network-options",
  "/open-config-file",
  "/manager",
  "/manager/"
];

function normalizedManagerApiBase(): string {
  return String(window.__RABI_MANAGER_API_BASE__ || "").replace(/\/+$/, "");
}

function shouldPrefixManagerPath(pathname: string): boolean {
  if (!pathname.startsWith("/")) return false;
  if (pathname.startsWith("/plugin/")) return false;
  return managerPathPrefixes.some(prefix => pathname === prefix || pathname.startsWith(prefix));
}

function prefixedManagerUrl(value: string): string {
  const base = normalizedManagerApiBase();
  if (!base || !value.startsWith("/")) return value;
  if (!shouldPrefixManagerPath(value)) return value;
  return `${base}${value}`;
}

export function installManagerFetchPrefix(): void {
  if (window.__RABI_MANAGER_FETCH_INSTALLED__) return;
  window.__RABI_MANAGER_FETCH_INSTALLED__ = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === "string") {
      return originalFetch(prefixedManagerUrl(input), init);
    }
    if (input instanceof URL && input.origin === window.location.origin) {
      const next = new URL(input.toString());
      next.pathname = prefixedManagerUrl(next.pathname);
      return originalFetch(next, init);
    }
    if (input instanceof Request) {
      const requestUrl = new URL(input.url);
      if (requestUrl.origin === window.location.origin) {
        const next = new URL(input.url);
        next.pathname = prefixedManagerUrl(next.pathname);
        return originalFetch(new Request(next, input), init);
      }
    }
    return originalFetch(input, init);
  };
}

export {};
