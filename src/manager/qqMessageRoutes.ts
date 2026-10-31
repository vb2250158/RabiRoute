import { ReadSettingsError } from "../shared/readSettingsError.js";
import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";
import { QQ_READ_LIMITS, QQ_READ_KINDS, QQ_MESSAGE_ID_PATTERN, QQ_ATTACHMENT_INDEX_PATTERN, QQ_TARGET_ID_PATTERN,
  QQ_HISTORY_QUERY_SCHEMA, QQ_MESSAGE_QUERY_SCHEMA, projectPublicQqMessage, qqReadOperationContract, type QqReadTarget } from "./qqReadContract.js";
import type http from "node:http";
import { createHash } from "node:crypto";
import { normalizeNapCatInstances, definitionUsesNapcat, type GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { QqReadError, qqRead, qqMessageMatches, qqMessageMedia, readQqMedia, type QqMessage } from "./qqMessageMedia.js";

export type QqMessageRoutesContext = {
  local: (request: http.IncomingMessage) => boolean;
  route: (routeId: string) => GatewayDefinition | undefined;
  json: (response: http.ServerResponse, status: number, body: unknown) => void;
  transport?: typeof fetch;
};
const activeReads = new WeakMap<QqMessageRoutesContext, number>();

/** One exact current-message read owner for both public QQ reads and outbound quote validation. */
export async function readExactQqMessage(input: {
  endpoint: { httpUrl: string; accessToken: string };
  kind: "group" | "private";
  target: string;
  messageId: string;
  signal: AbortSignal;
  current: () => void;
  transport?: typeof fetch;
}): Promise<QqMessage> {
  const historyPage = async () => {
    input.current();
    const data = await qqRead(input.endpoint, input.kind === "group" ? "get_group_msg_history" : "get_friend_msg_history", {
      [input.kind === "group" ? "group_id" : "user_id"]: input.target,
      count: QQ_READ_LIMITS.fallbackCount,
      message_seq: input.messageId,
      reverseOrder: true,
      disable_get_url: true,
      parse_mult_msg: false
    }, input.signal, input.transport);
    input.current();
    if (!Array.isArray(data.messages)) throw new QqReadError(503, "QQ_HISTORY_INVALID_RESPONSE");
    if (data.messages.some(row => !qqMessageMatches(row, input.kind, input.target))) {
      throw new QqReadError(409, "QQ_MESSAGE_TARGET_MISMATCH");
    }
    const found = (data.messages as QqMessage[]).find(item => String(item.message_id) === input.messageId);
    if (!found) throw new QqReadError(404, "QQ_MESSAGE_NOT_IN_PAGE");
    return found;
  };
  input.current();
  try {
    const value = await qqRead(input.endpoint, "get_msg", { message_id: input.messageId }, input.signal, input.transport);
    input.current();
    if (!qqMessageMatches(value, input.kind, input.target) || String(value.message_id) !== input.messageId) {
      throw new QqReadError(409, "QQ_MESSAGE_TARGET_MISMATCH");
    }
    return value;
  } catch (error) {
    if (error instanceof QqReadError && error.code !== "QQ_UPSTREAM_UNAVAILABLE") throw error;
    return historyPage();
  }
}

const messagePath = new RegExp(`^/api/agent/qq/messages/(${QQ_MESSAGE_ID_PATTERN.source.slice(1, -1)})(?:/attachments/(${QQ_ATTACHMENT_INDEX_PATTERN.source.slice(1, -1)}))?$`);

/** The same read owner returns finite DTO/byte results to executable and transitional adapters. */
async function readQqMessageResult(request: http.IncomingMessage, url: URL,
  response: Pick<http.ServerResponse, "once" | "off" | "writableEnded">, context: QqMessageRoutesContext, selected: QqReadTarget): Promise<ApiOperationResult> {
  const history = selected.kind === "history";
  const headers = { "cache-control": "private, no-store" };
  const fail = (status: number, errorCode: string, message?: string): ApiOperationResult => ({ status, headers, body: { code: -1, errorCode, ...(message ? { message } : {}) } });
  const ok = (data: unknown): ApiOperationResult => ({ status: 200, headers, body: { code: 0, data } });
  if (request.method !== "GET") return fail(405, "QQ_READ_GET_REQUIRED");
  const authorized = () => {
    try {
      const principal = assertTrustedLanAgentPrincipal(request);
      if (hasAuthenticatedConnectionRequest(request) || principal) return true;
      if (request.headers["x-rabilink-tunnel-local"] || request.headers["x-rabilink-resource-owner"] || request.headers["x-rabiroute-peer-proxy"]) return false;
      return context.local(request) && !getTrustedLanAgentSource(request) && !hasLanAgentBodyGuard(request);
    } catch { return false; }
  };
  if (!authorized()) return fail(403, "QQ_READ_AUTH_REQUIRED");
  const allowed = Object.keys(history ? QQ_HISTORY_QUERY_SCHEMA.properties : QQ_MESSAGE_QUERY_SCHEMA.properties);
  const keys = [...url.searchParams.keys()];
  const routeId = url.searchParams.get("routeId") ?? "";
  const kind = url.searchParams.get("kind") ?? "";
  const target = url.searchParams.get("target") ?? "";
  const cursor = url.searchParams.get("cursor");
  const limit = Number(url.searchParams.get("limit") ?? QQ_READ_LIMITS.historyDefault);
  if (keys.some(key => !allowed.includes(key) || !url.searchParams.get(key)) || new Set(keys).size !== keys.length
    || !routeId || routeId.length > QQ_READ_LIMITS.routeIdChars || !(QQ_READ_KINDS as readonly string[]).includes(kind) || !QQ_TARGET_ID_PATTERN.test(target)
    || (cursor !== null && !QQ_MESSAGE_ID_PATTERN.test(cursor)) || !Number.isInteger(limit) || limit < 1 || limit > QQ_READ_LIMITS.historyMax
    || request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) return fail(400, "QQ_READ_INVALID_QUERY");
  const definition = context.route(routeId);
  if (!definition || definition.enabled !== true || !definitionUsesNapcat(definition)) return fail(409, "QQ_READ_ROUTE_UNAVAILABLE");
  if (!Array.isArray(definition.napcatInstances) || definition.napcatInstances.length !== 1 || definition.napcatInstances[0]?.enabled === false) return fail(409, "QQ_READ_INSTANCE_AMBIGUOUS");
  const instance = normalizeNapCatInstances(definition)[0]!;
  const endpoint = { httpUrl: instance.httpUrl, accessToken: instance.accessToken ?? "" };
  let concurrency: number, timeoutMs: number;
  try { concurrency = QQ_READ_LIMITS.concurrency; timeoutMs = selected.kind === "attachment" ? QQ_READ_LIMITS.mediaTimeoutMs : QQ_READ_LIMITS.timeoutMs; }
  catch (error) { if (error instanceof ReadSettingsError) return fail(503, error.code, error.message); throw error; }
  const active = activeReads.get(context) ?? 0;
  if (active >= concurrency) return fail(429, "QQ_READ_BUSY",
    `QQ reads are busy; RABIROUTE_QQ_READ_CONCURRENCY=${QQ_READ_LIMITS.concurrency}. Retry after current reads complete or adjust this Manager environment setting.`);
  activeReads.set(context, active + 1);
  const controller = new AbortController();
  const timeoutSetting = selected.kind === "attachment" ? "RABIROUTE_QQ_MEDIA_TIMEOUT_MS" : "RABIROUTE_QQ_READ_TIMEOUT_MS";
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const closed = () => { if (!response.writableEnded) controller.abort(); };
  response.once("close", closed);
  const current = () => {
    const now = normalizeNapCatInstances(definition);
    if (!authorized()) throw new QqReadError(403, "QQ_READ_AUTHORIZATION_REVOKED");
    if (context.route(routeId) !== definition || definition.enabled !== true || !definitionUsesNapcat(definition)
      || definition.napcatInstances?.length !== 1 || now.length !== 1 || now[0]?.enabled === false
      || now[0]?.id !== instance.id || now[0]?.httpUrl !== endpoint.httpUrl || (now[0]?.accessToken ?? "") !== endpoint.accessToken) throw new QqReadError(409, "QQ_READ_ROUTE_CHANGED");
  };
  const page = async (anchor: string | null, count: number) => {
    current();
    const data = await qqRead(endpoint, kind === "group" ? "get_group_msg_history" : "get_friend_msg_history", {
      [kind === "group" ? "group_id" : "user_id"]: target, count,
      ...(anchor ? { message_seq: anchor } : {}), reverseOrder: true, disable_get_url: true, parse_mult_msg: false
    }, controller.signal, context.transport);
    if (!Array.isArray(data.messages)) throw new QqReadError(503, "QQ_HISTORY_INVALID_RESPONSE");
    if (data.messages.some(row => !qqMessageMatches(row, kind, target))) throw new QqReadError(409, "QQ_MESSAGE_TARGET_MISMATCH");
    return (data.messages as QqMessage[]).slice(0, count);
  };
  const project = (row: QqMessage) => projectPublicQqMessage(row, { routeId, kind: kind as "group" | "private", target });
  try {
    if (selected.kind === "history") {
      const rows = await page(cursor, limit); current();
      const oldest = rows.reduce<QqMessage | undefined>((a, b) => !a || Number(b.time) < Number(a.time) ? b : a, undefined);
      const next = oldest ? String(oldest.message_id) : null;
      return ok({ routeId, instanceId: instance.id, entries: rows.map(project), nextCursor: next === cursor ? null : next,
        cursorStalled: next !== null && next === cursor, completenessUnknown: true });
    }
    const messageId = selected.messageId;
    const row = await readExactQqMessage({ endpoint, kind: kind as "group" | "private", target, messageId,
      signal: controller.signal, current, transport: context.transport });
    current();
    if (selected.kind === "message") return ok({ routeId, instanceId: instance.id, ...project(row) });
    const attachment = qqMessageMedia(row.message ?? row.raw_message)[selected.index];
    if (!attachment) throw new QqReadError(404, "QQ_ATTACHMENT_NOT_FOUND");
    const body = await readQqMedia(endpoint, attachment, controller.signal, context.transport); current();
    return { status: 200, body, headers: { ...headers, "content-length": String(body.length),
      "x-rabiroute-content-sha256": createHash("sha256").update(body).digest("hex"), "x-content-type-options": "nosniff",
      "content-type": "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}` } };
  } catch (error) {
    if (error instanceof ReadSettingsError) return fail(503, error.code, error.message);
    if (timedOut) return fail(503, "QQ_READ_TIMEOUT", `QQ read exceeded ${timeoutSetting}=${timeoutMs} ms. Adjust this Manager environment setting if the source needs longer.`);
    return fail(error instanceof QqReadError ? error.status : 503, error instanceof QqReadError ? error.code : "QQ_UPSTREAM_UNAVAILABLE",
      error instanceof QqReadError && error.message !== error.code ? error.message : error instanceof RangeError ? `QQ media exceeds the current runtime's buffer or memory capacity (${error.name}).` : undefined);
  }
  finally { activeReads.set(context, (activeReads.get(context) ?? 1) - 1); clearTimeout(timeout); response.off("close", closed); }
}

export function createQqMessageOperations(context: QqMessageRoutesContext): readonly ApiOperationDefinition[] {
  return (["history", "message", "attachment"] as const).map(kind => ({ contract: qqReadOperationContract(kind), handler: input => {
    const selected: QqReadTarget = kind === "history" ? { kind } : kind === "message" ? { kind, messageId: input.path.messageId! }
      : { kind, messageId: input.path.messageId!, index: Number(input.path.attachmentIndex) };
    return readQqMessageResult(input.request, input.url, input.response, context, selected);
  } }));
}

/** Transitional raw adapter; production registration uses the executable operations above. */
export function handleQqMessageRoutes(request: http.IncomingMessage, url: URL, response: http.ServerResponse,
  context: QqMessageRoutesContext, track: <T>(operation: Promise<T>) => Promise<T>): boolean {
  const match = messagePath.exec(url.pathname);
  const selected: QqReadTarget | undefined = url.pathname === "/api/agent/qq/history" ? { kind: "history" }
    : match ? match[2] === undefined ? { kind: "message", messageId: match[1]! }
      : { kind: "attachment", messageId: match[1]!, index: Number(match[2]) } : undefined;
  if (!selected) return false;
  void track(readQqMessageResult(request, url, response, context, selected).then(result => {
    if (response.destroyed || response.writableEnded) return;
    for (const [key, value] of Object.entries(result.headers ?? {})) response.setHeader(key, value);
    if (result.body instanceof Uint8Array) { response.writeHead(result.status); response.end(result.body); }
    else context.json(response, result.status, result.body);
  })).catch(() => { if (!response.destroyed) response.destroy(); });
  return true;
}
