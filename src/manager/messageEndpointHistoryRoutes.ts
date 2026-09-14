import type http from "node:http";
import { recentMessageContextItems } from "../messageContextStore.js";

type Context = { roleDirectory: (roleId: string) => string; json: (response: http.ServerResponse, status: number, body: unknown) => void };

function numberParam(value: string | null, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Read-only search for historical messages received from message endpoints, including NapCat group/private chats. */
export function handleMessageEndpointHistoryApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, context: Context): boolean {
  const match = url.pathname.match(/^\/api\/roles\/([^/]+)\/message-endpoint-history$/);
  if (!match) return false;
  if (request.method !== "GET") { context.json(response, 405, { code: -1, message: "GET is required" }); return true; }
  try {
    const roleId = decodeURIComponent(match[1]);
    const limit = Math.min(200, Math.max(1, Math.floor(numberParam(url.searchParams.get("limit"), 50))));
    const data = recentMessageContextItems([context.roleDirectory(roleId)], {
      limit, maxChars: Math.min(200_000, Math.max(1, Math.floor(numberParam(url.searchParams.get("maxChars"), 200_000)))),
      adapter: url.searchParams.get("adapter") || undefined, channel: url.searchParams.get("channel") || undefined,
      kind: url.searchParams.get("kind") || undefined, sender: url.searchParams.get("sender") || undefined,
      target: url.searchParams.get("target") || undefined, conversationKey: url.searchParams.get("conversationKey") || undefined,
      query: url.searchParams.get("query")?.trim() || undefined,
      queryMatch: url.searchParams.get("match") === "all" ? "all" : "any", includeArchives: url.searchParams.get("includeArchives") === "1",
      from: numberParam(url.searchParams.get("from"), NaN), to: numberParam(url.searchParams.get("to"), NaN)
    });
    context.json(response, 200, { code: 0, data: { entries: data, count: data.length, coverage: { roleId, includeArchives: url.searchParams.get("includeArchives") === "1", adapter: url.searchParams.get("adapter") || null, channel: url.searchParams.get("channel") || null } } });
  } catch (error) { context.json(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }); }
  return true;
}
