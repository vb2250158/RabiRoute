import type http from "node:http";
import { readPersonaChatHistory, appendPersonaAiuiExchange } from "../personaChatHistory.js";
import { codexDesktopDeepLinkForTest, readCodexDesktopThreadsByIds } from "../codexDesktopBridge.js";

export function handlePersonaChatHistoryApi(
  request: http.IncomingMessage, url: URL, response: http.ServerResponse,
  roleDir: (roleId: string) => string,
  readTasks = readCodexDesktopThreadsByIds
): boolean {
  const match = url.pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/chat-history(\/aiui)?$/);
  if (!match) return false;
  const send = (status: number, body: unknown) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  if (match[2]) {
    if (request.method !== 'POST') { send(405, { code: -1, errorCode: 'METHOD_NOT_ALLOWED' }); return true; }
    void (async () => {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 131072) throw new Error('AIUI_BODY_LIMIT'); chunks.push(Buffer.from(chunk)); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['sessionId', 'turnId', 'userText', 'assistantText'].includes(key))
        || ![body.sessionId, body.turnId].every(value => typeof value === 'string' && /^[A-Za-z0-9:._-]{1,128}$/.test(value))
        || typeof body.userText !== 'string' || !body.userText.trim() || body.userText.length > 16000
        || (body.assistantText !== undefined && body.assistantText !== null && (typeof body.assistantText !== 'string' || body.assistantText.length > 16000))) throw new Error('AIUI_BODY_INVALID');
      const receipt = await appendPersonaAiuiExchange(roleDir(decodeURIComponent(match[1]!)), body);
      send(200, { code: 0, data: { receipt } });
    })().catch(() => send(400, { code: -1, errorCode: 'AIUI_HISTORY_UNCONFIRMED' }));
    return true;
  }
  if (request.method !== "GET") {
    send(405, { code: -1, message: "Method not allowed." });
    return true;
  }
  void Promise.resolve().then(() => readPersonaChatHistory(
    roleDir(decodeURIComponent(match[1])),
    url.searchParams.has("cursor") ? Number(url.searchParams.get("cursor")) : undefined,
    Number(url.searchParams.get("limit") ?? 50)
  )).then(data => {
    // Missing/unavailable Desktop metadata must not hide recorded replies.
    try {
      const tasks = new Map(readTasks([...new Set(data.entries.flatMap(entry => [...(entry.kind === "user_delivery" || entry.kind?.startsWith('aiui_') ? [] : [entry.sessionId]), ...(entry.targetSessionId ? [entry.targetSessionId] : [])]))]).map(task => [task.id, task]));
      data.entries = data.entries.map(entry => {
        const task = entry.kind === "user_delivery" ? undefined : tasks.get(entry.sessionId);
        const target = entry.targetSessionId ? tasks.get(entry.targetSessionId) : undefined;
        return {
          ...entry,
          ...(task ? { sessionTitle: task.title || entry.sessionTitle, taskUrl: codexDesktopDeepLinkForTest(task.id) } : {}),
          ...(target ? { targetSessionTitle: target.title || entry.targetSessionTitle, targetTaskUrl: codexDesktopDeepLinkForTest(target.id) } : {})
        };
      });
    } catch { /* The original task ID remains available when Desktop cannot be read. */ }
    send(200, { code: 0, data });
  })
    .catch(error => send(400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
  return true;
}
