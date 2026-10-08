import type http from "node:http";
import { createHash } from "node:crypto";
import { normalizeNapCatInstances, definitionUsesNapcat, type GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";
import { QqReadError, qqRead, qqMessageMatches, qqMessageMedia, qqMessageText, readQqMedia, type QqMessage } from "./qqMessageMedia.js";

export type QqMessageRoutesContext = {
  local: (request: http.IncomingMessage) => boolean;
  route: (routeId: string) => GatewayDefinition | undefined;
  json: (response: http.ServerResponse, status: number, body: unknown) => void;
  transport?: typeof fetch;
};
const activeReads = new WeakMap<QqMessageRoutesContext, number>();

/** Local management reads only. Remote Agent grants require a separate object-read contract. */
export function handleQqMessageRoutes(request: http.IncomingMessage, url: URL, response: http.ServerResponse,
  context: QqMessageRoutesContext, track: <T>(operation: Promise<T>) => Promise<T>): boolean {
  const history = url.pathname === "/api/agent/qq/history";
  const match = /^\/api\/agent\/qq\/messages\/(-?\d{1,20})(?:\/attachments\/(\d{1,2}))?$/.exec(url.pathname);
  if (!history && !match) return false;
  const fail = (status: number, errorCode: string) => context.json(response, status, { code: -1, errorCode });
  response.setHeader("cache-control", "private, no-store");
  if (request.method !== "GET") { fail(405, "QQ_READ_GET_REQUIRED"); return true; }
  if (!context.local(request) || getTrustedLanAgentSource(request) || hasLanAgentBodyGuard(request)
    || request.headers["x-rabilink-tunnel-local"] || request.headers["x-rabilink-resource-owner"] || request.headers["x-rabiroute-peer-proxy"]) {
    fail(403, "QQ_READ_LOCAL_REQUIRED"); return true;
  }
  const allowed = history ? ["routeId", "kind", "target", "cursor", "limit"] : ["routeId", "kind", "target"];
  const keys = [...url.searchParams.keys()];
  const routeId = url.searchParams.get("routeId") ?? "";
  const kind = url.searchParams.get("kind") ?? "";
  const target = url.searchParams.get("target") ?? "";
  const cursor = url.searchParams.get("cursor");
  const limit = Number(url.searchParams.get("limit") ?? "50");
  if (keys.some(key => !allowed.includes(key) || !url.searchParams.get(key)) || new Set(keys).size !== keys.length
    || !routeId || routeId.length > 256 || !["group", "private"].includes(kind) || !/^[1-9]\d{0,15}$/.test(target)
    || (cursor !== null && !/^-?\d{1,20}$/.test(cursor)) || !Number.isInteger(limit) || limit < 1 || limit > 100
    || request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) {
    fail(400, "QQ_READ_INVALID_QUERY"); return true;
  }
  const definition = context.route(routeId);
  if (!definition || definition.enabled !== true || !definitionUsesNapcat(definition)) { fail(409, "QQ_READ_ROUTE_UNAVAILABLE"); return true; }
  if (!Array.isArray(definition.napcatInstances) || definition.napcatInstances.length !== 1 || definition.napcatInstances[0]?.enabled === false) {
    fail(409, "QQ_READ_INSTANCE_AMBIGUOUS"); return true;
  }
  const instance = normalizeNapCatInstances(definition)[0]!;
  const endpoint = { httpUrl: instance.httpUrl, accessToken: instance.accessToken ?? "" };
  const active = activeReads.get(context) ?? 0;
  if (active >= 2) { fail(429, "QQ_READ_BUSY"); return true; }
  activeReads.set(context, active + 1);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), match?.[2] !== undefined ? 30_000 : 8_000);
  const closed = () => { if (!response.writableEnded) controller.abort(); };
  response.once("close", closed);
  const current = () => {
    const now = normalizeNapCatInstances(definition);
    if (context.route(routeId) !== definition || !context.local(request) || definition.enabled !== true || !definitionUsesNapcat(definition)
      || definition.napcatInstances?.length !== 1 || now.length !== 1 || now[0]?.enabled === false
      || now[0]?.id !== instance.id || now[0]?.httpUrl !== endpoint.httpUrl || (now[0]?.accessToken ?? "") !== endpoint.accessToken) throw new QqReadError(409, "QQ_READ_ROUTE_CHANGED");
  };
  const page = async (anchor: string | null, count: number) => {
    const data = await qqRead(endpoint, kind === "group" ? "get_group_msg_history" : "get_friend_msg_history", {
      [kind === "group" ? "group_id" : "user_id"]: target, count,
      ...(anchor ? { message_seq: anchor } : {}), reverseOrder: true, disable_get_url: true, parse_mult_msg: false
    }, controller.signal, context.transport);
    if (!Array.isArray(data.messages)) throw new QqReadError(503, "QQ_HISTORY_INVALID_RESPONSE");
    if (data.messages.some(row => !qqMessageMatches(row, kind, target))) throw new QqReadError(409, "QQ_MESSAGE_TARGET_MISMATCH");
    return (data.messages as QqMessage[]).slice(0, count);
  };
  const project = (row: QqMessage) => ({ messageId: String(row.message_id), time: row.time, kind, target,
    sender: String(row.sender?.user_id ?? row.user_id ?? ""), senderName: row.sender?.card || row.sender?.nickname,
    text: qqMessageText(row), attachments: qqMessageMedia(row.message ?? row.raw_message).map((media, index) => ({
      index, kind: media.kind, name: media.name,
      contentUrl: `/api/agent/qq/messages/${encodeURIComponent(String(row.message_id))}/attachments/${index}?${new URLSearchParams({ routeId, kind, target })}`
    })) });
  void track((async () => {
    if (history) {
      const rows = await page(cursor, limit);
      current();
      const oldest = rows.reduce<QqMessage | undefined>((a, b) => !a || Number(b.time) < Number(a.time) ? b : a, undefined);
      const next = oldest ? String(oldest.message_id) : null;
      context.json(response, 200, { code: 0, data: { routeId, instanceId: instance.id, entries: rows.map(project),
        nextCursor: next === cursor ? null : next, cursorStalled: next !== null && next === cursor, completenessUnknown: true } });
      return;
    }
    const messageId = match![1];
    let row: QqMessage;
    try {
      const value = await qqRead(endpoint, "get_msg", { message_id: messageId }, controller.signal, context.transport);
      if (!qqMessageMatches(value, kind, target) || String(value.message_id) !== messageId) throw new QqReadError(409, "QQ_MESSAGE_TARGET_MISMATCH");
      row = value;
    } catch (error) {
      if (error instanceof QqReadError && error.code !== "QQ_UPSTREAM_UNAVAILABLE") throw error;
      const rows = await page(messageId, 10);
      const found = rows.find(item => String(item.message_id) === messageId);
      if (!found) throw new QqReadError(404, "QQ_MESSAGE_NOT_IN_PAGE");
      row = found;
    }
    current();
    if (match![2] === undefined) { context.json(response, 200, { code: 0, data: { routeId, instanceId: instance.id, ...project(row) } }); return; }
    const attachment = qqMessageMedia(row.message ?? row.raw_message)[Number(match![2])];
    if (!attachment) throw new QqReadError(404, "QQ_ATTACHMENT_NOT_FOUND");
    const body = await readQqMedia(endpoint, attachment, controller.signal, context.transport);
    current();
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length,
      "x-rabiroute-content-sha256": createHash("sha256").update(body).digest("hex"),
      "x-content-type-options": "nosniff", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}` });
    response.end(body);
  })().catch(error => {
    if (response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    fail(error instanceof QqReadError ? error.status : 503, error instanceof QqReadError ? error.code : "QQ_UPSTREAM_UNAVAILABLE");
  }).finally(() => { activeReads.set(context, (activeReads.get(context) ?? 1) - 1); clearTimeout(timeout); response.off("close", closed); }));
  return true;
}
