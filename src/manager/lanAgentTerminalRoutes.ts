import type http from "node:http";
import type { LanAgentRegistry } from "./lanAgentRegistry.js";

export function handleLanAgentTerminalApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, context: {
  registry: LanAgentRegistry;
  authorized: () => boolean;
  readBody: (request: http.IncomingMessage) => Promise<Record<string, unknown>>;
  json: (response: http.ServerResponse, status: number, body: unknown) => void;
}): boolean {
  const match = url.pathname.match(/^\/api\/lan-agent\/instances\/([^/]+)\/terminals(?:\/([a-f0-9-]{36})(\/events)?)?$/);
  if (!match) return false;
  if (!context.authorized()) { context.json(response, 401, { code: -1, message: "A verified connection identity is required." }); return true; }
  const instanceId = decodeURIComponent(match[1]!);
  response.setHeader("cache-control", "no-store");
  if (instanceId === context.registry.localInstanceId) { context.json(response, 400, { code: -1, message: "Select a remote computer." }); return true; }
  const assertAuthorized = () => { if (!context.authorized()) throw new Error("Connection identity changed; terminal request stopped."); };
  if (match[2] && !match[3] && request.method === "GET") {
    void context.registry.terminals.read(instanceId, match[2], Number(url.searchParams.get("after") || "0"), Number(url.searchParams.get("waitMs") || "0"))
      .then(data => { assertAuthorized(); context.json(response, 200, { code: 0, data }); })
      .catch(error => context.json(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (match[2] && match[3] && request.method === "GET") {
    try {
      const after = Number(url.searchParams.get("after") || "0");
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid terminal cursor.");
      let ended = false;
      const pending: Array<{ sequence: number; type: string; data?: string; exitCode?: number | null }> = [];
      let streaming = false;
      let paused = false; let queuedBytes = 0; let finishWhenDrained = false;
      const queue: string[] = [];
      const drain = () => {
        if (ended || paused) return;
        try { assertAuthorized(); } catch { ended = true; response.end(); return; }
        while (queue.length) {
          const frame = queue.shift()!; queuedBytes -= Buffer.byteLength(frame);
          if (!response.write(frame)) { paused = true; return; }
        }
        if (finishWhenDrained) { ended = true; response.end(); }
      };
      const send = (event: typeof pending[number]) => {
        if (!streaming) { pending.push(event); return; }
        if (ended) return;
        const frame = `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`;
        queuedBytes += Buffer.byteLength(frame);
        if (queuedBytes > 524288) { ended = true; response.end(); return; }
        queue.push(frame);
        if (["exit", "disconnected"].includes(event.type)) finishWhenDrained = true;
        drain();
      };
      const unsubscribe = context.registry.terminals.subscribe(instanceId, match[2], after, send);
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("x-accel-buffering", "no");
      response.flushHeaders(); streaming = true;
      response.on("drain", () => { paused = false; drain(); });
      response.write(": terminal stream\n\n");
      for (const event of pending) send(event);
      // event-driven-allow: SSE protocol keepalive; never queries business state.
      const keepalive = setInterval(() => {
        try { assertAuthorized(); if (!ended && !paused && !response.write(": keepalive\n\n")) paused = true; } catch { response.end(); }
      }, 25000);
      response.once("close", () => { ended = true; clearInterval(keepalive); unsubscribe(); });
    } catch (error) { context.json(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }); }
    return true;
  }
  if (!match[2] && ["GET", "POST"].includes(request.method || "")) {
    const body = request.method === "GET" ? Promise.resolve({ action: "list" } as Record<string, unknown>) : context.readBody(request);
    void body.then(async input => {
      assertAuthorized();
      if (!["open", "list", "get", "input", "resize", "close"].includes(String(input.action))) throw new Error("Unsupported terminal operation.");
      const result = await context.registry.terminals.execute(instanceId, input);
      assertAuthorized();
      context.json(response, 200, { code: 0, data: result });
    }).catch(error => context.json(response, 400, { code: -1, uncertain: request.method === "POST", message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  context.json(response, 405, { code: -1, message: "Unsupported terminal method." });
  return true;
}
