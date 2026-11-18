import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import { createHash } from "node:crypto";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { boundedBytes } from "../manager/qqMessageMedia.js";
import { assertNapcatWebuiFixedRead } from "../manager/napcatWebuiApiRoutes.js";
import { assertNapcatWebuiManagementRequest } from "../manager/napcatWebuiManagementContracts.js";
import { assertNapcatWebuiExtendedRequest } from "../manager/napcatWebuiExtendedContracts.js";
import { assertNapcatWebuiFileRequest, assertNapcatWebuiMultipart } from "../manager/napcatWebuiFileContracts.js";
import { assertNapcatWebuiAuthRequest } from "../manager/napcatWebuiAuthContracts.js";

export type NapcatWebuiSession = {
  baseUrl: string;
  request(pathname: string, body?: Record<string, unknown>): Promise<Response>;
  requestFixed(method: "GET" | "POST", pathname: string, signal: AbortSignal): Promise<Response>;
  requestManagement(method: "GET" | "POST", pathname: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  requestMultipart(pathname: string, query: Record<string,unknown>, files: readonly {field:string;filename:string;bytes:Uint8Array}[], signal: AbortSignal): Promise<Response>;
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
    let hash = createHash("sha256").update(`${token}.napcat`).digest("hex");
    let key = JSON.stringify([baseUrl, hash]);
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
    const perform = async (method: "GET" | "POST", pathname: string, body: Record<string, unknown> | FormData | undefined, signal?: AbortSignal): Promise<Response> => {
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
          const handshake = new AbortController();
          const handshakeTimer = setTimeout(() => handshake.abort(),getTimeoutMs("backend.messageEndpoints.napcatWebuiSession.request.AbortSignal.timeout.request", 5000));
          handshakeTimer.unref();
          const deadline = handshake.signal;
          let response = await fetch(target, {
            method, redirect: "error", headers: { ...(body instanceof FormData ? {} : {"content-type": "application/json; charset=utf-8"}), authorization: `Bearer ${credential.value}` },
            ...(method === "POST" ? { body: body instanceof FormData ? body : JSON.stringify(body ?? {}) } : {}), signal: signal ? AbortSignal.any([signal, deadline]) : deadline
          });
          // Finite/lease-owned SSE readers retain their supplied cancellation and byte budgets.
          // The transport deadline covers their handshake, not an unrelated five-second lease.
          if(signal && response.headers.get("content-type")?.includes("text/event-stream"))clearTimeout(handshakeTimer);
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
        if (!assertNapcatWebuiExtendedRequest(method, pathname, body) && !assertNapcatWebuiFileRequest(method,pathname,body) && !assertNapcatWebuiAuthRequest(method,pathname,body)) assertNapcatWebuiManagementRequest(method, pathname, body);
        if(pathname === "/api/auth/update_token")return (async()=>{
          if(body.newToken===token)throw new Error("NAPCAT_WEBUI_TOKEN_UNCHANGED");
          const oldKey=key;
          const response=await perform("POST",pathname,{oldToken:token,newToken:body.newToken},signal),bytes=await boundedBytes(response,qqReadSettings.jsonBytes,"RABIROUTE_QQ_JSON_MAX_BYTES");
          let value:{code?:unknown};try{value=JSON.parse(bytes.toString("utf8"));}catch{throw new Error("NAPCAT_WEBUI_AUTH_RESPONSE_INVALID");}
          if(!response.ok||value.code!==0)throw new Error("NAPCAT_WEBUI_TOKEN_ROTATION_REJECTED");
          this.credentials.delete(oldKey);token=String(body.newToken);hash=createHash("sha256").update(`${token}.napcat`).digest("hex");key=JSON.stringify([baseUrl,hash]);
          if(!await authorize())throw new Error("NAPCAT_WEBUI_TOKEN_ROTATION_UNCONFIRMED");
          return Response.json({code:0,data:{changed:true}});
        })();
        if(pathname === "/api/auth/passkey/verify-authentication")return (async()=>{
          const response=await perform(method,pathname,body,signal),bytes=await boundedBytes(response,qqReadSettings.jsonBytes,"RABIROUTE_QQ_JSON_MAX_BYTES");
          let value:{code?:unknown;data?:{Credential?:unknown}};try{value=JSON.parse(bytes.toString("utf8"));}catch{throw new Error("NAPCAT_WEBUI_AUTH_RESPONSE_INVALID");}
          if(!response.ok||value.code!==0||typeof value.data?.Credential!=="string"||!value.data.Credential.trim())throw new Error("NAPCAT_WEBUI_PASSKEY_VERIFICATION_FAILED");
          this.credentials.set(key,{value:value.data.Credential.trim(),expiresAt:Date.now()+this.ttlMs});
          return Response.json({code:0,data:{authenticated:true}});
        })();
        if(pathname === "/api/auth/login") {
          return (async()=>{
          signal.throwIfAborted();
          if(!await authorize()) throw new Error("NAPCAT_WEBUI_AUTHENTICATION_UNAVAILABLE");
          return Response.json({code:0,data:{authenticated:true}});
          })();
        }
        if(pathname === "/api/auth/check" || pathname === "/api/auth/logout") {
          return (async()=>{
          const credential=await authorize();
          if(!credential)throw new Error("NAPCAT_WEBUI_AUTHENTICATION_UNAVAILABLE");
          const response=await perform(method,pathname,body,signal);
          const bytes=await boundedBytes(response,qqReadSettings.jsonBytes,"RABIROUTE_QQ_JSON_MAX_BYTES");
          let native:{code?:unknown};try{native=JSON.parse(bytes.toString("utf8"));}catch{throw new Error("NAPCAT_WEBUI_AUTH_RESPONSE_INVALID");}
          if(!response.ok||native.code!==0)throw new Error("NAPCAT_WEBUI_AUTHENTICATION_UNAVAILABLE");
          if(pathname === "/api/auth/logout") invalidate(credential);
          return Response.json({code:0,data:{authenticated:pathname === "/api/auth/check"}});
          })();
        }
        const query = (method === "GET" || pathname === "/api/File/download") && Object.keys(body).length ? "?" + new URLSearchParams(Object.entries(body).map(([key,value]) => [key,String(value)])) : "";
        return perform(method, pathname + query, body, signal);
      },
      requestMultipart: (pathname,query,files,signal)=>{
        assertNapcatWebuiMultipart(pathname,query,files);
        const data=new FormData();for(const file of files)data.append(file.field,new Blob([Uint8Array.from(file.bytes)]),file.filename);
        const suffix=Object.keys(query).length?"?"+new URLSearchParams(Object.entries(query).map(([key,value])=>[key,String(value)])):"";
        return perform("POST",pathname+suffix,data,signal);
      }
    };
  }
}
