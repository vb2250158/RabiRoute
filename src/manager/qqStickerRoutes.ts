import type http from "node:http";
import { readNapCatStickers, QQ_STICKER_ID } from "../napcatStickers.js";
import { normalizeNapCatInstances, definitionUsesNapcat } from "../shared/gatewayConfigModel.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";
import type { QqMessageRoutesContext } from "./qqMessageRoutes.js";

/** Collection IDs and descriptions are public metadata; native signed media URLs stay internal. */
export function handleQqStickerRoutes(request: http.IncomingMessage, url: URL, response: http.ServerResponse,
  context: QqMessageRoutesContext, track: <T>(operation: Promise<T>) => Promise<T>): boolean {
  const list = url.pathname === "/api/agent/qq/stickers";
  const preview = /^\/api\/agent\/qq\/stickers\/([a-f0-9]{32})\/preview$/.exec(url.pathname);
  if (!list && !preview) return false;
  response.setHeader("cache-control", "private, no-store");
  const fail = (status: number, errorCode: string) => context.json(response, status, { code: -1, errorCode });
  const authorized = () => {
    try {
      const principal = assertTrustedLanAgentPrincipal(request);
      if (hasAuthenticatedConnectionRequest(request) || principal) return true;
      if (request.headers["x-rabilink-tunnel-local"] || request.headers["x-rabilink-resource-owner"] || request.headers["x-rabiroute-peer-proxy"]) return false;
      return context.local(request) && !getTrustedLanAgentSource(request) && !hasLanAgentBodyGuard(request);
    } catch { return false; }
  };
  if (!authorized()) { fail(403, "QQ_STICKERS_AUTH_REQUIRED"); return true; }
  if (request.method !== "GET") { fail(405, "QQ_STICKERS_GET_REQUIRED"); return true; }
  const routeId = url.searchParams.get("routeId") ?? "";
  const instanceId = url.searchParams.get("instanceId");
  const count = Number(url.searchParams.get("count") ?? "1000");
  const keys = [...url.searchParams.keys()];
  if (!routeId || routeId.length > 256 || (instanceId !== null && (!instanceId || instanceId.length > 128))
    || !Number.isInteger(count) || count < 1 || count > 1000
    || keys.some(key => !["routeId", "instanceId", "count"].includes(key)) || new Set(keys).size !== keys.length
    || request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) {
    fail(400, "QQ_STICKERS_INVALID_QUERY"); return true;
  }
  const definition = context.route(routeId);
  if (!definition || !definition.enabled || !definitionUsesNapcat(definition)) { fail(409, "QQ_STICKERS_ROUTE_UNAVAILABLE"); return true; }
  const instances = normalizeNapCatInstances(definition).filter(item => item.enabled !== false);
  const candidates = instanceId ? instances.filter(item => item.id === instanceId) : instances;
  if (candidates.length !== 1) { fail(409, "QQ_STICKERS_INSTANCE_AMBIGUOUS"); return true; }
  const instance = candidates[0]!;
  const endpoint = { httpUrl: instance.httpUrl, accessToken: instance.accessToken ?? "" };
  const current = () => {
    const now = context.route(routeId);
    const selected = now && normalizeNapCatInstances(now).find(item => item.id === instance.id);
    return authorized() && now?.enabled && definitionUsesNapcat(now) && selected?.enabled !== false
      && selected?.httpUrl === endpoint.httpUrl && (selected?.accessToken ?? "") === endpoint.accessToken;
  };
  const operation = async () => {
    try {
      const items = await readNapCatStickers(endpoint, preview ? 1000 : count, context.transport);
      if (!current()) { fail(409, "QQ_STICKERS_INSTANCE_CHANGED"); return; }
      if (list) {
        const query = new URLSearchParams({ routeId, instanceId: instance.id });
        context.json(response, 200, { code: 0, data: { routeId, instanceId: instance.id,
          items: items.map(({ id, description }) => ({ id, name: description, description, previewUrl: `/api/agent/qq/stickers/${id}/preview?${query}` })),
          completenessUnknown: true, potentiallyTruncated: items.length >= count } });
        return;
      }
      const id = preview![1]!;
      const sticker = QQ_STICKER_ID.test(id) && items.find(item => item.id === id);
      if (!sticker) { fail(404, "QQ_STICKER_NOT_FOUND"); return; }
      const remote = await (context.transport ?? fetch)(sticker.url, { redirect: "error", signal: AbortSignal.timeout(10000) });
      const type = remote.headers.get("content-type")?.split(";")[0] ?? "";
      if (!remote.ok || !remote.body || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type)
        || Number(remote.headers.get("content-length")) > 8 * 1024 * 1024) throw new Error("QQ_STICKER_PREVIEW_UNAVAILABLE");
      const reader = remote.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.length;
          if (size > 8 * 1024 * 1024) throw new Error("QQ_STICKER_PREVIEW_TOO_LARGE");
          chunks.push(result.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      if (!size || !current()) { fail(409, "QQ_STICKERS_INSTANCE_CHANGED"); return; }
      response.writeHead(200, { "content-type": type, "content-length": size, "x-content-type-options": "nosniff" });
      response.end(Buffer.concat(chunks));
    } catch { if (!response.writableEnded) fail(503, "QQ_STICKERS_UPSTREAM_UNAVAILABLE"); }
  };
  void track(operation()).catch(() => undefined);
  return true;
}
