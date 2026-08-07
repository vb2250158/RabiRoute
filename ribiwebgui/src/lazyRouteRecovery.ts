import { WEBGUI_TOKEN_QUERY_KEY } from "./webguiAccessToken";

const LAZY_ROUTE_RECOVERY_KEY = "rabiroute:webgui:lazy-route-recovery";
const LAZY_ROUTE_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /loading (?:css )?chunk [^ ]+ failed/i,
  /chunkloaderror/i,
  /vite:preloaderror/i
];

type RecoveryLocation = {
  href: string;
  reload: () => void;
  replace: (value: string) => void;
};

type RecoveryStorage = {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
};

export type LazyRouteRecoveryHost = {
  location: RecoveryLocation;
  sessionStorage: RecoveryStorage;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message || "");
  return String(error || "");
}

export function isLazyRouteLoadError(error: unknown): boolean {
  const message = errorMessage(error);
  return LAZY_ROUTE_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

export function lazyRouteRecoveryUrl(currentHref: string, targetFullPath = ""): string {
  if (!targetFullPath.trim()) return currentHref;
  const target = new URL(currentHref);
  const currentHash = target.hash.startsWith("#") ? target.hash.slice(1) : target.hash;
  const currentQueryIndex = currentHash.indexOf("?");
  const currentQuery = new URLSearchParams(currentQueryIndex >= 0 ? currentHash.slice(currentQueryIndex + 1) : "");
  const requested = targetFullPath.startsWith("#") ? targetFullPath.slice(1) : targetFullPath;
  const requestedQueryIndex = requested.indexOf("?");
  const requestedPath = requestedQueryIndex >= 0 ? requested.slice(0, requestedQueryIndex) : requested;
  const requestedQuery = new URLSearchParams(requestedQueryIndex >= 0 ? requested.slice(requestedQueryIndex + 1) : "");
  const accessToken = currentQuery.get(WEBGUI_TOKEN_QUERY_KEY)?.trim() || "";
  if (accessToken && !requestedQuery.has(WEBGUI_TOKEN_QUERY_KEY)) {
    requestedQuery.set(WEBGUI_TOKEN_QUERY_KEY, accessToken);
  }
  const query = requestedQuery.toString();
  target.hash = `#${requestedPath}${query ? `?${query}` : ""}`;
  return target.toString();
}

export function createLazyRouteRecovery(host: LazyRouteRecoveryHost = window): {
  recover: (error: unknown, targetFullPath?: string) => boolean;
  markReady: () => void;
  dispose: () => void;
} {
  const attemptedUrls = new Set<string>();

  function storedAttempt(): string {
    try {
      return host.sessionStorage.getItem(LAZY_ROUTE_RECOVERY_KEY) || "";
    } catch {
      return "";
    }
  }

  function rememberAttempt(url: string): void {
    attemptedUrls.add(url);
    try {
      host.sessionStorage.setItem(LAZY_ROUTE_RECOVERY_KEY, url);
    } catch {
      // The in-memory guard still prevents a reload loop when storage is unavailable.
    }
  }

  function clearAttempt(): void {
    attemptedUrls.clear();
    try {
      host.sessionStorage.removeItem(LAZY_ROUTE_RECOVERY_KEY);
    } catch {
      // A successful page remains usable even when storage cleanup is unavailable.
    }
  }

  function canRecover(error: unknown, targetFullPath = ""): boolean {
    if (!isLazyRouteLoadError(error)) return false;
    const recoveryUrl = lazyRouteRecoveryUrl(host.location.href, targetFullPath);
    return !attemptedUrls.has(recoveryUrl) && storedAttempt() !== recoveryUrl;
  }

  function recover(error: unknown, targetFullPath = ""): boolean {
    if (!canRecover(error, targetFullPath)) return false;
    const recoveryUrl = lazyRouteRecoveryUrl(host.location.href, targetFullPath);
    rememberAttempt(recoveryUrl);
    if (recoveryUrl !== host.location.href) host.location.replace(recoveryUrl);
    host.location.reload();
    return true;
  }

  return {
    recover,
    markReady: clearAttempt,
    dispose: () => undefined
  };
}
