import { ReadSettingsError } from "../shared/readSettingsError.js";
import type http from "node:http";
import { MIMEType } from "node:util";
import { qqReadSettings } from "../shared/qqReadSettings.js";
import { readNapCatStickers, QQ_STICKER_ID, QQ_STICKER_LIMITS } from "../napcatStickers.js";
import { normalizeNapCatInstances, definitionUsesNapcat } from "../shared/gatewayConfigModel.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";
import type { QqMessageRoutesContext } from "./qqMessageRoutes.js";
import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";
import { qqStickerOperationContract } from "./qqStickerContract.js";

/** Collection IDs and descriptions are public metadata; native signed media URLs stay internal. */
async function readQqStickerResult(request: http.IncomingMessage, url: URL, context: QqMessageRoutesContext,
  stickerId?: string): Promise<ApiOperationResult> {
  const headers = { "cache-control": "private, no-store" };
  const fail = (status: number, errorCode: string, message?: string): ApiOperationResult => ({ status, headers, body: { code: -1, errorCode, ...(message ? { message } : {}) } });
  const authorized = () => {
    try {
      const principal = assertTrustedLanAgentPrincipal(request);
      if (hasAuthenticatedConnectionRequest(request) || principal) return true;
      if (request.headers["x-rabilink-tunnel-local"] || request.headers["x-rabilink-resource-owner"] || request.headers["x-rabiroute-peer-proxy"]) return false;
      return context.local(request) && !getTrustedLanAgentSource(request) && !hasLanAgentBodyGuard(request);
    } catch { return false; }
  };
  if (!authorized()) return fail(403, "QQ_STICKERS_AUTH_REQUIRED");
  if (request.method !== "GET") return fail(405, "QQ_STICKERS_GET_REQUIRED");
  const routeId = url.searchParams.get("routeId") ?? "";
  const instanceId = url.searchParams.get("instanceId");
  let maximumCount: number;
  try { maximumCount = QQ_STICKER_LIMITS.count; }
  catch (error) { if (error instanceof ReadSettingsError) return fail(503, error.code, error.message); throw error; }
  const count = Number(url.searchParams.get("count") ?? String(maximumCount));
  const keys = [...url.searchParams.keys()];
  if (!Number.isInteger(count) || count < 1 || count > QQ_STICKER_LIMITS.count) return fail(400, "QQ_STICKERS_INVALID_QUERY",
    `count must be an integer from 1 to RABIROUTE_QQ_STICKER_COUNT=${QQ_STICKER_LIMITS.count}; adjust this Manager environment setting for a larger upstream request.`);
  if (!routeId || routeId.length > QQ_STICKER_LIMITS.routeIdChars || (instanceId !== null && (!instanceId || instanceId.length > QQ_STICKER_LIMITS.instanceIdChars))
    || keys.some(key => !["routeId", "instanceId", "count"].includes(key)) || new Set(keys).size !== keys.length
    || request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) {
    return fail(400, "QQ_STICKERS_INVALID_QUERY");
  }
  const definition = context.route(routeId);
  if (!definition || !definition.enabled || !definitionUsesNapcat(definition)) return fail(409, "QQ_STICKERS_ROUTE_UNAVAILABLE");
  const instances = normalizeNapCatInstances(definition).filter(item => item.enabled !== false);
  const candidates = instanceId ? instances.filter(item => item.id === instanceId) : instances;
  if (candidates.length !== 1) return fail(409, "QQ_STICKERS_INSTANCE_AMBIGUOUS");
  const instance = candidates[0]!;
  const endpoint = { httpUrl: instance.httpUrl, accessToken: instance.accessToken ?? "" };
  const current = () => {
    const now = context.route(routeId);
    const selected = now && normalizeNapCatInstances(now).find(item => item.id === instance.id);
    return authorized() && now?.enabled && definitionUsesNapcat(now) && selected?.enabled !== false
      && selected?.httpUrl === endpoint.httpUrl && (selected?.accessToken ?? "") === endpoint.accessToken;
  };
    let readingPreview = false;
    try {
      const items = await readNapCatStickers(endpoint, stickerId ? QQ_STICKER_LIMITS.count : count, context.transport);
      if (!current()) return fail(409, "QQ_STICKERS_INSTANCE_CHANGED");
      if (!stickerId) {
        const query = new URLSearchParams({ routeId, instanceId: instance.id });
        return { status: 200, headers, body: { code: 0, data: { routeId, instanceId: instance.id,
          items: items.map(({ id, description }) => ({ id, name: description, description, previewUrl: `/api/agent/qq/stickers/${id}/preview?${query}` })),
          completenessUnknown: true, potentiallyTruncated: items.length >= count } } };
      }
      const id = stickerId;
      const sticker = QQ_STICKER_ID.test(id) && items.find(item => item.id === id);
      if (!sticker) return fail(404, "QQ_STICKER_NOT_FOUND");
      readingPreview = true;
      const previewBytes = QQ_STICKER_LIMITS.previewBytes;
      const remote = await (context.transport ?? fetch)(sticker.url, { redirect: "follow", signal: AbortSignal.timeout(QQ_STICKER_LIMITS.previewTimeoutMs) });
      if (!remote.ok || !remote.body) throw new Error("QQ_STICKER_PREVIEW_UNAVAILABLE");
      let mime: MIMEType;
      try { mime = new MIMEType(remote.headers.get("content-type") ?? ""); }
      catch { await remote.body.cancel(); return fail(503, "QQ_STICKER_PREVIEW_NOT_IMAGE", "Sticker preview response has no valid image MIME type."); }
      if (mime.type !== "image" || mime.subtype.includes("*")) {
        await remote.body.cancel();
        return fail(503, "QQ_STICKER_PREVIEW_NOT_IMAGE", `Sticker preview requires an image MIME type; upstream returned ${mime.essence}.`);
      }
      const type = mime.essence;
      if (Number(remote.headers.get("content-length")) > previewBytes) {
        await remote.body.cancel().catch(() => undefined);
        throw new Error("QQ_STICKER_PREVIEW_TOO_LARGE");
      }
      const reader = remote.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.length;
          if (size > previewBytes) throw new Error("QQ_STICKER_PREVIEW_TOO_LARGE");
          chunks.push(result.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      if (!size || !current()) return fail(409, "QQ_STICKERS_INSTANCE_CHANGED");
      return { status: 200, headers: { ...headers, "content-type": type, "content-length": String(size), "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox" }, body: Buffer.concat(chunks) };
    } catch (error) {
      if (error instanceof ReadSettingsError) return fail(503, error.code, error.message);
      if (error instanceof Error && error.message === "QQ_STICKER_PREVIEW_TOO_LARGE") return fail(503, "QQ_STICKER_PREVIEW_TOO_LARGE",
        `Sticker preview exceeds RABIROUTE_QQ_STICKER_PREVIEW_MAX_BYTES; effective limit is ${QQ_STICKER_LIMITS.previewBytes} bytes. Set 0 to remove the application quota (runtime Buffer capacity still applies).`);
      if (error instanceof Error && error.name === "TimeoutError") return fail(503, readingPreview ? "QQ_STICKER_PREVIEW_TIMEOUT" : "QQ_READ_TIMEOUT",
        readingPreview ? `Sticker preview exceeded RABIROUTE_QQ_STICKER_PREVIEW_TIMEOUT_MS=${QQ_STICKER_LIMITS.previewTimeoutMs} ms.` : `Sticker list exceeded RABIROUTE_QQ_READ_TIMEOUT_MS=${qqReadSettings.readTimeoutMs} ms.`);
      if (error instanceof Error && error.message.startsWith("RABIROUTE_QQ_JSON_MAX_BYTES=")) return fail(503, "QQ_STICKERS_RESPONSE_TOO_LARGE", error.message);
      return fail(503, "QQ_STICKERS_UPSTREAM_UNAVAILABLE", error instanceof RangeError ? "Sticker preview exceeds the current runtime's buffer or memory capacity." : undefined);
    }
}

export function createQqStickerOperations(context: QqMessageRoutesContext): readonly ApiOperationDefinition[] {
  return [false, true].map(preview => ({ contract: qqStickerOperationContract(preview), handler: input =>
    readQqStickerResult(input.request, input.url, context, preview ? input.path.stickerId : undefined) }));
}

/** Transitional fixture adapter; production uses the executable operations above. */
export function handleQqStickerRoutes(request: http.IncomingMessage, url: URL, response: http.ServerResponse,
  context: QqMessageRoutesContext, track: <T>(operation: Promise<T>) => Promise<T>): boolean {
  const preview = /^\/api\/agent\/qq\/stickers\/([a-f0-9]{32})\/preview$/.exec(url.pathname);
  if (url.pathname !== "/api/agent/qq/stickers" && !preview) return false;
  void track(readQqStickerResult(request, url, context, preview?.[1]).then(result => {
    if (response.destroyed || response.writableEnded) return;
    for (const [key, value] of Object.entries(result.headers ?? {})) response.setHeader(key, value);
    if (result.body instanceof Uint8Array) { response.writeHead(result.status); response.end(result.body); }
    else context.json(response, result.status, result.body);
  })).catch(() => { if (!response.destroyed) response.destroy(); });
  return true;
}
