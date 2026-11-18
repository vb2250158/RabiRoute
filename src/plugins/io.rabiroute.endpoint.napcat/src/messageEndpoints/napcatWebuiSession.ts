import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import { createHash } from "node:crypto";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { boundedBytes } from "../manager/qqMessageMedia.js";
import { assertNapcatWebuiFixedRead } from "../manager/napcatWebuiApiRoutes.js";
import { assertNapcatWebuiManagementRequest } from "../manager/napcatWebuiManagementContracts.js";

export type NapcatWebuiSession = {
  baseUrl: string;
  request(pathname: string, body?: Record<string, unknown>): Promise<Response>;
  requestFixed(method: "GET" | "POST", pathname: string, signal: AbortSignal): Promise<Response>;
  requestManagement(method: "GET" | "POST", pathname: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
};
type Credential = { value: string; expiresAt: number };

/** Management credentials are private connection state, never QQ login state. */
export class NapcatWebuiSessions {
  private credentials = new Map<string, Credential>();
  private flights = new Map<string, Promise<Credential | null>>();

  constructor(private readonly ttlMs = 5 * 60_000) {}

  async open(baseUrl: string, token: string): Promise<NapcatWebuiSession | null> {
    const base = new URL(baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || baseUrl.includes("\\")) {
      throw new Error("NAPCAT_WEBUI_BASE_URL_INVALID");
    }
    const prefix = base.pathname.replace(/\/+$/, "");
    baseUrl = base.origin + prefix;
    const hash = createHash("sha256").update(`${token}.napcat`).digest("hex");
    const key = JSON.stringify([baseUrl, hash]);
    const authorize = (): Promise<Credential | null> => {
      const cached = this.credentials.get(key);
      if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached);
      const pending = this.flights.get(key);
      if (pending) return pending;
      const flight = (async () => {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST", redirect: "error", headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ hash }), signal: AbortSignal.timeout(getTimeoutMs("backend.messageEndpoints.napcatWebuiSession.authorize.AbortSignal.timeout.request", 5000))
        });
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); return null; }
        const bytes = await boundedBytes(response, qqReadSettings.jsonBytes, "RABIROUTE_QQ_JSON_MAX_BYTES");
        let result: { code?: number; data?: { Credential?: string } };
        try { result = JSON.parse(bytes.toString("utf8")); } catch { return null; }
        const value = typeof result?.data?.Credential === "string" ? result.data.Credential.trim() : "";
        if (!response.ok || result.code !== 0 || !value) return null;
        for (const [oldKey, item] of this.credentials) if (item.expiresAt <= Date.now()) this.credentials.delete(oldKey);
        if (this.credentials.size >= 64) this.credentials.delete(this.credentials.keys().next().value!);
        const credential = { value, expiresAt: Date.now() + this.ttlMs };
        this.credentials.set(key, credential);
        return credential;
      })().finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
      this.flights.set(key, flight);
      return flight;
    };
    const invalidate = (credential: Credential) => {
      if (this.credentials.get(key) === credential) this.credentials.delete(key);
    };
    if (!await authorize()) return null;
    const perform = async (method: "GET" | "POST", pathname: string, body: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<Response> => {
        const target = new URL(`${baseUrl}${pathname}`);
        const nativePath = pathname.split("?")[0]!;
        if (!pathname.startsWith("/api/") || pathname.includes("\\") || /%(?:2f|5c|2e)/i.test(nativePath)
          || target.origin !== base.origin || target.hash || !target.pathname.startsWith(`${prefix}/api/`)
          || target.pathname !== `${prefix}${nativePath}`) throw new Error("NAPCAT_WEBUI_PATH_INVALID");
        for (let attempt = 0; attempt < 2; attempt++) {
          signal?.throwIfAborted();
          const credential = await authorize();
          signal?.throwIfAborted();
          if (!credential) throw new Error("NapCat 管理服务暂时无法认证；请确认后台已启动并能读取 WebUI 登录密钥。");
          const deadline = AbortSignal.timeout(getTimeoutMs("backend.messageEndpoints.napcatWebuiSession.request.AbortSignal.timeout.request", 5000));
          let response = await fetch(target, {
            method, redirect: "error", headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${credential.value}` },
            ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}), signal: signal ? AbortSignal.any([signal, deadline]) : deadline
          });
          let unauthorized = response.status === 401;
          if (unauthorized) await response.body?.cancel().catch(() => undefined);
          else if (response.headers.get("content-type")?.toLowerCase().includes("json") && response.body) {
            const bytes = await boundedBytes(response, qqReadSettings.jsonBytes, "RABIROUTE_QQ_JSON_MAX_BYTES");
            let result: { code?: unknown; message?: unknown } = {};
            try { result = JSON.parse(bytes.toString("utf8")); } catch { /* The typed caller reports malformed JSON. */ }
            unauthorized = result?.code === -1 && /^(?:Unauthorized|Authorization Failed)$/i.test(String(result?.message ?? "").trim());
            const headers = new Headers(response.headers);
            headers.delete("content-encoding"); headers.set("content-length", String(bytes.length));
            response = new Response(Uint8Array.from(bytes), { status: response.status, statusText: response.statusText, headers });
          }
          if (!unauthorized) return response;
          invalidate(credential);
          // Authentication rejection precedes execution; ordinary action failures are never retried.
          if (attempt === 1) return response;
        }
        throw new Error("NapCat management authentication failed.");
    };
    return {
      baseUrl,
      request: (pathname, body = {}) => perform("POST", pathname, body),
      requestFixed: (method, pathname, signal) => {
        assertNapcatWebuiFixedRead(method, pathname);
        return perform(method, pathname, undefined, signal);
      },
      requestManagement: (method, pathname, body, signal) => {
        assertNapcatWebuiManagementRequest(method, pathname, body);
        return perform(method, pathname, body, signal);
      }
    };
  }
}
