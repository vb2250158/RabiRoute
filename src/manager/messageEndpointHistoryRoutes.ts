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
      from: numberParam(url.searchParams.get("from"), NaN), to: numberParam(url.searchParams.get("to"), NaN)
    };
    void managerReadHttpResponse(request, response, {
      read: signal => context.queryHistory(roleDir, query, { signal }),
      json: context.json,
      respond: data => context.json(response, 200, { code: 0, data: { entries: data, count: data.length, coverage: {
        roleId, includeArchives: query.includeArchives, adapter: query.adapter || null, channel: query.channel || null
      } } })
    });
  } catch (error) {
    if (!response.destroyed) context.json(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
