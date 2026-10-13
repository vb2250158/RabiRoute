import type http from "node:http";
import type { MessageContextRecord, RecentMessageContextQuery } from "../messageContextStore.js";
import { managerReadHttpResponse } from "./managerReadHttpResponse.js";

type Context = {
  roleDirectory: (roleId: string) => string;
  json: (response: http.ServerResponse, status: number, body: unknown) => void;
  queryHistory: (roleDir: string, query: RecentMessageContextQuery, options: { signal: AbortSignal }) => Promise<MessageContextRecord[]>;
};

function numberParam(value: string | null, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Read-only history search; storage work belongs to the bounded interactive reader. */
export function handleMessageEndpointHistoryApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, context: Context): boolean {
  const match = url.pathname.match(/^\/api\/roles\/([^/]+)\/message-endpoint-history$/);
  if (!match) return false;
  if (request.method !== "GET") { context.json(response, 405, { code: -1, message: "GET is required" }); return true; }
  if (url.searchParams.has("cursor") || url.searchParams.has("offset")) {
    context.json(response, 400, { code: -1, errorCode: "MESSAGE_HISTORY_PAGINATION_UNSUPPORTED",
      message: "This endpoint returns a bounded excerpt and does not support cursor or offset pagination.",
      repair: "Use conversation and Unix-second from/to filters for excerpts; verify a complete source before full-history statistics.", retryable: false });
    return true;
  }
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const afterSequence = url.searchParams.get("afterSequence");
  const beforeSequence = url.searchParams.get("beforeSequence");
  if ([afterSequence, beforeSequence].some(value => value !== null && (!value.trim() || !Number.isSafeInteger(Number(value)) || Number(value) < 0))
    || (afterSequence !== null && beforeSequence !== null && Number(afterSequence) > Number(beforeSequence))) {
    context.json(response, 400, { code: -1, message: "afterSequence/beforeSequence must be non-negative safe integers in ascending order." });
    return true;
  }
  if ([from, to].some(value => value !== null && (!value.trim() || !Number.isFinite(Number(value))))
    || (from !== null && to !== null && Number(from) > Number(to))) {
    context.json(response, 400, { code: -1, errorCode: "MESSAGE_HISTORY_TIME_RANGE_INVALID",
      message: "from/to must be finite Unix seconds, with from <= to when both are supplied.",
      repair: "Convert the requested time window to Unix seconds; omit unused bounds instead of supplying empty or formatted dates.", retryable: false });
    return true;
  }
  try {
    const roleId = decodeURIComponent(match[1]);
    const roleDir = context.roleDirectory(roleId);
    const query: RecentMessageContextQuery = {
      limit: Math.min(200, Math.max(1, Math.floor(numberParam(url.searchParams.get("limit"), 50)))),
      maxChars: Math.min(200_000, Math.max(1, Math.floor(numberParam(url.searchParams.get("maxChars"), 200_000)))),
      adapter: url.searchParams.get("adapter") || undefined, channel: url.searchParams.get("channel") || undefined,
      kind: url.searchParams.get("kind") || undefined, sender: url.searchParams.get("sender") || undefined,
      target: url.searchParams.get("target") || undefined, conversationKey: url.searchParams.get("conversationKey") || undefined,
      query: url.searchParams.get("query")?.trim() || undefined,
      queryMatch: url.searchParams.get("match") === "all" ? "all" : "any", includeArchives: url.searchParams.get("includeArchives") === "1",
      from: numberParam(url.searchParams.get("from"), NaN), to: numberParam(url.searchParams.get("to"), NaN),
      afterSequence: afterSequence === null ? undefined : Number(afterSequence),
      beforeSequence: beforeSequence === null ? undefined : Number(beforeSequence)
    };
    void managerReadHttpResponse(request, response, {
      read: signal => context.queryHistory(roleDir, query, { signal }),
      json: context.json,
      respond: data => context.json(response, 200, { code: 0, data: { entries: data, count: data.length, coverage: {
        roleId, includeArchives: query.includeArchives, adapter: query.adapter || null, channel: query.channel || null,
        recordScope: "saved_role_messages", resultMode: "latest_matches", completenessUnknown: true, paginationSupported: false,
        limit: query.limit, maxChars: query.maxChars,
        from: Number.isFinite(query.from) ? query.from : null, to: Number.isFinite(query.to) ? query.to : null,
        afterSequence: query.afterSequence ?? null, beforeSequence: query.beforeSequence ?? null,
        limitReducesArchiveScan: false
      } } })
    });
  } catch (error) {
    if (!response.destroyed) context.json(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
