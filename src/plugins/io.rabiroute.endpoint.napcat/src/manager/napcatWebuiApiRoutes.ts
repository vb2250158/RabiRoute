type ReadRoute = Readonly<{ id: string; title: string; upstreamPath: string; method: "GET" | "POST";
  kind?: "resource" | "log-events" | "system-events"; queryKeys?: readonly string[] }>;

/** Shared declarations for discovery and the credential-owning transport. */
export const napcatWebuiApiReadRoutes: Readonly<Record<string, ReadRoute>> = Object.freeze({
  mirrors: { id: "mirrors", title: "NapCat mirror origins", upstreamPath: "/api/base/getMirrors", method: "GET" },
  "file-hash": { id: "file-hash", title: "NapCat executable hash", upstreamPath: "/api/base/GetNapCatFileHash", method: "GET" },
  version: { id: "version", title: "NapCat version", upstreamPath: "/api/base/GetNapCatVersion", method: "GET" },
  "system-events": { id: "system-events", title: "NapCat system status sample", upstreamPath: "/api/base/GetSysStatusRealTime", method: "GET", kind: "system-events" },
  "qq-version": { id: "qq-version", title: "QQ version", upstreamPath: "/api/base/QQVersion", method: "GET" },
  theme: { id: "theme", title: "NapCat theme summary", upstreamPath: "/api/base/Theme", method: "GET" },
  schemas: { id: "schemas", title: "NapCat API schema directory summary", upstreamPath: "/api/Debug/schemas", method: "GET" },
  log: { id: "log", title: "NapCat log summary", upstreamPath: "/api/Log/GetLog", method: "GET", queryKeys: ["id"] },
  "log-files": { id: "log-files", title: "NapCat log identifiers", upstreamPath: "/api/Log/GetLogList", method: "GET" },
  "log-events": { id: "log-events", title: "NapCat log event summaries", upstreamPath: "/api/Log/GetLogRealTime", method: "GET", kind: "log-events" },
  "plugin-icon": { id: "plugin-icon", title: "NapCat plugin icon summary", upstreamPath: "/api/Plugin/Icon/:pluginId", method: "GET", kind: "resource" },
  plugins: { id: "plugins", title: "NapCat plugin directory", upstreamPath: "/api/Plugin/List", method: "GET" },
  "plugin-page": { id: "plugin-page", title: "NapCat registered plugin page summary", upstreamPath: "/api/Plugin/page/:pluginId/:pagePath", method: "GET", kind: "resource" },
  "store-plugin": { id: "store-plugin", title: "NapCat store plugin metadata", upstreamPath: "/api/Plugin/Store/Detail/:id", method: "GET" },
  "store-plugins": { id: "store-plugins", title: "NapCat store plugin directory", upstreamPath: "/api/Plugin/Store/List", method: "GET", queryKeys: ["forceRefresh"] },
  health: { id: "health", title: "NapCat WebUI authentication health", upstreamPath: "/api/test", method: "POST" },
  "ssl-status": { id: "ssl-status", title: "NapCat TLS certificate summary", upstreamPath: "/api/WebUIConfig/GetSSLStatus", method: "GET" },
});

export function assertNapcatWebuiFixedRead(method: string, pathname: string): void {
  const invalid = () => { throw new Error("NAPCAT_WEBUI_FIXED_REQUEST_INVALID"); };
  if (!pathname.startsWith("/api/") || pathname.includes("#") || pathname.includes("\\")) invalid();
  const parsed = new URL(pathname, "http://napcat.invalid");
  if (parsed.origin !== "http://napcat.invalid" || parsed.pathname !== pathname.split("?")[0]) invalid();
  if (method === "POST" && pathname === "/api/QQLogin/GetQQLoginInfo") return;
  for (const route of Object.values(napcatWebuiApiReadRoutes)) {
    if (route.method !== method) continue;
    const expected = route.upstreamPath.split("/");
    const actual = parsed.pathname.split("/");
    if (expected.length !== actual.length) continue;
    let match = true;
    for (let index = 0; index < expected.length; index++) {
      if (!expected[index]!.startsWith(":")) { if (expected[index] !== actual[index]) match = false; continue; }
      let value: string;
      try { value = decodeURIComponent(actual[index]!); } catch { invalid(); return; }
      if (expected[index] === ":pagePath") {
        if (!value || /[\\:\x00-\x1f?#]/.test(value) || value.split("/").some(part => !part || part === "." || part === "..")) match = false;
      } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) match = false;
    }
    if (!match) continue;
    for (const [key, value] of parsed.searchParams) {
      if (!route.queryKeys?.includes(key) || parsed.searchParams.getAll(key).length !== 1) invalid();
      if (key === "id" && (!value || value.length > 200 || /[/\\:]|\.\.|[\x00-\x1f]/.test(value))) invalid();
      if (key === "forceRefresh" && value !== "true" && value !== "false") invalid();
    }
    return;
  }
  invalid();
}
